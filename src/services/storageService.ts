import multer from "multer";
import path from "path";
import fs from "fs";
import { config } from "../config/env.ts";

// Set uploads directory based on environment (local vs GAE/GCF /tmp)
export const uploadDir = config.isGoogleCloud 
  ? '/tmp/uploads' 
  : path.join(process.cwd(), 'uploads');

// Ensure directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
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

/** Pitch decks: PDF and plain text. 25 MB is generous for a slide deck. */
export const deckUpload = makeUpload(
  ["application/pdf", "text/plain", "text/markdown"],
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
 * Session recordings. Still large by necessity, but capped well below 500 MB and
 * restricted to the container types the recorder actually produces.
 */
export const videoUpload = makeUpload(
  ["video/webm", "video/mp4", "audio/webm", "audio/mpeg", "audio/mp4"],
  150 * 1024 * 1024,
  "video",
);
