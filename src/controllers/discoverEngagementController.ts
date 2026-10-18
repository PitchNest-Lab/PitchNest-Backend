import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { safeAvatarUrl } from "../utils/storagePath.ts";
import { cleanPublicText, stripInvisible, validatePublicText } from "../utils/publicText.ts";
import { logEvent } from "../services/eventService.ts";

/**
 * Discover engagement: supports, follows, comments and content reports on
 * PUBLISHED businesses only. Every target is resolved inside the database by
 * resolve_public_business_id() (migration 0021), so drafts and hidden or
 * unpublished businesses cannot be engaged with even by a hand-built request.
 *
 * Public serializers here never emit user ids, emails or reporter identities.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const COMMENT_MIN_LENGTH = 2;
export const COMMENT_MAX_LENGTH = 1000;
export const COMMENT_MAX_LINKS = 2;
const COMMENT_PAGE_SIZE = 20;

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "misleading",
  "inappropriate",
  "intellectual_property",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
const REPORT_DETAILS_MAX = 1000;

export { stripInvisible };
const cleanText = cleanPublicText;

export function normalizeCommentBody(raw: unknown): { body: string; error?: string } {
  const { text, error } = validatePublicText(raw, {
    min: COMMENT_MIN_LENGTH,
    max: COMMENT_MAX_LENGTH,
    maxLinks: COMMENT_MAX_LINKS,
    noun: "comment",
  });
  return error ? { body: text, error } : { body: text };
}

export function normalizeReportDetails(raw: unknown): { details: string | null; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { details: null };
  if (typeof raw !== "string") return { details: null, error: "Details must be text." };
  const details = cleanText(raw);
  if (details.length > REPORT_DETAILS_MAX) {
    return { details: null, error: `Details can be up to ${REPORT_DETAILS_MAX} characters.` };
  }
  return { details: details || null };
}

export function normalizeSlug(value: unknown): string | null {
  const slug = typeof value === "string" ? value.trim().toLowerCase().slice(0, 80) : "";
  return SLUG_PATTERN.test(slug) ? slug : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export interface PublicEngagement {
  supportCount: number;
  followerCount: number;
  commentCount: number;
  viewer: { supports: boolean; follows: boolean; isMember: boolean } | null;
}

export function toPublicEngagement(row: any, authenticated: boolean): PublicEngagement {
  return {
    supportCount: count(row?.support_count),
    followerCount: count(row?.follower_count),
    commentCount: count(row?.comment_count),
    viewer: authenticated
      ? {
          supports: row?.viewer_supports === true,
          follows: row?.viewer_follows === true,
          isMember: row?.viewer_is_member === true,
        }
      : null,
  };
}

export const COMMENT_CATEGORIES = ["clarity", "customer", "evidence", "go_to_market", "question"] as const;
export type CommentCategory = (typeof COMMENT_CATEGORIES)[number];

export interface PublicComment {
  id: string;
  body: string;
  createdAt: string;
  author: { name: string; avatarUrl: string | null; isBusinessMember: boolean };
  viewerCanRemove: boolean;
  /** Structured pitch feedback category (migration 0026), or null. */
  category: CommentCategory | null;
  /** True when the comment is feedback on the business's public pitch. */
  onPitch: boolean;
}

/** Author user ids are used only to compute viewer flags and never emitted. */
export function toPublicComment(
  row: any,
  viewer: { userId: number | null; canModerate: boolean },
): PublicComment {
  const name = typeof row?.author_name === "string" ? row.author_name.trim().slice(0, 80) : "";
  const isOwn = viewer.userId !== null && row?.author_id === viewer.userId;
  const created = new Date(row?.created_at);
  return {
    id: String(row?.comment_id ?? row?.id ?? ""),
    body: typeof row?.body === "string" ? row.body : "",
    createdAt: Number.isNaN(created.getTime()) ? "" : created.toISOString(),
    author: {
      name: name || "PitchNest member",
      avatarUrl: safeAvatarUrl(row?.author_avatar_url),
      isBusinessMember: row?.author_is_member === true,
    },
    viewerCanRemove: isOwn || viewer.canModerate,
    category: COMMENT_CATEGORIES.includes(row?.category) ? (row.category as CommentCategory) : null,
    onPitch: row?.on_pitch === true,
  };
}

