import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { cleanPublicText } from "../utils/publicText.ts";

/**
 * Curated opportunities (migration 0024). Staff create and maintain them;
 * the public only reads published ones. Open / closing soon / closed is
 * computed from the dates on every read, never stored.
 */

export const OPPORTUNITY_KINDS = [
  "accelerator",
  "grant",
  "competition",
  "event",
  "fellowship",
  "program",
  "other",
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];
export const OPPORTUNITY_STATUSES = ["draft", "published", "archived"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export type OpportunityState = "upcoming" | "open" | "closing_soon" | "closed" | "rolling";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOSING_SOON_DAYS = 7;
export const STALE_AFTER_DAYS = 30;

const STAFF_COLUMNS =
  "id, title, organizer, kind, summary, eligibility, region, sector, source_url, opens_on, closes_on, status, last_checked_at, created_at, updated_at";

/** Today's date (UTC) as YYYY-MM-DD, matching the database's CURRENT_DATE. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function opportunityState(
  opensOn: string | null,
  closesOn: string | null,
  today: string,
): { state: OpportunityState; daysLeft: number | null } {
  if (opensOn && opensOn > today) return { state: "upcoming", daysLeft: closesOn ? daysBetween(today, closesOn) : null };
  if (!closesOn) return { state: "rolling", daysLeft: null };
  const daysLeft = daysBetween(today, closesOn);
  if (daysLeft < 0) return { state: "closed", daysLeft };
  if (daysLeft <= CLOSING_SOON_DAYS) return { state: "closing_soon", daysLeft };
  return { state: "open", daysLeft };
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && DATE_PATTERN.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
}

function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

export function toPublicOpportunity(row: any, today = todayIso()) {
  const opensOn = dateOnly(row?.opens_on);
  const closesOn = dateOnly(row?.closes_on);
  const checked = new Date(row?.last_checked_at);
  return {
    id: String(row?.opportunity_id ?? row?.id ?? ""),
    title: typeof row?.title === "string" ? row.title : "",
    organizer: typeof row?.organizer === "string" ? row.organizer : "",
    kind: OPPORTUNITY_KINDS.includes(row?.kind) ? (row.kind as OpportunityKind) : "other",
    summary: typeof row?.summary === "string" ? row.summary : "",
    eligibility: typeof row?.eligibility === "string" ? row.eligibility : "",
    region: typeof row?.region === "string" ? row.region : "",
    sector: typeof row?.sector === "string" ? row.sector : "",
    sourceUrl: safeUrl(row?.source_url),
    opensOn,
    closesOn,
    lastCheckedAt: Number.isNaN(checked.getTime()) ? null : checked.toISOString(),
    ...opportunityState(opensOn, closesOn, today),
  };
}

export function toStaffOpportunity(row: any, now = new Date()) {
  const view = toPublicOpportunity(row, todayIso(now));
  const checked = view.lastCheckedAt ? Date.parse(view.lastCheckedAt) : 0;
  return {
    ...view,
    status: OPPORTUNITY_STATUSES.includes(row?.status) ? (row.status as OpportunityStatus) : "draft",
    stale: !checked || now.getTime() - checked > STALE_AFTER_DAYS * 86_400_000,
    updatedAt: typeof row?.updated_at === "string" ? row.updated_at : null,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TEXT_FIELDS = {
  title: { column: "title", min: 5, max: 140, required: true, singleLine: true },
  organizer: { column: "organizer", min: 2, max: 120, required: true, singleLine: true },
  summary: { column: "summary", min: 10, max: 1500, required: true, singleLine: false },
  eligibility: { column: "eligibility", min: 0, max: 1000, required: false, singleLine: false },
  region: { column: "region", min: 0, max: 120, required: false, singleLine: true },
  sector: { column: "sector", min: 0, max: 100, required: false, singleLine: true },
} as const;

export function validateOpportunityInput(
  input: unknown,
  options: { partial?: boolean } = {},
): { values: Record<string, unknown>; errors: string[] } {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [field, spec] of Object.entries(TEXT_FIELDS)) {
    if (!(field in body)) {
      if (spec.required && !options.partial) errors.push(`${field} is required.`);
      continue;
    }
    const raw = body[field];
    if (raw === null || raw === "") {
      if (spec.required) errors.push(`${field} is required.`);
      else values[spec.column] = null;
      continue;
    }
    if (typeof raw !== "string") {
      errors.push(`${field} must be text.`);
      continue;
    }
    let text = cleanPublicText(raw);
    if (spec.singleLine) text = text.replace(/\s+/g, " ");
    if (text.length < spec.min) errors.push(`${field} must be at least ${spec.min} characters.`);
    else if (text.length > spec.max) errors.push(`${field} can be up to ${spec.max} characters.`);
    else values[spec.column] = text || null;
  }

  if ("kind" in body || !options.partial) {
    if (OPPORTUNITY_KINDS.includes(body.kind as OpportunityKind)) values.kind = body.kind;
    else errors.push(`kind must be one of: ${OPPORTUNITY_KINDS.join(", ")}.`);
  }

  if ("sourceUrl" in body || !options.partial) {
    const url = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
    let ok = false;
    try {
      const parsed = new URL(url);
      ok =
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password &&
        url.length <= 500 &&
        !/\s/.test(url);
    } catch {
      ok = false;
    }
    if (ok) values.source_url = url;
    else errors.push("sourceUrl must be the official http(s) link.");
  }

  for (const [field, column] of [["opensOn", "opens_on"], ["closesOn", "closes_on"]] as const) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === "") {
      values[column] = null;
    } else if (typeof raw === "string" && DATE_PATTERN.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      values[column] = raw;
    } else {
      errors.push(`${field} must be a date (YYYY-MM-DD).`);
    }
  }
  if (typeof values.opens_on === "string" && typeof values.closes_on === "string" && values.opens_on > values.closes_on) {
    errors.push("opensOn must be on or before closesOn.");
  }

  if ("status" in body) {
    if (OPPORTUNITY_STATUSES.includes(body.status as OpportunityStatus)) values.status = body.status;
    else errors.push(`status must be one of: ${OPPORTUNITY_STATUSES.join(", ")}.`);
  }

  return { values, errors: [...new Set(errors)] };
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function listPublicOpportunities(req: Request, res: Response) {
  const kind = typeof req.query.kind === "string" ? req.query.kind.trim() : "";
  if (kind && !OPPORTUNITY_KINDS.includes(kind as OpportunityKind)) {
    return res.status(400).json({ error: "Unknown opportunity type." });
  }
  const region = typeof req.query.region === "string" ? req.query.region.trim().slice(0, 120) : "";
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const includeClosed = req.query.includeClosed === "true";
  try {
    const { data, error } = await supabase.rpc("list_public_opportunities", {
      p_kind: kind || null,
      p_region: region || null,
      p_query: q || null,
      p_include_closed: includeClosed,
      p_limit: 60,
    });
    if (error) {
      console.error("Public opportunities read failed:", error);
      return res.status(500).json({ error: "Failed to load opportunities." });
    }
    const today = todayIso();
    res.set("Cache-Control", "public, max-age=60, s-maxage=300");
    return res.json({ data: (Array.isArray(data) ? data : []).map((row) => toPublicOpportunity(row, today)) });
  } catch (error) {
    console.error("Public opportunities read threw:", error);
    return res.status(500).json({ error: "Failed to load opportunities." });
  }
}

// ─── Staff ───────────────────────────────────────────────────────────────────

export async function listStaffOpportunities(_req: Request, res: Response) {
  try {
    const { data, error } = await supabase
      .from("opportunities")
      .select(STAFF_COLUMNS)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("Staff opportunities read failed:", error);
      return res.status(500).json({ error: "Failed to load opportunities." });
    }
    res.set("Cache-Control", "private, no-store");
    const now = new Date();
    return res.json({ data: (data ?? []).map((row) => toStaffOpportunity(row, now)) });
  } catch (error) {
    console.error("Staff opportunities read threw:", error);
    return res.status(500).json({ error: "Failed to load opportunities." });
  }
}

export async function createOpportunity(req: Request, res: Response) {
  const { values, errors } = validateOpportunityInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("opportunities")
      .insert({
        ...values,
        status: values.status ?? "draft",
        created_by: req.user!.id,
        updated_by: req.user!.id,
        last_checked_at: nowIso,
      })
      .select(STAFF_COLUMNS)
      .single();
    if (error || !data) {
      console.error("Opportunity insert failed:", error);
      return res.status(500).json({ error: "Failed to save opportunity." });
    }
    return res.status(201).json({ data: toStaffOpportunity(data) });
  } catch (error) {
    console.error("Opportunity insert threw:", error);
    return res.status(500).json({ error: "Failed to save opportunity." });
  }
}

export async function updateOpportunity(req: Request, res: Response) {
  const id = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: "Opportunity not found." });
  const { values, errors } = validateOpportunityInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (!Object.keys(values).length) return res.status(400).json({ error: "Nothing to update." });
  try {
    const { data, error } = await supabase
      .from("opportunities")
      .update({ ...values, updated_by: req.user!.id, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(STAFF_COLUMNS)
      .maybeSingle();
    if (error) {
      if (error.code === "23514") return res.status(400).json({ error: "Check the dates and link." });
      console.error("Opportunity update failed:", error);
      return res.status(500).json({ error: "Failed to save opportunity." });
    }
    if (!data) return res.status(404).json({ error: "Opportunity not found." });
    return res.json({ data: toStaffOpportunity(data) });
  } catch (error) {
    console.error("Opportunity update threw:", error);
    return res.status(500).json({ error: "Failed to save opportunity." });
  }
}

/** Records that a staff member re-checked the official source today. */
export async function markOpportunityChecked(req: Request, res: Response) {
  const id = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(id)) return res.status(404).json({ error: "Opportunity not found." });
  try {
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("opportunities")
      .update({ last_checked_at: nowIso, updated_by: req.user!.id, updated_at: nowIso })
      .eq("id", id)
      .select(STAFF_COLUMNS)
      .maybeSingle();
    if (error) {
      console.error("Opportunity check failed:", error);
      return res.status(500).json({ error: "Failed to update opportunity." });
    }
    if (!data) return res.status(404).json({ error: "Opportunity not found." });
    return res.json({ data: toStaffOpportunity(data) });
  } catch (error) {
    console.error("Opportunity check threw:", error);
    return res.status(500).json({ error: "Failed to update opportunity." });
  }
}
