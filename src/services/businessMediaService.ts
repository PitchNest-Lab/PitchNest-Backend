import crypto from "node:crypto";
import sharp from "sharp";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { safeAvatarUrl } from "../utils/storagePath.ts";

/**
 * Business logos and cover images, and the public team list.
 *
 * LIFECYCLE. An upload is decoded, oriented, resized and re-encoded as WebP
 * here; re-encoding drops every byte of metadata, including the GPS position
 * phones write into photos. The result is stored in the PRIVATE media bucket
 * and shown back to members through short-lived signed URLs. Only publishing
 * copies the approved files to the public bucket; unpublishing, archiving and
 * a moderation hide remove them. So a draft image is never publicly reachable,
 * and a withdrawn one stops being reachable.
 *
 * File names are content hashes (logo-<hash>.webp), so a changed image is a new
 * URL and public copies can be cached for a year.
 */

export const BUSINESS_MEDIA_KINDS = ["logo", "cover"] as const;
export type BusinessMediaKind = (typeof BUSINESS_MEDIA_KINDS)[number];

interface MediaSpec {
  label: string;
  maxInputBytes: number;
  minWidth: number;
  minHeight: number;
  width: number;
  height: number;
  fit: "inside" | "cover";
}

export const MEDIA_SPECS: Record<BusinessMediaKind, MediaSpec> = {
  // Logos keep their shape (wordmarks are wide) and are shown on a tile.
  logo: { label: "Logo", maxInputBytes: 2 * 1024 * 1024, minWidth: 64, minHeight: 64, width: 512, height: 512, fit: "inside" },
  // Covers are cropped to a banner.
  cover: { label: "Cover image", maxInputBytes: 6 * 1024 * 1024, minWidth: 600, minHeight: 200, width: 1600, height: 600, fit: "cover" },
};

/** The multer ceiling: the largest per-kind limit. */
export const MEDIA_UPLOAD_MAX_BYTES = Math.max(...Object.values(MEDIA_SPECS).map((s) => s.maxInputBytes));

const FILE_PATTERNS: Record<BusinessMediaKind, RegExp> = {
  logo: /^logo-[a-f0-9]{32}\.webp$/,
  cover: /^cover-[a-f0-9]{32}\.webp$/,
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMediaKind(value: unknown): value is BusinessMediaKind {
  return typeof value === "string" && (BUSINESS_MEDIA_KINDS as readonly string[]).includes(value);
}

export function isMediaFile(kind: BusinessMediaKind, value: unknown): value is string {
  return typeof value === "string" && FILE_PATTERNS[kind].test(value);
}

export function mediaObjectPath(businessId: string, file: string): string {
  return `business-media/${businessId}/${file}`;
}

export class MediaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MediaError";
    this.status = status;
  }
}

/** Real image bytes; the declared MIME type is only a hint. */
export function sniffImageType(buffer: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "gif";
  return null;
}

/**
 * Decodes, orients and resizes an image, and re-encodes it as WebP with no
 * metadata. Throws MediaError (with an HTTP status) for anything unusable.
 */
