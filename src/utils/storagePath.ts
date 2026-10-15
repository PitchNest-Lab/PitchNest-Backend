import { config } from "../config/env.ts";

/**
 * Derive a Supabase Storage object path from a stored value, tolerant of both
 * historical full public URLs and bare object paths.
 *
 * Two eras of stored values must both work (Item A privacy migration):
 *  - Legacy rows: a full public URL like
 *    "https://<proj>.supabase.co/storage/v1/object/public/pitchnest-media/decks/123_x.pdf"
 *    → extract everything after "/<bucket>/".
 *  - New / already-bare values: "decks/123_x.pdf" → returned as-is.
 *
 * Local-fallback values ("/uploads/....") and empty values return null — they
 * are not Supabase Storage objects, so callers must handle them separately
 * (serve directly, skip storage cleanup, etc.).
 *
 * @param value  the stored file_url / video_url / avatar_url
 * @param bucket the bucket whose "/<bucket>/" marker to look for in a full URL.
 *               Defaults to the main media bucket. Avatars live in a different
 *               (public) bucket, so pass config.avatarBucket for avatar URLs.
 */
export function storagePathFromUrl(
  value: string | null | undefined,
  bucket: string = config.storageBucket,
): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Local fallback file (not a storage object).
  if (trimmed.startsWith("/uploads/")) return null;

  const marker = `/${bucket}/`;
  const idx = trimmed.indexOf(marker);
  if (idx !== -1) {
    // Full public (or signed) URL — take the object path, drop any query token.
    return trimmed.slice(idx + marker.length).split("?")[0] || null;
  }

  // Any other absolute URL we don't recognize is not our storage object.
  if (/^https?:\/\//i.test(trimmed)) return null;

  // Otherwise treat it as an already-bare object path (e.g. "decks/123_x.pdf").
  return trimmed.split("?")[0] || null;
}

/** Storage key for a new session recording, scoped to its owner. */
export function recordingObjectPath(userId: number, safeName: string): string {
  return `pitches/${userId}/${Date.now()}_${safeName}`;
}

/** Local-fallback file name for a new session recording, scoped to its owner. */
export function recordingLocalName(userId: number, safeName: string): string {
  return `rec_${userId}_${Date.now()}_${safeName}`;
}

// Matches sanitizeUploadName output: no slashes, so no path traversal; ".."
// is additionally refused below.
const SAFE_NAME = "[A-Za-z0-9._-]{1,200}";

/**
 * True only for a recording reference this user's own upload could have
 * produced: "pitches/<userId>/<ts>_<name>" in storage, or
 * "/uploads/rec_<userId>_<ts>_<name>" on local fallback.
 *
 * The WebSocket's set_video_url message is client input. Without this check a
 * founder could point their own session at another user's deck or recording
 * ("decks/…", "/uploads/<someone else's file>") and have the recording
 * endpoint sign it for them with the service role.
 */
export function isOwnRecordingReference(value: unknown, userId: number): boolean {
  if (typeof value !== "string" || !Number.isInteger(userId) || userId <= 0) return false;
  const storage = new RegExp(`^pitches/${userId}/\\d{10,16}_${SAFE_NAME}$`);
  const local = new RegExp(`^/uploads/rec_${userId}_\\d{10,16}_${SAFE_NAME}$`);
  return (storage.test(value) || local.test(value)) && !value.includes("..");
}

/**
 * True for any value the recording endpoint may sign: a recording object path
 * ("pitches/…", including legacy unscoped keys). Never a deck or avatar path.
 */
export function isRecordingObjectPath(objectPath: string | null): boolean {
  return typeof objectPath === "string" && objectPath.startsWith("pitches/") && !objectPath.includes("..");
}
