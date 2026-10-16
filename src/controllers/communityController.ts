import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { safeAvatarUrl } from "../utils/storagePath.ts";
import { cleanPublicText, validatePublicText } from "../utils/publicText.ts";
import { normalizeReportDetails, REPORT_REASONS } from "./discoverEngagementController.ts";
import { logEvent } from "../services/eventService.ts";

/**
 * Community discussions (migration 0023). Reads go through database functions
 * that only return visible threads and replies. Author user ids come back
 * from those functions solely to compute "is this mine" and are never
 * serialised. Writes always use req.user as the author.
 */

export const COMMUNITY_TOPICS = [
  "pitching",
  "fundraising",
  "growth",
  "operations",
  "validation",
  "hiring",
  "general",
] as const;
export type CommunityTopic = (typeof COMMUNITY_TOPICS)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 30;

export function requireCommunity(_req: Request, res: Response, next: NextFunction) {
  if (!config.communityEnabled) {
    return res.status(404).json({ error: "Not found.", code: "FEATURE_DISABLED" });
  }
  return next();
}

function iso(value: unknown): string {
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function authorName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  return name || "PitchNest member";
}

function rows(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateThreadInput(input: unknown): {
  topic: CommunityTopic;
  title: string;
  body: string;
  error?: string;
} {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const topic = COMMUNITY_TOPICS.includes(raw.topic as CommunityTopic) ? (raw.topic as CommunityTopic) : null;
  if (!topic) return { topic: "general", title: "", body: "", error: "Choose a topic." };

  // Titles are a single line.
  const title = typeof raw.title === "string" ? cleanPublicText(raw.title).replace(/\s+/g, " ") : "";
  if (title.length < 5) return { topic, title, body: "", error: "Write a title of at least 5 characters." };
  if (title.length > 140) return { topic, title, body: "", error: "Titles can be up to 140 characters." };

  const { text, error } = validatePublicText(raw.body, { min: 10, max: 3000, maxLinks: 3, noun: "post" });
  if (error) return { topic, title, body: text, error };
  return { topic, title, body: text };
}

export function validateReplyBody(raw: unknown): { body: string; error?: string } {
  const { text, error } = validatePublicText(raw, { min: 2, max: 2000, maxLinks: 2, noun: "reply" });
  return error ? { body: text, error } : { body: text };
}

// ─── Serializers ─────────────────────────────────────────────────────────────

export function toThreadSummary(row: any, viewerId: number | null) {
  return {
    id: String(row?.thread_id ?? row?.id ?? ""),
    topic: COMMUNITY_TOPICS.includes(row?.topic) ? (row.topic as CommunityTopic) : "general",
    title: typeof row?.title === "string" ? row.title : "",
    excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
    createdAt: iso(row?.created_at),
    lastActivityAt: iso(row?.last_activity_at),
    replyCount: Math.max(0, Number(row?.reply_count) || 0),
    author: { name: authorName(row?.author_name) },
    viewerIsAuthor: viewerId !== null && row?.author_id === viewerId,
  };
}

export function toThreadDetail(row: any, viewerId: number | null) {
  return {
    id: String(row?.thread_id ?? row?.id ?? ""),
    topic: COMMUNITY_TOPICS.includes(row?.topic) ? (row.topic as CommunityTopic) : "general",
    title: typeof row?.title === "string" ? row.title : "",
    body: typeof row?.body === "string" ? row.body : "",
    createdAt: iso(row?.created_at),
    lastActivityAt: iso(row?.last_activity_at),
    replyCount: Math.max(0, Number(row?.reply_count) || 0),
    author: { name: authorName(row?.author_name), avatarUrl: safeAvatarUrl(row?.author_avatar_url) },
    viewerIsAuthor: viewerId !== null && row?.author_id === viewerId,
  };
}

export function toReply(row: any, viewerId: number | null) {
  return {
    id: String(row?.reply_id ?? row?.id ?? ""),
    body: typeof row?.body === "string" ? row.body : "",
    createdAt: iso(row?.created_at),
    author: { name: authorName(row?.author_name), avatarUrl: safeAvatarUrl(row?.author_avatar_url) },
    viewerIsAuthor: viewerId !== null && row?.author_id === viewerId,
  };
}

// ─── Cursors ─────────────────────────────────────────────────────────────────

type Cursor = { at: string; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const date = new Date(parsed?.at);
    if (Number.isNaN(date.getTime()) || typeof parsed?.id !== "string" || !UUID_PATTERN.test(parsed.id)) {
      return null;
    }
    return { at: date.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

function readCursor(req: Request): { cursor: Cursor | null; invalid: boolean } {
  const raw = typeof req.query.cursor === "string" ? req.query.cursor.slice(0, 500) : "";
  const cursor = raw ? decodeCursor(raw) : null;
  return { cursor, invalid: Boolean(raw && !cursor) };
}

// ─── Reads (optional auth) ───────────────────────────────────────────────────

export async function listThreads(req: Request, res: Response) {
  const topic = typeof req.query.topic === "string" ? req.query.topic.trim() : "";
  if (topic && !COMMUNITY_TOPICS.includes(topic as CommunityTopic)) {
    return res.status(400).json({ error: "Unknown topic." });
  }
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const { cursor, invalid } = readCursor(req);
  if (invalid) return res.status(400).json({ error: "Invalid pagination cursor." });

  try {
    const { data, error } = await supabase.rpc("list_community_threads", {
      p_topic: topic || null,
      p_query: q || null,
      p_cursor_activity_at: cursor?.at ?? null,
      p_cursor_thread_id: cursor?.id ?? null,
      p_limit: THREAD_PAGE_SIZE + 1,
    });
    if (error) {
      console.error("Community thread list failed:", error);
      return res.status(500).json({ error: "Failed to load discussions." });
    }
    const all = rows(data);
    const hasMore = all.length > THREAD_PAGE_SIZE;
    const page = all.slice(0, THREAD_PAGE_SIZE);
    const last = hasMore ? page[page.length - 1] : null;
    const viewerId = req.user?.id ?? null;
    res.set("Cache-Control", req.user ? "private, no-store" : "public, max-age=15, s-maxage=30");
    return res.json({
      data: page.map((row) => toThreadSummary(row, viewerId)),
      pagination: {
        hasMore,
        nextCursor: last
          ? encodeCursor({ at: new Date(last.last_activity_at).toISOString(), id: last.thread_id })
          : null,
      },
    });
  } catch (error) {
    console.error("Community thread list threw:", error);
    return res.status(500).json({ error: "Failed to load discussions." });
  }
}

export async function getThread(req: Request, res: Response) {
  const threadId = String(req.params.threadId || "").trim();
  if (!UUID_PATTERN.test(threadId)) return res.status(404).json({ error: "Discussion not found." });
  try {
    const { data, error } = await supabase.rpc("get_community_thread", { p_thread_id: threadId });
    if (error) {
      console.error("Community thread read failed:", error);
      return res.status(500).json({ error: "Failed to load discussion." });
    }
    const row = rows(data)[0];
    if (!row) return res.status(404).json({ error: "Discussion not found." });
    res.set("Cache-Control", req.user ? "private, no-store" : "public, max-age=15, s-maxage=30");
    return res.json({ data: toThreadDetail(row, req.user?.id ?? null) });
  } catch (error) {
    console.error("Community thread read threw:", error);
    return res.status(500).json({ error: "Failed to load discussion." });
  }
}

export async function listReplies(req: Request, res: Response) {
  const threadId = String(req.params.threadId || "").trim();
  if (!UUID_PATTERN.test(threadId)) return res.status(404).json({ error: "Discussion not found." });
  const { cursor, invalid } = readCursor(req);
  if (invalid) return res.status(400).json({ error: "Invalid pagination cursor." });
  try {
    const { data, error } = await supabase.rpc("list_community_replies", {
      p_thread_id: threadId,
      p_cursor_created_at: cursor?.at ?? null,
      p_cursor_reply_id: cursor?.id ?? null,
      p_limit: REPLY_PAGE_SIZE + 1,
    });
    if (error) {
      console.error("Community replies read failed:", error);
      return res.status(500).json({ error: "Failed to load replies." });
    }
    const all = rows(data);
    const hasMore = all.length > REPLY_PAGE_SIZE;
    const page = all.slice(0, REPLY_PAGE_SIZE);
    const last = hasMore ? page[page.length - 1] : null;
    const viewerId = req.user?.id ?? null;
    res.set("Cache-Control", req.user ? "private, no-store" : "public, max-age=15, s-maxage=30");
    return res.json({
      data: page.map((row) => toReply(row, viewerId)),
      pagination: {
        hasMore,
        nextCursor: last ? encodeCursor({ at: new Date(last.created_at).toISOString(), id: last.reply_id }) : null,
      },
    });
  } catch (error) {
    console.error("Community replies read threw:", error);
    return res.status(500).json({ error: "Failed to load replies." });
  }
}

// ─── Writes (authenticated) ──────────────────────────────────────────────────

export async function createThread(req: Request, res: Response) {
  const { topic, title, body, error: validationError } = validateThreadInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const { data, error } = await supabase.rpc("create_community_thread", {
      p_author_id: req.user!.id,
      p_topic: topic,
      p_title: title,
      p_body: body,
    });
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "You started a discussion with that title recently." });
      }
      if (error.code === "23514") return res.status(400).json({ error: "That discussion can't be posted." });
      console.error("Community thread create failed:", error);
      return res.status(500).json({ error: "Failed to start discussion." });
    }
    const created = rows(data)[0];
    if (!created) return res.status(500).json({ error: "Failed to start discussion." });
    logEvent("community_thread_started", { userId: req.user!.id, properties: { topic } });
    return res.status(201).json({ data: { id: created.id } });
  } catch (error) {
    console.error("Community thread create threw:", error);
    return res.status(500).json({ error: "Failed to start discussion." });
  }
}

