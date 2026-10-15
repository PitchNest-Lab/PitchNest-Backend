import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

/**
 * Privacy-safe product analytics (migration 0025).
 *
 * The single way to record a product event. Every name and every property is
 * allowlisted here; anything not listed is dropped before the insert. Values
 * are limited to booleans, small numbers, short enums and public slugs, so a
 * search term, comment, transcript, deck or contact detail can never be
 * recorded, even by mistake. Recording never throws and never delays the
 * request that triggered it.
 */

type PropertyRule = "boolean" | "count" | "mode" | "slug" | "kind" | "topic" | "filterKeys" | "category";

const FEEDBACK_CATEGORIES = ["clarity", "customer", "evidence", "go_to_market", "question"];

const MODES = ["panel", "coach", "solo"];
const KINDS = ["accelerator", "grant", "competition", "event", "fellowship", "program", "other", "update", "milestone", "launch"];
const TOPICS = ["pitching", "fundraising", "growth", "operations", "validation", "hiring", "general"];
const FILTER_KEYS = ["q", "type", "industry", "stage", "region"];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const EVENT_RULES = {
  discover_viewed: {},
  business_search_performed: { hasQuery: "boolean", filters: "filterKeys", resultCount: "count" },
  business_profile_opened: { slug: "slug" },
  business_draft_created: { fromOnboarding: "boolean" },
  business_published: {},
  business_unpublished: {},
  business_followed: {},
  business_supported: {},
  business_comment_posted: { byMember: "boolean" },
  business_update_posted: { kind: "kind" },
  practice_setup_opened: { fromBusiness: "boolean" },
  practice_started_from_business: { mode: "mode", withQuestion: "boolean" },
  question_sent_to_practice: { fromComment: "boolean" },
  community_thread_started: { topic: "topic" },
  community_reply_posted: {},
  opportunity_link_opened: { kind: "kind" },
  pitch_published: {},
  pitch_withdrawn: {},
  pitch_feedback_posted: { category: "category" },
  pitch_arena_viewed: {},
} as const satisfies Record<string, Record<string, PropertyRule>>;

export type EventName = keyof typeof EVENT_RULES;

/** The only events a browser may report: page views, no actions. */
export const CLIENT_EVENTS: readonly EventName[] = [
  "discover_viewed",
  "business_profile_opened",
  "practice_setup_opened",
  "opportunity_link_opened",
  "pitch_arena_viewed",
];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EVENT_RULES, value);
}

function cleanValue(rule: PropertyRule, value: unknown): unknown {
  switch (rule) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "count":
      return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, 10_000) : undefined;
    case "mode":
      return MODES.includes(value as string) ? value : undefined;
    case "kind":
      return KINDS.includes(value as string) ? value : undefined;
    case "topic":
      return TOPICS.includes(value as string) ? value : undefined;
    case "category":
      return FEEDBACK_CATEGORIES.includes(value as string) ? value : undefined;
    case "slug":
      return typeof value === "string" && value.length <= 80 && SLUG_PATTERN.test(value) ? value : undefined;
    case "filterKeys":
      return Array.isArray(value)
        ? [...new Set(value.filter((key) => FILTER_KEYS.includes(key as string)))].sort()
        : undefined;
  }
}

/** Keeps only allowlisted properties with valid values for this event. */
export function sanitizeEventProperties(name: EventName, input: unknown): Record<string, unknown> {
  const rules = EVENT_RULES[name] as Record<string, PropertyRule>;
  const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = cleanValue(rule, raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Records an event in the background. Never throws, never awaited by callers
 * that serve a user, and silently does nothing before migration 0025 exists.
 */
export function logEvent(
  name: EventName,
  context: { userId?: number | null; businessId?: string | null; properties?: unknown } = {},
): void {
  // Test suites set this (src/tests/testEnv.ts) so stubbed controller tests
  // can never write analytics rows to the real database in .env.
  if (process.env.PITCHNEST_ANALYTICS === "off") return;
  const row = {
    name,
    user_id: Number.isInteger(context.userId) ? context.userId : null,
    business_id: typeof context.businessId === "string" && UUID_PATTERN.test(context.businessId) ? context.businessId : null,
    properties: sanitizeEventProperties(name, context.properties),
  };
  try {
    void Promise.resolve(supabase.from("product_events").insert(row))
      .then((result: any) => {
        if (result?.error && !/relation .* does not exist/i.test(result.error.message || "")) {
          console.warn(`Event ${name} not recorded:`, result.error.message);
        }
      })
      .catch(() => {});
  } catch {
    // Analytics must never affect the product.
  }
}

/** POST /api/events — page-view events from the browser (optional auth). */
export function recordClientEvent(req: Request, res: Response) {
  const name = req.body?.name;
  if (!isEventName(name) || !CLIENT_EVENTS.includes(name)) {
    return res.status(400).json({ error: "Unknown event." });
  }
  logEvent(name, { userId: req.user?.id ?? null, properties: req.body?.properties });
  return res.status(202).json({ data: { accepted: true } });
}

/** GET /api/staff/analytics/summary?days=30 — aggregates only. */
export async function getEventSummary(req: Request, res: Response) {
  const requested = Number(req.query.days);
  const days = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 365) : 30;
  try {
    const { data, error } = await supabase.rpc("staff_event_summary", { p_days: days });
    if (error) {
      console.error("Event summary failed:", error);
      return res.status(500).json({ error: "Failed to load analytics." });
    }
    res.set("Cache-Control", "private, no-store");
    return res.json({
      data: {
        days,
        events: (Array.isArray(data) ? data : []).map((row: any) => ({
          name: String(row.name),
          total: Number(row.total) || 0,
          uniqueUsers: Number(row.unique_users) || 0,
          anonymous: Number(row.anonymous) || 0,
          lastSeen: row.last_seen ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("Event summary threw:", error);
    return res.status(500).json({ error: "Failed to load analytics." });
  }
}
