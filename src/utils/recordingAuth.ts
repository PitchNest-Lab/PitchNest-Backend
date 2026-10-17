import { supabase } from "../config/supabase.ts";
import { storagePathFromUrl } from "./storagePath.ts";

/**
 * Recording (session audio) ownership: the one rule every reader and deleter
 * applies to a stored sessions.video_url.
 *
 * sessions.video_url used to be whatever the client sent in `set_video_url`,
 * and that value was later signed against the private media bucket, served
 * from local storage and deleted on account purge. The WebSocket now accepts
 * only the caller's own keys (isOwnRecordingReference), but rows written
 * before that check may still point at someone else's object.
 *
 * Ownership is encoded in the key, which only the server chooses:
 *   - storage:        pitches/<userId>/<timestamp>_<name>
 *   - local fallback: /uploads/rec_<userId>_<timestamp>_<name>
 * Legacy keys (no user segment) stay usable by their owner only while no OTHER
 * user's row references the same object, so a poisoned row cannot reach a
 * victim's file. Anything outside the recording prefixes is never authorised.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_STORED_LENGTH = 400;

function isSafeSegment(s: string): boolean {
  return SAFE_SEGMENT.test(s) && !s.startsWith(".") && !s.includes("..");
}

type Classified =
  | { kind: "owned_storage"; path: string; ownerId: number }
  | { kind: "owned_local"; stored: string; ownerId: number }
  | { kind: "legacy_storage"; path: string }
  | { kind: "legacy_local"; stored: string }
  | { kind: "invalid" };

function classify(value: unknown): Classified {
  if (typeof value !== "string") return { kind: "invalid" };
  const stored = value.trim();
  if (!stored || stored.length > MAX_STORED_LENGTH) return { kind: "invalid" };

  if (stored.startsWith("/uploads/")) {
    const name = stored.slice("/uploads/".length);
    if (!isSafeSegment(name)) return { kind: "invalid" };
    const m = /^rec_(\d+)_/.exec(name);
    if (m) return { kind: "owned_local", stored, ownerId: Number(m[1]) };
    return { kind: "legacy_local", stored };
  }

  // Bare key, or a legacy full public/signed URL of the media bucket.
  const path = storagePathFromUrl(stored);
  if (!path) return { kind: "invalid" };
  const parts = path.split("/");
  if (parts[0] !== "pitches") return { kind: "invalid" };

  if (parts.length === 3 && /^\d+$/.test(parts[1]) && isSafeSegment(parts[2])) {
    return { kind: "owned_storage", path, ownerId: Number(parts[1]) };
  }
  if (parts.length === 2 && isSafeSegment(parts[1])) {
    return { kind: "legacy_storage", path };
  }
  return { kind: "invalid" };
}

export type RecordingTarget =
  | { kind: "storage"; path: string }
  | { kind: "local"; name: string };

/**
 * Resolves a stored video_url to the object `userId` may read or delete, or
 * null when it is not an authorised recording for that user.
 */
export async function authorizedRecordingTarget(
  stored: unknown,
  userId: number,
): Promise<RecordingTarget | null> {
  const c = classify(stored);
  switch (c.kind) {
    case "owned_storage":
      return c.ownerId === userId ? { kind: "storage", path: c.path } : null;
    case "owned_local":
      return c.ownerId === userId
        ? { kind: "local", name: c.stored.slice("/uploads/".length) }
        : null;
    case "legacy_storage":
      return (await referencedByAnotherUser(stored as string, c.path, userId))
        ? null
        : { kind: "storage", path: c.path };
    case "legacy_local":
      return (await referencedByAnotherUser(c.stored, null, userId))
        ? null
        : { kind: "local", name: c.stored.slice("/uploads/".length) };
    default:
      return null;
  }
}

/**
 * True when any row owned by someone other than `userId` points at this object
 * (as a recording or a deck). Fails CLOSED: a query error counts as "yes".
 */
async function referencedByAnotherUser(
  stored: string,
  objectPath: string | null,
  userId: number,
): Promise<boolean> {
  const candidates = Array.from(
    new Set([stored.trim(), ...(objectPath ? [objectPath] : [])]),
  );
  try {
    for (const value of candidates) {
      for (const [table, column] of [
        ["sessions", "video_url"],
        ["decks", "file_url"],
      ] as const) {
        const { data, error } = await supabase
          .from(table)
          .select("id")
          .eq(column, value)
          .neq("user_id", userId)
          .limit(1);
        if (error) return true;
        if (Array.isArray(data) && data.length > 0) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}
