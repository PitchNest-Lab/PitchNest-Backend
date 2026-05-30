import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import crypto from "crypto";

/**
 * Safely parses stringified JSON structures, falling back to a structured object 
 * containing the string text in case of database corruptions or plain text logs.
 */
const safeParseJSON = (val: any) => {
  if (!val) return {
    summary: "No evaluation details available.",
    scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
    strengths: [], risks: [], next_steps: [], sentiments: []
  };
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch (e: any) {
    console.warn("⚠️ Failed to parse session JSON, using fallback report structure:", e.message);
    return {
      summary: val || "No evaluation details available.",
      scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
      strengths: [],
      risks: [],
      next_steps: [],
      sentiments: []
    };
  }
};

export const listSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    let query = supabase
      .from("sessions")
      .select("*")
      .order("created_at", { ascending: false });

    // Filter by user_id if authenticated (data isolation)
    if (userId) {
      query = query.eq("user_id", userId);
    }

    let { data: sessions, error } = await query;

    if (error) {
      if (error.code === '42703') {
        console.warn("⚠️ Warning: Supabase 'sessions' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.");
        const fallback = await supabase
          .from("sessions")
          .select("*")
          .order("created_at", { ascending: false });
        if (fallback.error) return res.status(500).json({ error: "Failed to fetch sessions" });
        sessions = fallback.data;
      } else {
        return res.status(500).json({ error: "Failed to fetch sessions" });
      }
    }

    const formatted = (sessions || []).map((s: any) => ({
      ...s,
      evaluation_report: safeParseJSON(s.evaluation_report)
    }));
    res.json(formatted);
  } catch (error: any) { 
    console.error("❌ listSessions error:", error.message || error);
    res.status(500).json({ error: "Failed to fetch sessions" }); 
  }
};

export const getSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const identifier = req.params.id;

    let query = supabase.from("sessions").select("*");

    // If identifier is a valid UUID, treat it as share_id and allow public access
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    
    if (isUUID) {
      query = query.eq("share_id", identifier);
    } else {
      query = query.eq("id", identifier);
      // Ensure user can only access their own sessions if not using the public share link
      if (userId) {
        query = query.eq("user_id", userId);
      }
    }

    const { data: session, error } = await query.maybeSingle();

    if (error) {
      if (error.code === '42703') {
        console.warn("⚠️ Warning: Supabase 'sessions' table is missing columns. Falling back to simple query.");
        const fallback = await supabase
          .from("sessions")
          .select("*")
          .eq("id", identifier)
          .maybeSingle();
        if (fallback.error || !fallback.data) return res.status(404).json({ error: "Session not found" });
        
        const formatted = {
          ...fallback.data,
          evaluation_report: safeParseJSON(fallback.data.evaluation_report)
        };
        return res.json(formatted);
      } else {
        return res.status(404).json({ error: "Session not found" });
      }
    } else if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const formatted = {
      ...session,
      evaluation_report: safeParseJSON(session.evaluation_report)
    };
    res.json(formatted);
  } catch (error: any) { 
    console.error("❌ getSession error:", error.message || error);
    res.status(500).json({ error: "Failed to fetch session" }); 
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    let query = supabase
      .from("sessions")
      .delete()
      .eq("id", req.params.id);

    // Ensure user can only delete their own sessions
    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { error } = await query;

    if (error) {
      if (error.code === '42703') {
        console.warn("⚠️ Warning: Supabase 'sessions' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.");
        const fallback = await supabase
          .from("sessions")
          .delete()
          .eq("id", req.params.id);
        if (fallback.error) return res.status(500).json({ error: "Failed to delete session" });
      } else {
        return res.status(500).json({ error: "Failed to delete session" });
      }
    }
    res.status(200).json({ success: true });
  } catch (error: any) { 
    console.error("❌ deleteSession error:", error.message || error);
    res.status(500).json({ error: "Failed to delete session" }); 
  }
};
