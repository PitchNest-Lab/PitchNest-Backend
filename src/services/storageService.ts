import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import { config } from "../config/env.ts";

// Set uploads directory based on environment (local vs GAE/GCF /tmp)
export const uploadDir = config.isGoogleCloud 
  ? '/tmp/uploads' 
  : path.join(process.cwd(), 'uploads');

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * Make a client-supplied filename safe to embed in a storage object key OR a
 * local filesystem path.
 *
 * WHY: `req.file.originalname` is fully attacker-controlled. Both upload
 * controllers build `path.join(uploadDir, `${Date.now()}_${originalname}`)` on
 * the Supabase-failure fallback, so a name like `../../../../etc/cron.d/x`
 * escaped the uploads directory and wrote attacker bytes to an arbitrary path.
 * This strips ALL directory components (basename, after normalising Windows
 * back-slashes) and restricts to a conservative charset, so the result can
 * never contain `/`, `\`, or `..` and cannot traverse out of its prefix.
 */
export function sanitizeUploadName(original: string | undefined | null): string {
  const base = path.basename(String(original ?? "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, "_") // keep only safe path characters
    .replace(/^\.+/, "") // no leading dots — kills ".." and hidden files
    .slice(0, 100);
  return cleaned || "file";
}

// Configured multer instance with 500MB size limit (perfect for long webm uploads)
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

/**
 * Per-kind upload guards.
 *
 * WHY THESE EXIST. The shared `upload` above accepts ANY file type up to 500 MB
 * into memoryStorage — so a few concurrent max-size uploads exhaust the Node
 * heap on a single instance, and nothing stops a caller putting an executable
 * where a PDF is expected. These narrow the door per route.
 *
 * The MIME type is client-supplied and therefore a hint, not proof. It is
 * checked because it is cheap and rejects honest mistakes; the real protections
 * are the size cap and the fact that objects live in a private bucket served
 * via signed URLs rather than being executed.
 */
function makeUpload(allowed: readonly string[], maxBytes: number, label: string) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (allowed.includes(file.mimetype)) return cb(null, true);
      cb(new Error(`UNSUPPORTED_FILE_TYPE:${label}:${file.mimetype}`));
    },
  });
}

/**
 * Pitch decks: PDF and plain text. 25 MB is generous for a slide deck.
 *
 * `application/octet-stream` (and an empty type) are also admitted AT THIS
 * GATE ONLY, because a Windows machine with a broken file association sends a
 * perfectly good PDF with no MIME type at all — and multer rejects before the
 * controller ever sees the bytes. The controller then sniffs the buffer's
 * magic bytes and returns 415 itself for anything that is not genuinely a PDF
 * or text, so this does not widen what can be stored.
 */
export const deckUpload = makeUpload(
  [
    "application/pdf",
    "text/plain",
    "text/markdown",
    "application/octet-stream",
    "",
  ],
  25 * 1024 * 1024,
  "deck",
);

/** Avatars: raster images only, 5 MB — matches the existing client-side check. */
export const avatarUpload = makeUpload(
  ["image/png", "image/jpeg", "image/webp", "image/gif"],
  5 * 1024 * 1024,
  "avatar",
);

/**
 * Session recordings — AUDIO only in practice.
 *
 * The recorder calls getUserMedia with video: false, so what arrives here is an
 * audio track in a WebM/MP4 container. The video/* types stay in the allow-list
 * because a browser may label an audio-only MediaRecorder blob "video/webm"
 * depending on the mimeType the recorder negotiated, and rejecting that would
 * silently lose the founder's recording (and with it, replay).
 */
export const videoUpload = makeUpload(
  ["video/webm", "video/mp4", "audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4"],
  150 * 1024 * 1024,
  "recording",
);

// ── Signed local-file delivery (S7) ─────────────────────────────────────────
// Local-fallback files (written to disk when Supabase Storage errors) used to
// be served by an UNPROTECTED `express.static('/uploads')` mount — anyone who
// learned or guessed a filename could read a deck or video with no auth. That
// mount is gone; local files are now delivered only through a token-gated
// route (GET /api/files/:name?token=...) that mirrors the Supabase signed-URL
// model: the deck's owner fetches a short-lived token (minted by the already-
// authenticated getDeckSignedUrl), and the browser loads the file with the
// token in the query string — iframe/`window.open` can't send Authorization
// headers, so a capability token is the only way to render a private file.

/** Tokens live 5 minutes — long enough to load a pitch, short enough to be
 * worthless if leaked into a log or browser history. Same TTL as Supabase
 * signed URLs (SIGNED_URL_TTL_SECONDS). */
const LOCAL_FILE_TOKEN_TTL_SECONDS = 300;

/**
 * Mints a relative URL for a local-fallback file, signed with the app's JWT
 * secret. Ownership is enforced by the CALLER (getDeckSignedUrl already ran
 * authMiddleware and matched the deck row to req.user.id before calling this),
 * then re-verified from the DB at serve time by the file route.
 *
 * @param name    the sanitized filename as stored under /uploads/...
 * @param userId  the owner whose decks may fetch this file
 * @param ttlSeconds  override the default lifetime. Audio replay needs a longer
 *   window than a deck load: an <audio> element re-requests byte ranges while
 *   the founder listens and seeks, so a 5-minute token would start failing
 *   part-way through a 30-minute pitch.
 */
export function signLocalFileUrl(
  name: string,
  userId: number,
  ttlSeconds: number = LOCAL_FILE_TOKEN_TTL_SECONDS,
): string {
  const token = jwt.sign(
    { file: name, uid: userId },
    config.jwtSecret,
    { expiresIn: ttlSeconds },
  );
  return `/api/files/${encodeURIComponent(name)}?token=${token}`;
}

/**
 * Verifies a local-file token against the requested filename. Returns the
 * owner's uid, or null when the token is missing/expired/tampered or was
 * minted for a different file (a token must never be reusable across files).
 */
export function verifyLocalFileToken(
  token: unknown,
  name: string,
): number | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as {
      file?: unknown;
      uid?: unknown;
    };
    if (
      typeof payload.file !== "string" ||
      payload.file !== name ||
      typeof payload.uid !== "number"
    ) {
      return null;
    }
    return payload.uid;
  } catch {
    return null;
  }
}
