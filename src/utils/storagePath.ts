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
