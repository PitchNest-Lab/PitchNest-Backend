import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

const safeParseReport = (val: any) => {
  if (!val) return {};
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return {};
  }
};

/**
 * Item C — internal transcript review (admin-only, gated by adminMiddleware).
 *
 * Returns full session transcripts ACROSS ALL USERS so the team can study how the
 * AI converses across pitch industries. This is intentionally unscoped (no
 * user_id filter) — that is the whole point of the endpoint, and it is why it
 * sits behind the shared admin key, never the normal auth path.
 *
 * Founder users have no route to this; regular session endpoints stay owner-
 * scoped. The response is deliberately minimal: transcript text + the metadata
 * needed to slice by industry/mode. No emails, no scores, no video URLs.
 *
 * Pagination: ?limit (default 50, max 200) and ?offset. Optional ?mode filter.
 */
export const listAllTranscripts = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(
      200,
      Math.max(1, Number(req.query.limit) || 50),
    );
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const mode = typeof req.query.mode === "string" ? req.query.mode : "";

    let query = supabase
      .from("sessions")
      .select("id, business_name, mode, pitch_config, evaluation_report, created_at, timestamp, user_id")
      .order("timestamp", { ascending: false })
      .range(offset, offset + limit - 1);

    if (mode) query = query.eq("mode", mode);

    const { data, error } = await query;
    if (error) {
      console.error("❌ admin listAllTranscripts query error:", error);
      return res.status(500).json({ error: "Failed to fetch transcripts" });
    }

    const rows = (data || []).map((s: any) => {
      const report = safeParseReport(s.evaluation_report);
      return {
        id: s.id,
        business_name: s.business_name,
        mode: s.mode || report.mode || "panel",
        // pitch_config carries industry / archetype / funding stage — the fields
        // the founder wants to slice conversations by.
        pitch_config: s.pitch_config || null,
        created_at: s.created_at || s.timestamp,
        user_id: s.user_id ?? null,
        evaluationStatus: report.evaluationStatus || null,
        transcript: Array.isArray(report.transcript) ? report.transcript : [],
      };
    });

    res.json({ count: rows.length, limit, offset, transcripts: rows });
  } catch (err: any) {
    console.error("❌ admin listAllTranscripts exception:", err?.message || err);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
};
