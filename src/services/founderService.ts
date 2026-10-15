import crypto from "node:crypto";
import { supabase } from "../config/supabase.ts";
import { toPublicBusinessSummary, type PublicBusinessSummary } from "../controllers/publicBusinessController.ts";

/**
 * Public founder pages and founder follows (migration 0029).
 *
 * VISIBILITY. A founder is public only while they personally consent to appear
 * on at least one published business. Their page lists exactly those
 * businesses, from each business's approved publication snapshot. Nothing else
 * about the person is shown: no bio, email, other businesses or practice data.
 *
 * Handles are assigned the first time a member consents, and are stable after
 * that, so a shared link keeps working if the founder changes their name.
 */

export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyHandle(name: unknown): string {
  const base = (typeof name === "string" ? name : "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `founder${base ? `-${base}` : ""}`;
}

export function normalizeHandle(value: unknown): string | null {
  const handle = typeof value === "string" ? value.trim().toLowerCase() : "";
  return handle.length >= 3 && handle.length <= 60 && HANDLE_PATTERN.test(handle) ? handle : null;
}

/** The founder's handle, created on first use. Never throws; null on failure. */
export async function ensureFounderHandle(userId: number, name: unknown): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from("founder_handles")
      .select("handle")
      .eq("user_id", userId)
      .maybeSingle();
    if ((existing as any)?.handle) return (existing as any).handle;

    const base = slugifyHandle(name);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const handle = `${base}-${crypto.randomBytes(2).toString("hex")}`;
      const { error } = await supabase.from("founder_handles").insert({ user_id: userId, handle });
      if (!error) return handle;
      if (error.code !== "23505") throw error;
      // 23505: the handle (or this user's row) already exists; re-read in case
      // a concurrent request created this user's handle.
      const { data: raced } = await supabase
        .from("founder_handles")
        .select("handle")
        .eq("user_id", userId)
        .maybeSingle();
      if ((raced as any)?.handle) return (raced as any).handle;
    }
    return null;
  } catch (error: any) {
    console.error("Founder handle allocation failed:", error?.message || error);
    return null;
  }
}

/** Handles for a set of users (only those who have one). */
export async function handlesForUsers(userIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.from("founder_handles").select("user_id, handle").in("user_id", ids);
  if (error) return new Map();
  return new Map((data ?? []).map((row: any) => [row.user_id, row.handle]));
}

export interface PublicFounderBusiness extends PublicBusinessSummary {
  /** The founder's own title on this business, if they set one. */
  title: string;
}

export interface PublicFounder {
  handle: string;
  name: string;
  avatarUrl: string | null;
  businesses: PublicFounderBusiness[];
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Resolves a handle to the founder's id and their public page, or null when not public. */
export async function loadPublicFounder(
  handleValue: unknown,
): Promise<{ founderId: number; founder: PublicFounder } | null> {
  const handle = normalizeHandle(handleValue);
  if (!handle) return null;

  const { data: handleRow, error: handleError } = await supabase
    .from("founder_handles")
    .select("user_id, handle")
    .eq("handle", handle)
    .maybeSingle();
  if (handleError) throw handleError;
  const founderId = (handleRow as any)?.user_id;
  if (!Number.isInteger(founderId)) return null;

  const { data: memberships, error: membershipError } = await supabase
    .from("business_members")
    .select("business_id, public_title")
    .eq("user_id", founderId)
    .eq("status", "active")
    .eq("public_display_consent", true);
  if (membershipError) throw membershipError;
  const titles = new Map((memberships ?? []).map((row: any) => [row.business_id, row.public_title ?? ""]));
  const businessIds = [...titles.keys()];
  if (businessIds.length === 0) return null;

  const [{ data: businesses, error: businessError }, { data: publications, error: publicationError }] =
    await Promise.all([
      supabase.from("businesses").select("id, slug, status").in("id", businessIds).eq("status", "published"),
      supabase
        .from("business_publications")
        .select("business_id, approved_at, public_snapshot")
        .in("business_id", businessIds)
        .eq("status", "active"),
    ]);
  if (businessError) throw businessError;
  if (publicationError) throw publicationError;

  const liveSlugs = new Map((businesses ?? []).map((row: any) => [row.id, row.slug]));
  const publicBusinesses: PublicFounderBusiness[] = (publications ?? [])
    .filter((row: any) => liveSlugs.has(row.business_id) && liveSlugs.get(row.business_id) === row.public_snapshot?.slug)
    .sort((a: any, b: any) => String(b.approved_at).localeCompare(String(a.approved_at)))
    .map((row: any) => ({
      ...toPublicBusinessSummary(row.public_snapshot, row.approved_at),
      title: String(titles.get(row.business_id) ?? "").trim().slice(0, 80),
    }))
    .filter((business) => business.slug && business.name);
  if (publicBusinesses.length === 0) return null;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("name, avatar_url")
    .eq("id", founderId)
    .maybeSingle();
  if (userError) throw userError;
  const name = typeof (user as any)?.name === "string" ? (user as any).name.trim().slice(0, 80) : "";
  if (!name) return null;

  return {
    founderId,
    founder: {
      handle,
      name,
      avatarUrl: safeHttpUrl((user as any)?.avatar_url),
      businesses: publicBusinesses,
    },
  };
}

export async function isFollowingFounder(founderId: number, followerId: number): Promise<boolean> {
  const { data } = await supabase
    .from("founder_follows")
    .select("founder_id")
    .eq("founder_id", founderId)
    .eq("follower_id", followerId)
    .maybeSingle();
  return Boolean(data);
}

export async function countFounderFollowers(founderId: number): Promise<number> {
  const { count } = await supabase
    .from("founder_follows")
    .select("follower_id", { count: "exact", head: true })
    .eq("founder_id", founderId);
  return typeof count === "number" ? count : 0;
}

/** Idempotent follow or unfollow. */
export async function setFounderFollow(founderId: number, followerId: number, active: boolean): Promise<void> {
  if (active) {
    const { error } = await supabase
      .from("founder_follows")
      .upsert({ founder_id: founderId, follower_id: followerId }, { onConflict: "founder_id,follower_id", ignoreDuplicates: true });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("founder_follows")
      .delete()
      .eq("founder_id", founderId)
      .eq("follower_id", followerId);
    if (error) throw error;
  }
}
