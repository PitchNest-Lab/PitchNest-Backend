import type { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { removePublicMedia } from "../services/businessMediaService.ts";

/**
 * Staff moderation queue for Discover. Mounted behind authMiddleware and
 * requireStaff. Every state change happens inside a database function from
 * migration 0021, which also writes business_audit_log.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
const NOTE_MAX = 500;

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toStaffReport(row: any) {
  return {
    id: row.report_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    details: row.details ?? "",
    status: row.report_status,
    createdAt: iso(row.created_at),
    resolvedAt: iso(row.resolved_at),
    resolutionNote: row.resolution_note ?? "",
    openReportsForEntity: Number(row.open_reports_for_entity) || 0,
    // Community reports (threads, replies) have no business.
    business: row.business_id
      ? {
          id: row.business_id,
          name: row.business_name,
          slug: row.business_slug,
          status: row.business_status,
        }
      : null,
    comment:
      row.entity_type === "comment"
        ? { body: row.comment_body ?? "", status: row.comment_status ?? "removed" }
        : null,
    community:
      row.entity_type === "thread" || row.entity_type === "reply"
        ? {
            threadId: row.thread_id ?? null,
            threadTitle: row.thread_title ?? "",
            body: row.community_body ?? "",
            status: row.community_status ?? "removed",
          }
        : null,
    pitch:
      row.entity_type === "pitch"
        ? {
            headline: row.pitch_headline ?? "",
            body: row.pitch_body ?? "",
            status: row.pitch_status ?? "removed",
          }
        : null,
  };
}

function cleanNote(value: unknown): { note: string | null; error?: string } {
  if (value === undefined || value === null || value === "") return { note: null };
  if (typeof value !== "string") return { note: null, error: "Note must be text." };
  const note = value.trim();
  if (note.length > NOTE_MAX) return { note: null, error: `Note can be up to ${NOTE_MAX} characters.` };
  return { note: note || null };
}

export async function listReports(req: Request, res: Response) {
  const status = typeof req.query.status === "string" ? req.query.status : "open";
  if (!REPORT_STATUSES.includes(status as any)) {
    return res.status(400).json({ error: "Invalid report status." });
  }
  try {
    const { data, error } = await supabase.rpc("staff_list_reports", {
      p_status: status,
      p_limit: 100,
    });
    if (error) {
      console.error("Moderation queue read failed:", error);
      return res.status(500).json({ error: "Failed to load reports." });
    }
    res.set("Cache-Control", "private, no-store");
    return res.json({ data: (Array.isArray(data) ? data : []).map(toStaffReport) });
  } catch (error) {
    console.error("Moderation queue read threw:", error);
    return res.status(500).json({ error: "Failed to load reports." });
  }
}

export async function resolveReport(req: Request, res: Response) {
  const reportId = String(req.params.reportId || "").trim();
  if (!UUID_PATTERN.test(reportId)) return res.status(404).json({ error: "Report not found." });

  const action = req.body?.action;
  if (action !== "hide" && action !== "dismiss") {
    return res.status(400).json({ error: "Action must be hide or dismiss." });
  }
  const { note, error: noteError } = cleanNote(req.body?.note);
  if (noteError) return res.status(400).json({ error: noteError });

  try {
    // Public storage URLs remain usable independently of the database row.
    // Remove a business's public objects before the database hide, and fail
    // closed if storage is unavailable so moderation cannot report a partial
    // takedown as successful.
    if (action === "hide") {
      const { data: pendingReport, error: reportError } = await supabase
        .from("content_reports")
        .select("entity_type, entity_id, status")
        .eq("id", reportId)
        .maybeSingle();
      if (reportError) {
        console.error("Moderation report preflight failed:", reportError);
        return res.status(503).json({ error: "Could not verify the report. Please retry." });
      }
      if (!pendingReport) return res.status(404).json({ error: "Report not found." });
      if (pendingReport.status !== "open") {
        return res.status(409).json({ error: "This report was already resolved." });
      }
      if (pendingReport.entity_type === "business" && typeof pendingReport.entity_id === "string") {
        if (!(await removePublicMedia(pendingReport.entity_id))) {
          return res.status(503).json({ error: "Could not remove public images. Please retry." });
        }
      }
    }

    const { data, error } = await supabase.rpc("staff_resolve_report", {
      p_report_id: reportId,
      p_actor_id: req.user!.id,
      p_action: action,
      p_note: note,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Report not found." });
      if (error.code === "55000") return res.status(409).json({ error: "This report was already resolved." });
      console.error("Report resolution failed:", error);
      return res.status(500).json({ error: "Failed to resolve report." });
    }
    return res.json({ data: { resolved: true } });
  } catch (error) {
    console.error("Report resolution threw:", error);
    return res.status(500).json({ error: "Failed to resolve report." });
  }
}

export async function restoreContent(req: Request, res: Response) {
  const entityType = req.body?.entityType;
  const entityId = String(req.body?.entityId || "").trim();
  if (!["comment", "business", "thread", "reply", "pitch"].includes(entityType) || !UUID_PATTERN.test(entityId)) {
    return res.status(400).json({ error: "Choose an item to restore." });
  }
  try {
    const { error } = await supabase.rpc("staff_restore_content", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_actor_id: req.user!.id,
    });
    if (error) {
      if (error.code === "P0002") return res.status(404).json({ error: "Nothing to restore." });
      console.error("Content restore failed:", error);
      return res.status(500).json({ error: "Failed to restore content." });
    }
    return res.json({ data: { restored: true } });
  } catch (error) {
    console.error("Content restore threw:", error);
    return res.status(500).json({ error: "Failed to restore content." });
  }
}