type CommentCursor = { createdAt: string; commentId: string };

export function encodeCommentCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCommentCursor(value: string): CommentCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const date = new Date(parsed?.createdAt);
    if (
      Number.isNaN(date.getTime()) ||
      typeof parsed?.commentId !== "string" ||
      !UUID_PATTERN.test(parsed.commentId)
    ) {
      return null;
    }
    return { createdAt: date.toISOString(), commentId: parsed.commentId };
  } catch {
    return null;
  }
}

function rpcRows(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

/** Gate for every engagement route while the feature flag is off. */
export function requireDiscoverEngagement(_req: Request, res: Response, next: NextFunction) {
  if (!config.discoverEngagementEnabled) {
    return res.status(404).json({ error: "Not found.", code: "FEATURE_DISABLED" });
  }
  return next();
}

export function getPublicFeatures(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=60");
  return res.json({
    data: {
      discoverEngagement: config.discoverEngagementEnabled,
      community: config.communityEnabled,
      pitchArena: config.pitchArenaEnabled,
    },
  });
}

// ─── Public reads (optional auth) ────────────────────────────────────────────

export async function getBusinessEngagement(req: Request, res: Response) {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "Business not found." });

  try {
    const { data, error } = await supabase.rpc("public_business_engagement_by_slug", {
      p_slug: slug,
      p_viewer_id: req.user?.id ?? null,
    });
    if (error) {
      console.error("Business engagement read failed:", error);
      return res.status(500).json({ error: "Failed to load engagement." });
    }
    const row = rpcRows(data)[0];
    if (!row) return res.status(404).json({ error: "Business not found." });

    res.set("Cache-Control", req.user ? "private, no-store" : "public, max-age=15, s-maxage=30");
    return res.json({ data: toPublicEngagement(row, Boolean(req.user)) });
  } catch (error) {
    console.error("Business engagement read threw:", error);
    return res.status(500).json({ error: "Failed to load engagement." });
  }
}

export async function listBusinessComments(req: Request, res: Response) {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "Business not found." });

  const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor.slice(0, 500) : "";
  const cursor = rawCursor ? decodeCommentCursor(rawCursor) : null;
  if (rawCursor && !cursor) return res.status(400).json({ error: "Invalid pagination cursor." });

  try {
    const { data, error } = await supabase.rpc("list_public_business_comments", {
      p_slug: slug,
      p_cursor_created_at: cursor?.createdAt ?? null,
      p_cursor_comment_id: cursor?.commentId ?? null,
      p_limit: COMMENT_PAGE_SIZE + 1,
    });
    if (error) {
      console.error("Business comment list failed:", error);
      return res.status(500).json({ error: "Failed to load comments." });
    }

    const rows = rpcRows(data);
    const hasMore = rows.length > COMMENT_PAGE_SIZE;
    const page = rows.slice(0, COMMENT_PAGE_SIZE);

    // Owners and admins may hide comments on their own business profile.
    let canModerate = false;
    if (req.user && page.length) {
      const { data: membership } = await supabase
        .from("business_members")
        .select("role")
        .eq("business_id", page[0].comment_business_id)
        .eq("user_id", req.user.id)
        .eq("status", "active")
        .maybeSingle();
      canModerate = ["owner", "admin"].includes((membership as any)?.role);
    }

    const viewer = { userId: req.user?.id ?? null, canModerate };
    const last = hasMore ? page[page.length - 1] : null;
    res.set("Cache-Control", req.user ? "private, no-store" : "public, max-age=15, s-maxage=30");
    return res.json({
      data: page.map((row) => toPublicComment(row, viewer)),
      pagination: {
        hasMore,
        nextCursor: last
          ? encodeCommentCursor({
              createdAt: new Date(last.created_at).toISOString(),
              commentId: last.comment_id,
            })
          : null,
      },
    });
  } catch (error) {
    console.error("Business comment list threw:", error);
    return res.status(500).json({ error: "Failed to load comments." });
  }
}

