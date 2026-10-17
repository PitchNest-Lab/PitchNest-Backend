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
 * Internal transcript review for an authenticated, revocable staff account.
 *
 * Returns full session transcripts ACROSS ALL USERS so the team can study how the
 * AI converses across pitch industries. This is intentionally unscoped (no
 * user_id filter) — that is the whole point of the endpoint, and it is why it
 * sits behind authMiddleware + requireStaff.
 *
 * Founder users have no route to this; regular session endpoints stay owner-
 * scoped. The response is deliberately minimal: transcript text + the metadata
 * needed to slice by industry/mode. No emails, no scores, no video URLs.
 *
 * Pagination: ?limit (default 25, max 50) and ?offset. Optional ?mode filter.
 */
export const listAllTranscripts = async (req: Request, res: Response) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(50, Math.max(1, requestedLimit))
      : 25;
    const offset = Number.isSafeInteger(requestedOffset)
      ? Math.min(100_000, Math.max(0, requestedOffset))
      : 0;
    const mode = typeof req.query.mode === "string" ? req.query.mode : "";
    if (mode && !["panel", "coach", "solo"].includes(mode)) {
      return res.status(400).json({ error: "Invalid session mode" });
    }

    let query = supabase
      .from("sessions")
      .select("id, business_name, mode, pitch_config, evaluation_report, created_at, timestamp")
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
        evaluationStatus: report.evaluationStatus || null,
        transcript: Array.isArray(report.transcript) ? report.transcript : [],
      };
    });

    // Refuse disclosure if the durable access record cannot be written. This
    // log contains no transcript content or founder identifier.
    const { error: auditError } = await supabase.from("staff_data_access_log").insert([{
      staff_user_id: req.user!.id,
      action: "transcript_review",
      result_count: rows.length,
      query_details: { offset, limit, mode: mode || null },
    }]);
    if (auditError) {
      console.error("Staff transcript access audit failed:", auditError.message);
      return res.status(503).json({ error: "Transcript review is temporarily unavailable" });
    }

    // Keep an operational log without copying confidential transcript content.
    console.info("Staff transcript review", {
      staffUserId: req.user?.id,
      resultCount: rows.length,
      offset,
      mode: mode || null,
    });

    res.json({ count: rows.length, limit, offset, transcripts: rows });
  } catch (err: any) {
    console.error("❌ admin listAllTranscripts exception:", err?.message || err);
    res.status(500).json({ error: "Failed to fetch transcripts" });
  }
};
