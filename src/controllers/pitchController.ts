import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { cleanPublicText, validatePublicText } from "../utils/publicText.ts";
import { logEvent } from "../services/eventService.ts";
import { normalizeSlug } from "./discoverEngagementController.ts";

/**
 * Public pitches (migration 0026). Written fresh in the workspace, previewed,
 * consented to, published and withdrawable. Never derived from any private
 * practice session, recording, transcript, deck or report.
 */

export const PITCH_CONSENT_VERSION = "public-pitch-v1";
export const PITCH_HEADLINE_MAX = 120;
export const PITCH_BODY_MIN = 50;
export const PITCH_BODY_MAX = 1500;
export const PITCH_ASK_MAX = 300;
export const FEEDBACK_CATEGORIES = ["clarity", "customer", "evidence", "go_to_market", "question"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 12;

const PITCH_COLUMNS =
  "id, status, version, headline, body, feedback_ask, approved_at, withdrawn_at, updated_at";

export function requirePitchArena(_req: Request, res: Response, next: NextFunction) {
  if (!config.pitchArenaEnabled) {
    return res.status(404).json({ error: "Not found.", code: "FEATURE_DISABLED" });
  }
  return next();
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function validatePitchInput(input: unknown): {
  headline: string;
  body: string;
  feedbackAsk: string | null;
  error?: string;
} {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const headline = typeof raw.headline === "string" ? cleanPublicText(raw.headline).replace(/\s+/g, " ") : "";
  if (headline.length < 5) return { headline, body: "", feedbackAsk: null, error: "Write a headline of at least 5 characters." };
  if (headline.length > PITCH_HEADLINE_MAX) {
    return { headline, body: "", feedbackAsk: null, error: `Headlines can be up to ${PITCH_HEADLINE_MAX} characters.` };
  }
  const body = validatePublicText(raw.body, { min: PITCH_BODY_MIN, max: PITCH_BODY_MAX, maxLinks: 2, noun: "pitch" });
  if (body.error) return { headline, body: body.text, feedbackAsk: null, error: body.error };

  let feedbackAsk: string | null = null;
  if (raw.feedbackAsk !== undefined && raw.feedbackAsk !== null && raw.feedbackAsk !== "") {
    if (typeof raw.feedbackAsk !== "string") {
      return { headline, body: body.text, feedbackAsk: null, error: "The feedback request must be text." };
    }
    feedbackAsk = cleanPublicText(raw.feedbackAsk).replace(/\s+/g, " ") || null;
    if (feedbackAsk && feedbackAsk.length > PITCH_ASK_MAX) {
      return { headline, body: body.text, feedbackAsk: null, error: `The feedback request can be up to ${PITCH_ASK_MAX} characters.` };
    }
  }
  return { headline, body: body.text, feedbackAsk };
}

export function toMemberPitch(row: any) {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status as "draft" | "published" | "withdrawn" | "hidden",
    version: Number(row.version) || 0,
    headline: typeof row.headline === "string" ? row.headline : "",
    body: typeof row.body === "string" ? row.body : "",
    feedbackAsk: typeof row.feedback_ask === "string" ? row.feedback_ask : "",
    approvedAt: iso(row.approved_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toPublicPitch(row: any) {
  return {
    version: Number(row?.version) || 1,
    headline: typeof row?.headline === "string" ? row.headline : "",
    body: typeof row?.body === "string" ? row.body : "",
    feedbackAsk: typeof row?.feedback_ask === "string" ? row.feedback_ask : "",
    publishedAt: iso(row?.approved_at),
    feedbackCount: Math.max(0, Number(row?.feedback_count) || 0),
  };
}

export function toPitchSummary(row: any) {
  return {
    headline: typeof row?.headline === "string" ? row.headline : "",
    excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
    feedbackAsk: typeof row?.feedback_ask === "string" ? row.feedback_ask : "",
    publishedAt: iso(row?.approved_at),
    feedbackCount: Math.max(0, Number(row?.feedback_count) || 0),
    business: {
      slug: typeof row?.business_slug === "string" ? row.business_slug : "",
      name: typeof row?.business_name === "string" ? row.business_name : "",
      tagline: typeof row?.business_tagline === "string" ? row.business_tagline : "",
      industry: typeof row?.business_industry === "string" ? row.business_industry : "",
      region: typeof row?.business_region === "string" ? row.business_region : "",
      // A sample business (migration 0034); absent before it, so false.
      isExample: row?.business_is_example === true,
    },
  };
}

function rows(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function getMemberPitch(req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("public_pitches")
      .select(PITCH_COLUMNS)
      .eq("business_id", req.businessMembership!.businessId)
      .in("status", ["draft", "published", "withdrawn", "hidden"])
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) {
      console.error("Member pitch read failed:", error);
      return res.status(500).json({ error: "Failed to load the pitch." });
    }
    const list = data ?? [];
    const published = list.find((row: any) => row.status === "published");
    // "Hidden" describes the team's latest public pitch, not any old version.
    const latestPublic = list.find((row: any) => row.status !== "draft");
    res.set("Cache-Control", "private, no-store");
    return res.json({
      data: {
        draft: toMemberPitch(list.find((row: any) => row.status === "draft")),
        published: toMemberPitch(published),
        hidden: !published && latestPublic?.status === "hidden",
        consentVersion: PITCH_CONSENT_VERSION,
      },
    });
  } catch (error) {
    console.error("Member pitch read threw:", error);
    return res.status(500).json({ error: "Failed to load the pitch." });
  }
}

export async function savePitchDraft(req: Request, res: Response) {
  const { headline, body, feedbackAsk, error: validationError } = validatePitchInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const { data, error } = await supabase.rpc("save_pitch_draft", {
      p_business_id: req.businessMembership!.businessId,
      p_actor_id: req.user!.id,
      p_headline: headline,
      p_body: body,
      p_feedback_ask: feedbackAsk,
    });
    if (error) {
      console.error("Pitch draft save failed:", error);
      return res.status(500).json({ error: "Failed to save the pitch." });
    }
    return res.json({ data: toMemberPitch(rows(data)[0]) });
  } catch (error) {
    console.error("Pitch draft save threw:", error);
    return res.status(500).json({ error: "Failed to save the pitch." });
  }
}

export async function publishPitch(req: Request, res: Response) {
  const draftId = req.body?.draftId;
  const updatedAt = req.body?.updatedAt;
  if (
    req.body?.confirmed !== true ||
    req.body?.consentVersion !== PITCH_CONSENT_VERSION ||
    typeof draftId !== "string" ||
    !UUID_PATTERN.test(draftId) ||
    typeof updatedAt !== "string" ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    return res.status(400).json({ error: "Review the preview and confirm before publishing." });
  }
  try {
    const { data, error } = await supabase.rpc("publish_pitch", {
      p_business_id: req.businessMembership!.businessId,
      p_actor_id: req.user!.id,
      p_draft_id: draftId,
      p_expected_updated_at: updatedAt,
      p_consent_version: PITCH_CONSENT_VERSION,
    });
    if (error) {
      if (error.code === "40001") return res.status(409).json({ error: "The pitch changed after preview. Review it again." });
      if (error.code === "23514") return res.status(422).json({ error: "Publish the business profile before its pitch." });
      if (error.code === "P0002") return res.status(404).json({ error: "Save the pitch draft first." });
      console.error("Pitch publish failed:", error);
      return res.status(500).json({ error: "Failed to publish the pitch." });
    }
    logEvent("pitch_published", { userId: req.user!.id, businessId: req.businessMembership!.businessId });
    return res.json({ data: toMemberPitch(rows(data)[0]) });
  } catch (error) {
    console.error("Pitch publish threw:", error);
    return res.status(500).json({ error: "Failed to publish the pitch." });
  }
}

export async function withdrawPitch(req: Request, res: Response) {
  try {
    const { error } = await supabase.rpc("withdraw_pitch", {
      p_business_id: req.businessMembership!.businessId,
      p_actor_id: req.user!.id,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "There is no public pitch to withdraw." });
      console.error("Pitch withdraw failed:", error);
      return res.status(500).json({ error: "Failed to withdraw the pitch." });
    }
    logEvent("pitch_withdrawn", { userId: req.user!.id, businessId: req.businessMembership!.businessId });
    return res.status(204).send();
  } catch (error) {
    console.error("Pitch withdraw threw:", error);
    return res.status(500).json({ error: "Failed to withdraw the pitch." });
  }
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function getPublicPitch(req: Request, res: Response) {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).json({ error: "Pitch not found." });
  try {
    const { data, error } = await supabase.rpc("get_public_pitch", { p_slug: slug });
    if (error) {
      console.error("Public pitch read failed:", error);
      return res.status(500).json({ error: "Failed to load the pitch." });
    }
    const row = rows(data)[0];
    if (!row) return res.status(404).json({ error: "Pitch not found." });
    res.set("Cache-Control", "public, max-age=30, s-maxage=60");
    return res.json({ data: toPublicPitch(row) });
  } catch (error) {
    console.error("Public pitch read threw:", error);
    return res.status(500).json({ error: "Failed to load the pitch." });
  }
}

type Cursor = { at: string; id: string };

export function encodePitchCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePitchCursor(value: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const date = new Date(parsed?.at);
    if (Number.isNaN(date.getTime()) || typeof parsed?.id !== "string" || !UUID_PATTERN.test(parsed.id)) return null;
    return { at: date.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

export async function listPublicPitches(req: Request, res: Response) {
  const raw = typeof req.query.cursor === "string" ? req.query.cursor.slice(0, 500) : "";
  const cursor = raw ? decodePitchCursor(raw) : null;
  if (raw && !cursor) return res.status(400).json({ error: "Invalid pagination cursor." });
  try {
    const { data, error } = await supabase.rpc("list_public_pitches", {
      p_cursor_approved_at: cursor?.at ?? null,
      p_cursor_pitch_id: cursor?.id ?? null,
      p_limit: PAGE_SIZE + 1,
    });
    if (error) {
      console.error("Public pitch list failed:", error);
      return res.status(500).json({ error: "Failed to load pitches." });
    }
    const all = rows(data);
    const hasMore = all.length > PAGE_SIZE;
    const page = all.slice(0, PAGE_SIZE);
    const last = hasMore ? page[page.length - 1] : null;
    res.set("Cache-Control", "public, max-age=30, s-maxage=120");
    return res.json({
      data: page.map(toPitchSummary).filter((pitch) => pitch.business.slug),
      pagination: {
        hasMore,
        nextCursor: last ? encodePitchCursor({ at: new Date(last.approved_at).toISOString(), id: last.pitch_id }) : null,
      },
    });
  } catch (error) {
    console.error("Public pitch list threw:", error);
    return res.status(500).json({ error: "Failed to load pitches." });
  }
}