// ─── Authenticated mutations ─────────────────────────────────────────────────

export const setBusinessEngagement =
  (kind: "support" | "follow", active: boolean) => async (req: Request, res: Response) => {
    const slug = normalizeSlug(req.params.slug);
    if (!slug) return res.status(404).json({ error: "Business not found." });

    try {
      const { data, error } = await supabase.rpc("set_business_engagement", {
        p_slug: slug,
        p_user_id: req.user!.id,
        p_kind: kind,
        p_active: active,
      });
      if (error) {
        if (error.code === "P0002") return res.status(404).json({ error: "Business not found." });
        if (error.code === "42501") {
          return res.status(403).json({
            error: "You can't support or follow a business you're a member of.",
          });
        }
        console.error(`Business ${kind} update failed:`, error);
        return res.status(500).json({ error: "Something went wrong. Please try again." });
      }
      const row = rpcRows(data)[0];
      if (active) {
        logEvent(kind === "support" ? "business_supported" : "business_followed", {
          userId: req.user!.id,
          businessId: row?.engaged_business_id ?? null,
        });
      }
      return res.json({ data: { active, count: count(row?.total_count) } });
    } catch (error) {
      console.error(`Business ${kind} update threw:`, error);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  };

export async function createBusinessComment(req: Request, res: Response) {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "Business not found." });

  const { body, error: validationError } = normalizeCommentBody(req.body?.body);
  if (validationError) return res.status(400).json({ error: validationError });

  // Optional structured pitch feedback. The pitch itself is resolved in the
  // database from the slug; the client only says "this is about the pitch".
  const rawCategory = req.body?.category;
  if (rawCategory !== undefined && rawCategory !== null && !COMMENT_CATEGORIES.includes(rawCategory)) {
    return res.status(400).json({ error: "Choose a valid feedback type." });
  }
  const category: CommentCategory | null = COMMENT_CATEGORIES.includes(rawCategory) ? rawCategory : null;
  const onPitch = req.body?.onPitch === true;
  if (onPitch && !config.pitchArenaEnabled) {
    return res.status(404).json({ error: "Pitch feedback isn't available." });
  }

  try {
    const { data, error } = await supabase.rpc("create_business_comment", {
      p_slug: slug,
      p_author_id: req.user!.id,
      p_body: body,
      // Sent only when used, so plain comments still work before 0026.
      ...(category ? { p_category: category } : {}),
      ...(onPitch ? { p_on_pitch: true } : {}),
    });
    if (error) {
      if (error.code === "P0002") {
        return res.status(404).json({ error: onPitch ? "This business has no public pitch right now." : "Business not found." });
      }
      if (error.code === "23505") return res.status(409).json({ error: "You already posted that comment." });
      if (error.code === "23514") return res.status(400).json({ error: "That comment can't be posted." });
      console.error("Comment creation failed:", error);
      return res.status(500).json({ error: "Failed to post comment." });
    }
    const created = rpcRows(data)[0];
    if (!created) return res.status(500).json({ error: "Failed to post comment." });

    const [{ data: author }, { data: membership }] = await Promise.all([
      supabase.from("users").select("name, avatar_url").eq("id", req.user!.id).maybeSingle(),
      supabase
        .from("business_members")
        .select("role")
        .eq("business_id", created.business_id)
        .eq("user_id", req.user!.id)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    logEvent("business_comment_posted", {
      userId: req.user!.id,
      businessId: created.business_id,
      properties: { byMember: Boolean(membership) },
    });
    if (created.pitch_id) {
      logEvent("pitch_feedback_posted", {
        userId: req.user!.id,
        businessId: created.business_id,
        properties: { category: created.category },
      });
    }
    return res.status(201).json({
      data: toPublicComment(
        {
          comment_id: created.id,
          body: created.body,
          created_at: created.created_at,
          author_id: req.user!.id,
          author_name: (author as any)?.name,
          author_avatar_url: (author as any)?.avatar_url,
          author_is_member: Boolean(membership),
          category: created.category,
          on_pitch: Boolean(created.pitch_id),
        },
        { userId: req.user!.id, canModerate: false },
      ),
    });
  } catch (error) {
    console.error("Comment creation threw:", error);
    return res.status(500).json({ error: "Failed to post comment." });
  }
}

export async function removeBusinessComment(req: Request, res: Response) {
  const commentId = String(req.params.commentId || "").trim();
  if (!UUID_PATTERN.test(commentId)) return res.status(404).json({ error: "Comment not found." });

  try {
    const { error } = await supabase.rpc("remove_business_comment", {
      p_comment_id: commentId,
      p_actor_id: req.user!.id,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Comment not found." });
      if (error.code === "42501") {
        return res.status(403).json({ error: "You can't remove this comment." });
      }
      console.error("Comment removal failed:", error);
      return res.status(500).json({ error: "Failed to remove comment." });
    }
    return res.status(204).send();
  } catch (error) {
    console.error("Comment removal threw:", error);
    return res.status(500).json({ error: "Failed to remove comment." });
  }
}

export async function createContentReport(req: Request, res: Response) {
  const entityType = req.body?.entityType;
  if (entityType !== "business" && entityType !== "comment" && entityType !== "pitch") {
    return res.status(400).json({ error: "Choose what you are reporting." });
  }
  // A pitch report targets whichever pitch is live for the slug (0026).
  if (entityType === "pitch" && !config.pitchArenaEnabled) {
    return res.status(404).json({ error: "Reported item not found." });
  }
  const slug = normalizeSlug(req.body?.slug);
  if (!slug) return res.status(404).json({ error: "Reported item not found." });

  const commentId = entityType === "comment" ? String(req.body?.commentId || "").trim() : null;
  if (entityType === "comment" && !UUID_PATTERN.test(commentId!)) {
    return res.status(404).json({ error: "Reported item not found." });
  }

  const reason = req.body?.reason;
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ error: "Choose a reason for the report." });
  }
  const { details, error: detailsError } = normalizeReportDetails(req.body?.details);
  if (detailsError) return res.status(400).json({ error: detailsError });

  try {
    const { data, error } = await supabase.rpc("create_content_report", {
      p_reporter_id: req.user!.id,
      p_entity_type: entityType,
      p_slug: slug,
      p_comment_id: commentId,
      p_reason: reason,
      p_details: details,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Reported item not found." });
      console.error("Content report failed:", error);
      return res.status(500).json({ error: "Failed to send report." });
    }
    const row = rpcRows(data)[0];
    return res.status(201).json({ data: { received: true, alreadyReported: row?.already_reported === true } });
  } catch (error) {
    console.error("Content report threw:", error);
    return res.status(500).json({ error: "Failed to send report." });
  }
}

// ─── Directory helper ────────────────────────────────────────────────────────

/**
 * Support and comment counts for a page of directory results, keyed by the
 * business id held inside each approved snapshot. Failure is non-fatal: the
 * directory still renders, just without counts (for example before 0021 runs).
 */
export async function loadDirectoryEngagement(
  businessIds: string[],
): Promise<Map<string, { supportCount: number; commentCount: number }>> {
  const result = new Map<string, { supportCount: number; commentCount: number }>();
  const ids = businessIds.filter((id) => UUID_PATTERN.test(id)).slice(0, 50);
  if (!config.discoverEngagementEnabled || !ids.length) return result;
  try {
    const { data, error } = await supabase.rpc("public_business_engagement", {
      p_business_ids: ids,
      p_viewer_id: null,
    });
    if (error) {
      console.warn("Directory engagement counts unavailable:", error.message);
      return result;
    }
    for (const row of rpcRows(data)) {
      if (typeof row?.engaged_business_id !== "string") continue;
      result.set(row.engaged_business_id, {
        supportCount: count(row.support_count),
        commentCount: count(row.comment_count),
      });
    }
  } catch (error) {
    console.warn("Directory engagement counts threw:", error);
  }
  return result;
}
