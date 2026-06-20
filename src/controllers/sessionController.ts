import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import crypto from "crypto";
import { generatePitchReportPDF } from "../services/pdfService.ts";

/**
 * Safely parses stringified JSON structures, falling back to a structured object
 * containing the string text in case of database corruptions or plain text logs.
 */
const safeParseJSON = (val: any) => {
  if (!val)
    return {
      summary: "No evaluation details available.",
      scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
      strengths: [],
      risks: [],
      next_steps: [],
      sentiments: [],
    };
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch (e: any) {
    console.warn(
      "⚠️ Failed to parse session JSON, using fallback report structure:",
      e.message,
    );
    return {
      summary: val || "No evaluation details available.",
      scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
      strengths: [],
      risks: [],
      next_steps: [],
      sentiments: [],
    };
  }
};

export const listSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: sessions, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("user_id", userId)
      .order("timestamp", { ascending: false });

    if (error) {
      console.error("❌ Supabase query error in listSessions:", error);
      return res.status(500).json({ error: "Failed to fetch sessions" });
    }

    const formatted = (sessions || []).map((s: any) => ({
      ...s,
      created_at: s.created_at || s.timestamp,
      evaluation_report: safeParseJSON(s.evaluation_report),
    }));
    res.json(formatted);
  } catch (error: any) {
    console.error("❌ listSessions exception:", error.message || error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

export const getSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const identifier = req.params.id;

    // Check if identifier is a valid UUID (if so, treat as a public share link)
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );

    let query = supabase.from("sessions").select("*");

    if (isUUID) {
      query = query.eq("share_id", identifier);
    } else {
      query = query.eq("id", identifier);
      if (!userId) {
        return res.status(401).json({ error: "Authentication required" });
      }
      query = query.eq("user_id", userId);
    }

    const { data: session, error } = await query.maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getSession:", error);
      return res.status(500).json({ error: "Failed to query session" });
    } else if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const formatted = {
      ...session,
      created_at: session.created_at || session.timestamp,
      evaluation_report: safeParseJSON(session.evaluation_report),
    };
    res.json(formatted);
  } catch (error: any) {
    console.error("❌ getSession exception:", error.message || error);
    res.status(500).json({ error: "Failed to fetch session" });
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ Supabase query error in deleteSession:", error);
      return res.status(500).json({ error: "Failed to delete session" });
    }
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("❌ deleteSession exception:", error.message || error);
    res.status(500).json({ error: "Failed to delete session" });
  }
};

export const createSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { business_name, evaluation_report, video_url = "" } = req.body;
    const share_id = crypto.randomUUID();

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        business_name,
        evaluation_report,
        video_url,
        user_id: userId,
        share_id: share_id
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Supabase createSession error:", error);
      return res.status(500).json({
        error: "Failed to create session",
      });
    }

    res.status(201).json(data);
  } catch (error: any) {
    console.error("❌ createSession exception:", error);
    res.status(500).json({
      error: "Failed to create session",
    });
  }
};

export const generateSessionPDF = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // 1. Try to fetch cached PDF from session_pdfs table
    const { data: cached, error: cacheError } = await supabase
      .from("session_pdfs")
      .select("pdf_base64")
      .eq("session_id", req.params.id)
      .maybeSingle();

    let pdfBuffer: Buffer;
    let businessName = "Pitch_Report";

    if (!cacheError && cached?.pdf_base64) {
      console.log(`📦 Serving cached PDF for session ID ${req.params.id}`);
      pdfBuffer = Buffer.from(cached.pdf_base64, "base64");
      
      // Fetch minimal session details to get the correct filename
      const { data: session } = await supabase
        .from("sessions")
        .select("business_name")
        .eq("id", req.params.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (session?.business_name) {
        businessName = session.business_name;
      }
    } else {
      console.log(`🔨 PDF cache miss. Generating PDF on-demand for session ID ${req.params.id}`);
      // 2. Fetch session if not cached
      const { data: session, error } = await supabase
        .from("sessions")
        .select("*")
        .eq("id", req.params.id)
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("❌ Supabase query error in generateSessionPDF:", error);
        return res.status(500).json({ error: "Failed to query session" });
      }
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const formatted = {
        ...session,
        created_at: session.created_at || session.timestamp,
        evaluation_report:
          typeof session.evaluation_report === "string"
            ? (() => { try { return JSON.parse(session.evaluation_report); } catch { return session.evaluation_report; } })()
            : session.evaluation_report,
      };

      pdfBuffer = await generatePitchReportPDF(formatted);
      businessName = formatted.business_name || "Pitch_Report";

      // 3. Cache generated PDF in database asynchronously
      const base64Pdf = pdfBuffer.toString("base64");
      supabase
        .from("session_pdfs")
        .insert([{ session_id: req.params.id, pdf_base64: base64Pdf }])
        .then(({ error: insertErr }) => {
          if (insertErr) {
            console.warn(`⚠️ Failed to cache generated PDF for session ${req.params.id}:`, insertErr.message);
          } else {
            console.log(`✅ Cached generated PDF for session ${req.params.id}`);
          }
        });
    }

    const safeName = businessName
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .replace(/\s+/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="PitchNest_Report_${safeName}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error: any) {
    console.error("❌ generateSessionPDF exception:", error.message || error);
    res.status(500).json({ error: "Failed to generate PDF report" });
  }
};