export async function createReply(req: Request, res: Response) {
  const threadId = String(req.params.threadId || "").trim();
  if (!UUID_PATTERN.test(threadId)) return res.status(404).json({ error: "Discussion not found." });
  const { body, error: validationError } = validateReplyBody(req.body?.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const { data, error } = await supabase.rpc("create_community_reply", {
      p_thread_id: threadId,
      p_author_id: req.user!.id,
      p_body: body,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Discussion not found." });
      if (error.code === "23505") return res.status(409).json({ error: "You already posted that reply." });
      if (error.code === "23514") return res.status(400).json({ error: "That reply can't be posted." });
      console.error("Community reply create failed:", error);
      return res.status(500).json({ error: "Failed to post reply." });
    }
    const created = rows(data)[0];
    if (!created) return res.status(500).json({ error: "Failed to post reply." });
    logEvent("community_reply_posted", { userId: req.user!.id });

    const { data: author } = await supabase
      .from("users")
      .select("name, avatar_url")
      .eq("id", req.user!.id)
      .maybeSingle();
    return res.status(201).json({
      data: toReply(
        {
          reply_id: created.id,
          body: created.body,
          created_at: created.created_at,
          author_id: req.user!.id,
          author_name: (author as any)?.name,
          author_avatar_url: (author as any)?.avatar_url,
        },
        req.user!.id,
      ),
    });
  } catch (error) {
    console.error("Community reply create threw:", error);
    return res.status(500).json({ error: "Failed to post reply." });
  }
}

/** Authors remove their own thread or reply. Staff use the moderation queue. */
export const removeOwnCommunityItem =
  (kind: "thread" | "reply") => async (req: Request, res: Response) => {
    const id = String(req.params.id || "").trim();
    const notFound = kind === "thread" ? "Discussion not found." : "Reply not found.";
    if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: notFound });
    try {
      const { data, error } = await supabase
        .from(kind === "thread" ? "community_threads" : "community_replies")
        .update({ status: "removed", updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("author_id", req.user!.id)
        .eq("status", "visible")
        .select("id")
        .maybeSingle();
      if (error) {
        console.error(`Community ${kind} removal failed:`, error);
        return res.status(500).json({ error: "Failed to remove." });
      }
      if (!data) return res.status(404).json({ error: notFound });
      return res.status(204).send();
    } catch (error) {
      console.error(`Community ${kind} removal threw:`, error);
      return res.status(500).json({ error: "Failed to remove." });
    }
  };

export async function reportCommunityItem(req: Request, res: Response) {
  const entityType = req.body?.entityType;
  if (entityType !== "thread" && entityType !== "reply") {
    return res.status(400).json({ error: "Choose what you are reporting." });
  }
  const entityId = String(req.body?.entityId || "").trim();
  if (!UUID_PATTERN.test(entityId)) return res.status(404).json({ error: "Reported item not found." });
  const reason = req.body?.reason;
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: "Choose a reason for the report." });
  const { details, error: detailsError } = normalizeReportDetails(req.body?.details);
  if (detailsError) return res.status(400).json({ error: detailsError });

  try {
    const { data, error } = await supabase.rpc("create_community_report", {
      p_reporter_id: req.user!.id,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_reason: reason,
      p_details: details,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Reported item not found." });
      console.error("Community report failed:", error);
      return res.status(500).json({ error: "Failed to send report." });
    }
    const row = rows(data)[0];
    return res.status(201).json({ data: { received: true, alreadyReported: row?.already_reported === true } });
  } catch (error) {
    console.error("Community report threw:", error);
    return res.status(500).json({ error: "Failed to send report." });
  }
}
