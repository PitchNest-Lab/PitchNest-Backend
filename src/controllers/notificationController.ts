import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

/**
 * In-app notifications (migration 0022). Rows are written by database
 * triggers; this controller only reads them for the signed-in user and marks
 * them read. list_user_notifications drops any row whose comment, update or
 * business is no longer visible, so an old notification can't leak content.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 20;

export type NotificationType =
  | "business_comment"
  | "business_update"
  | "community_reply"
  | "founder_update"
  | "founder_business"
  | "challenge_joined"
  | "challenge_eligible"
  | "challenge_submitted"
  | "challenge_correction"
  | "challenge_approved"
  | "challenge_rejected"
  | "challenge_results";

/** A founder's own challenge entry (migration 0038); the row names the challenge only. */
const CHALLENGE_TITLES: Record<string, (challenge: string) => string> = {
  challenge_joined: (c) => `You joined the ${c}`,
  challenge_eligible: (c) => `Your ${c} entry meets every requirement — submit it`,
  challenge_submitted: (c) => `We received your ${c} entry`,
  challenge_correction: (c) => `Your ${c} entry needs a correction`,
  challenge_approved: (c) => `Your ${c} entry is approved`,
  challenge_rejected: (c) => `Your ${c} entry wasn't accepted`,
  challenge_results: (c) => `${c} winners are announced`,
};

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  excerpt: string;
  link: string;
  createdAt: string;
  read: boolean;
}

export function toNotificationView(row: any): NotificationView | null {
  const type = row?.type;
  if (typeof type === "string" && Object.hasOwn(CHALLENGE_TITLES, type)) {
    const slug = typeof row?.challenge_slug === "string" ? row.challenge_slug : "";
    if (!slug) return null;
    const title = typeof row?.challenge_title === "string" && row.challenge_title ? row.challenge_title : "challenge";
    const created = new Date(row?.created_at);
    return {
      id: String(row?.notification_id ?? ""),
      type: type as NotificationType,
      title: CHALLENGE_TITLES[type](title),
      excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
      link: `/opportunities/challenges/${encodeURIComponent(slug)}${type === "challenge_results" ? "#results" : "#my-entry"}`,
      createdAt: Number.isNaN(created.getTime()) ? "" : created.toISOString(),
      read: Boolean(row?.read_at),
    };
  }
  if (type === "community_reply") {
    const threadId = typeof row?.thread_id === "string" ? row.thread_id : "";
    const threadTitle = typeof row?.thread_title === "string" ? row.thread_title : "your discussion";
    if (!threadId) return null;
    const created = new Date(row?.created_at);
    return {
      id: String(row?.notification_id ?? ""),
      type,
      title: `New reply to “${threadTitle.length > 60 ? `${threadTitle.slice(0, 57)}...` : threadTitle}”`,
      excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
      link: `/community/${encodeURIComponent(threadId)}#replies`,
      createdAt: Number.isNaN(created.getTime()) ? "" : created.toISOString(),
      read: Boolean(row?.read_at),
    };
  }
  if (type === "founder_update" || type === "founder_business") {
    // Only rows whose founder is still public reach here (list_user_notifications).
    const founder = typeof row?.founder_name === "string" && row.founder_name ? row.founder_name : "A founder you follow";
    const business = typeof row?.business_name === "string" ? row.business_name : "a business";
    const slug = typeof row?.business_slug === "string" ? row.business_slug : "";
    if (!slug) return null;
    const created = new Date(row?.created_at);
    return {
      id: String(row?.notification_id ?? ""),
      type,
      title:
        type === "founder_update"
          ? `${founder} posted an update on ${business}`
          : `${founder} is now on ${business}`,
      excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
      link:
        type === "founder_update"
          ? `/businesses/${encodeURIComponent(slug)}#updates`
          : `/businesses/${encodeURIComponent(slug)}`,
      createdAt: Number.isNaN(created.getTime()) ? "" : created.toISOString(),
      read: Boolean(row?.read_at),
    };
  }
  if (type !== "business_comment" && type !== "business_update") return null;
  const name = typeof row?.business_name === "string" ? row.business_name : "your business";
  const slug = typeof row?.business_slug === "string" ? row.business_slug : "";
  const businessId = typeof row?.business_id === "string" ? row.business_id : "";
  const created = new Date(row?.created_at);
  return {
    id: String(row?.notification_id ?? ""),
    type,
    title:
      type === "business_comment"
        ? typeof row?.comment_category === "string" && row.comment_category !== "question"
          ? `New pitch feedback on ${name}`
          : `New question on ${name}`
        : `${name} posted an update`,
    excerpt: typeof row?.excerpt === "string" ? row.excerpt : "",
    // Comments open the team's private questions inbox; updates open the
    // public profile (list_user_notifications only returns updates of
    // published businesses).
    link:
      type === "business_comment"
        ? `/workspace/businesses?business=${encodeURIComponent(businessId)}#questions`
        : `/businesses/${encodeURIComponent(slug)}#updates`,
    createdAt: Number.isNaN(created.getTime()) ? "" : created.toISOString(),
    read: Boolean(row?.read_at),
  };
}

export async function listNotifications(req: Request, res: Response) {
  try {
    const { data, error } = await supabase.rpc("list_user_notifications", {
      p_user_id: req.user!.id,
      p_limit: PAGE_SIZE,
    });
    if (error) {
      console.error("Notification read failed:", error);
      return res.status(500).json({ error: "Failed to load notifications." });
    }
    const items = (Array.isArray(data) ? data : [])
      .map(toNotificationView)
      .filter((item): item is NotificationView => item !== null);
    res.set("Cache-Control", "private, no-store");
    return res.json({
      data: items,
      unreadCount: items.filter((item) => !item.read).length,
    });
  } catch (error) {
    console.error("Notification read threw:", error);
    return res.status(500).json({ error: "Failed to load notifications." });
  }
}

/** POST /api/notifications/read — body { ids: string[] } or { all: true }. */
export async function markNotificationsRead(req: Request, res: Response) {
  const all = req.body?.all === true;
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.filter((id: unknown) => typeof id === "string" && UUID_PATTERN.test(id)).slice(0, 50)
    : [];
  if (!all && ids.length === 0) {
    return res.status(400).json({ error: "Choose notifications to mark as read." });
  }
  try {
    let query = supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", req.user!.id)
      .is("read_at", null);
    if (!all) query = query.in("id", ids);
    const { error } = await query;
    if (error) {
      console.error("Notification mark-read failed:", error);
      return res.status(500).json({ error: "Failed to update notifications." });
    }
    return res.json({ data: { updated: true } });
  } catch (error) {
    console.error("Notification mark-read threw:", error);
    return res.status(500).json({ error: "Failed to update notifications." });
  }
}
