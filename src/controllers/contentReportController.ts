import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

/** Reasons a founder can pick when reporting AI output. */
export const AI_REPORT_REASONS = ["offensive", "harmful", "inaccurate", "other"] as const;

const MAX_CONTENT = 2000;
const MAX_DETAILS = 1000;

const clip = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Validates a report body. Returns the row to insert, or an error message.
 * Exported for unit tests.
 */
export function parseAiContentReport(body: any): { row?: Record<string, unknown>; error?: string } {
  const content = clip(body?.content, MAX_CONTENT);
  if (!content) return { error: "Include the AI response you are reporting." };

  const reason = typeof body?.reason === "string" ? body.reason.toLowerCase() : "";
  if (!(AI_REPORT_REASONS as readonly string[]).includes(reason)) {
    return { error: `Reason must be one of: ${AI_REPORT_REASONS.join(", ")}.` };
  }

  const sessionId = Number(body?.sessionId);
  const source = body?.source === "live" || body?.source === "report" ? body.source : null;
  const platform = ["ios", "android", "web"].includes(body?.platform) ? body.platform : null;

  return {
    row: {
      session_id: Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null,
      speaker: clip(body?.speaker, 40),
      content,
      reason,
      details: clip(body?.details, MAX_DETAILS),
      source,
      platform,
    },
  };
}

/**
 * POST /api/reports/ai-content
 * Lets a signed-in founder flag a panel line or report text as offensive,
 * harmful or inaccurate, from inside the app.
 */
export const reportAiContent = async (req: Request, res: Response) => {
  const userId = (req as any).user?.id;
  const { row, error } = parseAiContentReport(req.body);
  if (error || !row) return res.status(400).json({ error });

  // Only link a session the reporter owns; otherwise keep the report unlinked.
  if (row.session_id) {
    const { data: owned } = await supabase
      .from("sessions")
      .select("id")
      .eq("id", row.session_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!owned) row.session_id = null;
  }

  const { error: dbErr } = await supabase
    .from("ai_content_reports")
    .insert({ ...row, user_id: userId ?? null });

  if (dbErr) {
    console.error("❌ Failed to save AI content report:", dbErr.message);
    return res.status(500).json({ error: "Could not submit your report. Please try again." });
  }

  console.warn(
    `🚩 AI content reported by user ${userId} (reason=${row.reason}, session=${row.session_id ?? "n/a"}, source=${row.source ?? "n/a"})`,
  );
  return res.status(201).json({ ok: true, message: "Thanks — our team will review this response." });
};