export async function reencodeImage(
  input: Buffer,
  target: {
    width: number;
    height: number;
    fit: "inside" | "cover";
    minWidth?: number;
    minHeight?: number;
    /** Avatars accept GIF (first frame only); business images do not. */
    allowGif?: boolean;
  },
): Promise<Buffer> {
  const type = sniffImageType(input);
  if (!type || (type === "gif" && !target.allowGif)) {
    throw new MediaError(target.allowGif ? "File must be a supported image." : "Use a PNG, JPEG or WebP image.", 415);
  }
  const meta = await sharp(input, { failOn: "error", limitInputPixels: 50_000_000 })
    .metadata()
    .catch(() => {
      throw new MediaError("That image could not be read. Try another file.", 415);
    });
  // EXIF orientations 5–8 swap width and height on display.
  const swapped = (meta.orientation ?? 1) >= 5;
  const width = (swapped ? meta.height : meta.width) ?? 0;
  const height = (swapped ? meta.width : meta.height) ?? 0;
  if (width < (target.minWidth ?? 1) || height < (target.minHeight ?? 1)) {
    throw new MediaError(
      `Image is too small (at least ${target.minWidth} × ${target.minHeight} pixels).`,
      422,
    );
  }
  try {
    return await sharp(input, { failOn: "error", limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: target.width, height: target.height, fit: target.fit, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new MediaError("That image could not be processed. Try another file.", 415);
  }
}

/** A processed business image and its content-hashed file name. */
export async function processBusinessImage(
  kind: BusinessMediaKind,
  input: Buffer,
): Promise<{ file: string; buffer: Buffer }> {
  const spec = MEDIA_SPECS[kind];
  if (input.length > spec.maxInputBytes) {
    throw new MediaError(`${spec.label} is too large (max ${spec.maxInputBytes / (1024 * 1024)} MB).`, 413);
  }
  const buffer = await reencodeImage(input, spec);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  return { file: `${kind}-${hash}.webp`, buffer };
}

// ── Storage ─────────────────────────────────────────────────────────────────

export async function storeDraftMedia(businessId: string, file: string, buffer: Buffer): Promise<void> {
  const { error } = await supabase.storage
    .from(config.storageBucket)
    .upload(mediaObjectPath(businessId, file), buffer, {
      contentType: "image/webp",
      upsert: true,
      duplex: "half",
    });
  if (error) throw error;
}

/** Best effort: a leftover private draft is harmless. */
export async function deleteDraftMedia(businessId: string, file: string | null | undefined): Promise<void> {
  if (!file) return;
  const { error } = await supabase.storage
    .from(config.storageBucket)
    .remove([mediaObjectPath(businessId, file)]);
  if (error) console.warn("Draft business image cleanup failed:", error.message);
}

/** Signed URLs (one hour) for members to see their drafts, keyed by object path. */
export async function signDraftMedia(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const { data, error } = await supabase.storage.from(config.storageBucket).createSignedUrls(unique, 3600);
  if (error) {
    console.warn("Signing business images failed:", error.message);
    return out;
  }
  for (const entry of data ?? []) {
    if (entry.path && entry.signedUrl && !entry.error) out.set(entry.path, entry.signedUrl);
  }
  return out;
}

/** Public URL of a published image, or null for anything that is not one. */
export function publicMediaUrl(kind: BusinessMediaKind, businessId: unknown, file: unknown): string | null {
  if (typeof businessId !== "string" || !UUID_PATTERN.test(businessId) || !isMediaFile(kind, file)) return null;
  const { data } = supabase.storage.from(config.publicMediaBucket).getPublicUrl(mediaObjectPath(businessId, file));
  return data?.publicUrl || null;
}

async function listPublicObjects(businessId: string): Promise<string[]> {
  const prefix = `business-media/${businessId}`;
  const paths: string[] = [];
  for (let offset = 0; offset < 10_000; offset += 100) {
    const { data, error } = await supabase.storage
      .from(config.publicMediaBucket)
      .list(prefix, { limit: 100, offset });
    if (error) throw error;
    const page = (data ?? [])
      .filter((entry) => entry.name)
      .map((entry) => `${prefix}/${entry.name}`);
    paths.push(...page);
    if ((data ?? []).length < 100) return paths;
  }
  throw new Error("Too many public media objects to clean safely");
}

/**
 * Makes exactly `files` public for a business: copies each from the private
 * draft, then removes any other public object for that business. Returns false
 * when something failed, so the caller can tell the founder to retry.
 */
export async function publishMedia(businessId: string, files: Array<string | null | undefined>): Promise<boolean> {
  const keep = files.filter((f): f is string => typeof f === "string" && f.length > 0);
  let ok = true;
  for (const file of keep) {
    const path = mediaObjectPath(businessId, file);
    try {
      const { data: blob, error: downloadError } = await supabase.storage.from(config.storageBucket).download(path);
      if (downloadError || !blob) throw downloadError ?? new Error("missing draft");
      const { error: uploadError } = await supabase.storage
        .from(config.publicMediaBucket)
        .upload(path, Buffer.from(await blob.arrayBuffer()), {
          contentType: "image/webp",
          cacheControl: "31536000",
          upsert: true,
          duplex: "half",
        });
      if (uploadError) throw uploadError;
    } catch (error: any) {
      ok = false;
      console.error(`Publishing business image ${path} failed:`, error?.message || error);
    }
  }
  try {
    const keepPaths = new Set(keep.map((file) => mediaObjectPath(businessId, file)));
    const stale = (await listPublicObjects(businessId)).filter((path) => !keepPaths.has(path));
    if (stale.length) {
      const { error } = await supabase.storage.from(config.publicMediaBucket).remove(stale);
      if (error) throw error;
    }
  } catch (error: any) {
    ok = false;
    console.error("Removing superseded public business images failed:", error?.message || error);
  }
  return ok;
}

/** Removes every public image of a business. False means takedown is incomplete. */
export async function removePublicMedia(businessId: string): Promise<boolean> {
  try {
    const paths = await listPublicObjects(businessId);
    if (paths.length) {
      const { error } = await supabase.storage.from(config.publicMediaBucket).remove(paths);
      if (error) throw error;
    }
    return true;
  } catch (error: any) {
    console.error(`Removing public images for business ${businessId} failed:`, error?.message || error);
    return false;
  }
}

// ── Public team ─────────────────────────────────────────────────────────────

export interface PublicTeamMember {
  name: string;
  title: string;
  avatarUrl: string | null;
  /** Their founder page (/founders/<handle>), when they have one. */
  handle: string | null;
}

export const PUBLIC_TITLE_MAX = 80;
const MAX_PUBLIC_TEAM = 12;
const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, editor: 2, viewer: 3 };

/** Shapes consenting member rows into the public team list (allowlisted). */
export function toPublicTeam(
  memberships: Array<{ user_id: number; role: string; public_title?: string | null; joined_at?: string | null }>,
  users: Array<{ id: number; name?: string | null; avatar_url?: string | null }>,
  handles: Map<number, string> = new Map(),
): PublicTeamMember[] {
  const usersById = new Map(users.map((user) => [user.id, user]));
  return [...memberships]
    .sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) ||
        String(a.joined_at ?? "").localeCompare(String(b.joined_at ?? "")),
    )
    .flatMap((membership) => {
      const user = usersById.get(membership.user_id);
      const name = typeof user?.name === "string" ? user.name.trim().slice(0, 80) : "";
      if (!name) return [];
      return [{
        name,
        title: typeof membership.public_title === "string" ? membership.public_title.trim().slice(0, PUBLIC_TITLE_MAX) : "",
        avatarUrl: safeAvatarUrl(user?.avatar_url),
        handle: handles.get(membership.user_id) ?? null,
      }];
    })
    .slice(0, MAX_PUBLIC_TEAM);
}

/**
 * Members who chose to appear publicly. Read live, so withdrawing consent takes
 * effect on the next request. Callers must only use this for a business that
 * is published. Never throws.
 */
export async function loadPublicTeam(businessId: unknown): Promise<PublicTeamMember[]> {
  if (typeof businessId !== "string" || !UUID_PATTERN.test(businessId)) return [];
  try {
    const { data: memberships, error } = await supabase
      .from("business_members")
      .select("user_id, role, public_title, joined_at")
      .eq("business_id", businessId)
      .eq("status", "active")
      .eq("public_display_consent", true)
      .limit(MAX_PUBLIC_TEAM);
    if (error || !memberships?.length) return [];
    const userIds = memberships.map((m: any) => m.user_id);
    const [{ data: users, error: userError }, { data: handleRows }] = await Promise.all([
      supabase.from("users").select("id, name, avatar_url").in("id", userIds),
      supabase.from("founder_handles").select("user_id, handle").in("user_id", userIds),
    ]);
    if (userError) return [];
    const handles = new Map((handleRows ?? []).map((row: any) => [row.user_id, row.handle]));
    return toPublicTeam(memberships as any[], (users ?? []) as any[], handles);
  } catch {
    return [];
  }
}
