import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { validatePublicText } from "../utils/publicText.ts";
import { normalizeSlug } from "./discoverEngagementController.ts";
import { logEvent } from "../services/eventService.ts";

/**
 * Business updates (milestones, launches) and the members' view of community
 * questions. Member routes sit behind requireBusinessMembership; the public
 * update feed resolves through list_public_business_updates (migration 0022),
 * which only returns updates of a currently published business.
 */

export const UPDATE_KINDS = ["update", "milestone", "launch"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];
export const UPDATE_MAX_LENGTH = 1500;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value: unknown): string {
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function toPublicUpdate(row: any) {
  return {
    id: String(row?.update_id ?? row?.id ?? ""),
    kind: UPDATE_KINDS.includes(row?.kind) ? (row.kind as UpdateKind) : "update",
    body: typeof row?.body === "string" ? row.body : "",
    createdAt: iso(row?.created_at),
  };
}

export function validateUpdateInput(input: unknown): {
  kind: UpdateKind;
  body: string;
  error?: string;
} {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const kind = UPDATE_KINDS.includes(raw.kind as UpdateKind) ? (raw.kind as UpdateKind) : null;
  if (!kind) return { kind: "update", body: "", error: "Choose update, milestone or launch." };
  const { text, error } = validatePublicText(raw.body, {
    min: 2,
    max: UPDATE_MAX_LENGTH,
    maxLinks: 3,
    noun: "update",
  });
  return error ? { kind, body: text, error } : { kind, body: text };
}

async function audit(businessId: string, actorId: number, action: string, metadata: Record<string, unknown>) {
  const { error } = await supabase
    .from("business_audit_log")
    .insert({ business_id: businessId, actor_id: actorId, action, metadata });
  if (error) console.warn(`Business audit write failed for ${action}:`, error.message);
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function listPublicBusinessUpdates(req: Request, res: Response) {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "Business not found." });
  try {
    const { data, error } = await supabase.rpc("list_public_business_updates", {
      p_slug: slug,
      p_limit: 10,
    });
    if (error) {
      console.error("Public updates read failed:", error);
      return res.status(500).json({ error: "Failed to load updates." });
    }
    res.set("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.json({ data: (Array.isArray(data) ? data : []).map(toPublicUpdate) });
  } catch (error) {
    console.error("Public updates read threw:", error);
    return res.status(500).json({ error: "Failed to load updates." });
  }
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function listMemberUpdates(req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("business_updates")
      .select("id, kind, body, created_at")
      .eq("business_id", req.businessMembership!.businessId)
      .eq("status", "visible")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.error("Member updates read failed:", error);
      return res.status(500).json({ error: "Failed to load updates." });
    }
    res.set("Cache-Control", "private, no-store");
    return res.json({ data: (data ?? []).map(toPublicUpdate) });
  } catch (error) {
    console.error("Member updates read threw:", error);
    return res.status(500).json({ error: "Failed to load updates." });
  }
}

export async function createBusinessUpdate(req: Request, res: Response) {
  const { kind, body, error: validationError } = validateUpdateInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const businessId = req.businessMembership!.businessId;
  try {
    const { data, error } = await supabase
      .from("business_updates")
      .insert({ business_id: businessId, author_id: req.user!.id, kind, body })
      .select("id, kind, body, created_at")
      .single();
    if (error || !data) {
      console.error("Business update insert failed:", error);
      return res.status(500).json({ error: "Failed to post update." });
    }
    await audit(businessId, req.user!.id, "update.posted", { updateId: data.id, kind });
    logEvent("business_update_posted", { userId: req.user!.id, businessId, properties: { kind } });
    return res.status(201).json({ data: toPublicUpdate(data) });
  } catch (error) {
    console.error("Business update insert threw:", error);
    return res.status(500).json({ error: "Failed to post update." });
  }
}

export async function removeBusinessUpdate(req: Request, res: Response) {
  const updateId = String(req.params.updateId || "").trim();
  if (!UUID_PATTERN.test(updateId)) return res.status(404).json({ error: "Update not found." });

  const businessId = req.businessMembership!.businessId;
  try {
    const { data, error } = await supabase
      .from("business_updates")
      .update({ status: "removed", updated_at: new Date().toISOString() })
      .eq("id", updateId)
      .eq("business_id", businessId)
      .eq("status", "visible")
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("Business update removal failed:", error);
      return res.status(500).json({ error: "Failed to remove update." });
    }
    if (!data) return res.status(404).json({ error: "Update not found." });
    await audit(businessId, req.user!.id, "update.removed", { updateId });
    return res.status(204).send();
  } catch (error) {
    console.error("Business update removal threw:", error);
    return res.status(500).json({ error: "Failed to remove update." });
  }
}

const MEMBER_COMMENT_CATEGORIES = ["clarity", "customer", "evidence", "go_to_market", "question"];

export function toMemberComment(row: any, authorName: unknown, authorIsMember: boolean) {
  const name = typeof authorName === "string" ? authorName.trim().slice(0, 80) : "";
  return {
    id: String(row?.id ?? ""),
    body: typeof row?.body === "string" ? row.body : "",
    createdAt: iso(row?.created_at),
    author: { name: name || "PitchNest member", isBusinessMember: authorIsMember },
    category: MEMBER_COMMENT_CATEGORIES.includes(row?.category) ? (row.category as string) : null,
    onPitch: Boolean(row?.pitch_id),
  };
}

/** Recent visible comments; tolerates databases that predate migration 0026. */
async function readRecentComments(businessId: string) {
  const query = (columns: string) =>
    supabase
      .from("business_comments")
      .select(columns)
      .eq("business_id", businessId)
      .eq("status", "visible")
      .order("created_at", { ascending: false })
      .limit(30);
  const withFeedback = await query("id, body, created_at, author_id, category, pitch_id");
  if (withFeedback.error && withFeedback.error.code === "42703") {
    return query("id, body, created_at, author_id");
  }
  return withFeedback;
}

/**
 * The members' questions inbox: recent visible comments on this business,
 * newest first, so the team can answer them or practise them privately.
 * Comments by the team itself are excluded — they are answers, not questions.
 */
export async function listMemberComments(req: Request, res: Response) {
  const businessId = req.businessMembership!.businessId;
  try {
    const [{ data: comments, error }, { data: members, error: membersError }] = await Promise.all([
      readRecentComments(businessId),
      supabase
        .from("business_members")
        .select("user_id")
        .eq("business_id", businessId)
        .eq("status", "active"),
    ]);
    if (error || membersError) {
      console.error("Member comments read failed:", error || membersError);
      return res.status(500).json({ error: "Failed to load questions." });
    }

    const memberIds = new Set((members ?? []).map((member: any) => member.user_id));
    const questions = (comments ?? []).filter((comment: any) => !memberIds.has(comment.author_id)).slice(0, 20);
    const authorIds = [...new Set(questions.map((comment: any) => comment.author_id))];
    let names = new Map<number, string>();
    if (authorIds.length) {
      const { data: authors } = await supabase.from("users").select("id, name").in("id", authorIds);
      names = new Map((authors ?? []).map((author: any) => [author.id, author.name]));
    }

    res.set("Cache-Control", "private, no-store");
    return res.json({
      data: questions.map((comment: any) => toMemberComment(comment, names.get(comment.author_id), false)),
    });
  } catch (error) {
    console.error("Member comments read threw:", error);
    return res.status(500).json({ error: "Failed to load questions." });
  }
}
