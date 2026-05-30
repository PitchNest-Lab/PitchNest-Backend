import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import crypto from "crypto";

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

    let query = supabase
      .from("sessions")
      .select("*")
      .order("timestamp", { ascending: false });

    // Filter by user_id if authenticated (data isolation)
    if (userId) {
      query = query.eq("user_id", userId);
    }

    let { data: sessions, error } = await query;
    // console.log(sessions)
    

    if (error) {
      console.error("❌ Supabase query error in listSessions:", error);
      if (error.code === "42703") {
        console.warn(
          "⚠️ Warning: Supabase 'sessions' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.",
        );
        const fallback = await supabase
          .from("sessions")
          .select("*")
          .order("timestamp", { ascending: false });
        if (fallback.error) {
          console.error(
            "❌ Supabase fallback query error in listSessions:",
            fallback.error,
          );
          return res.status(500).json({ error: "Failed to fetch sessions" });
        }
        sessions = fallback.data;
      } else {
        return res.status(500).json({ error: "Failed to fetch sessions" });
      }
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

    let query = supabase.from("sessions").select("*");

    // If identifier is a valid UUID, treat it as share_id and allow public access
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );

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
      console.error("❌ Supabase query error in getSession:", error);
      if (error.code === "42703") {
        console.warn(
          "⚠️ Warning: Supabase 'sessions' table is missing columns. Falling back to simple query.",
        );
        const fallback = await supabase
          .from("sessions")
          .select("*")
          .eq("id", identifier)
          .maybeSingle();
        if (fallback.error) {
          console.error(
            "❌ Supabase fallback query error in getSession:",
            fallback.error,
          );
          return res.status(404).json({ error: "Session not found" });
        }
        if (!fallback.data)
          return res.status(404).json({ error: "Session not found" });

        const formatted = {
          ...fallback.data,
          created_at: fallback.data.created_at || fallback.data.timestamp,
          evaluation_report: safeParseJSON(fallback.data.evaluation_report),
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

    let query = supabase.from("sessions").delete().eq("id", req.params.id);

    // Ensure user can only delete their own sessions
    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { error } = await query;

    if (error) {
      console.error("❌ Supabase query error in deleteSession:", error);
      if (error.code === "42703") {
        console.warn(
          "⚠️ Warning: Supabase 'sessions' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.",
        );
        const fallback = await supabase
          .from("sessions")
          .delete()
          .eq("id", req.params.id);
        if (fallback.error) {
          console.error(
            "❌ Supabase fallback query error in deleteSession:",
            fallback.error,
          );
          return res.status(500).json({ error: "Failed to delete session" });
        }
      } else {
        return res.status(500).json({ error: "Failed to delete session" });
      }
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

    const { business_name, evaluation_report, video_url = "" } = req.body;

    const share_id = crypto.randomUUID();

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        business_name,
        evaluation_report,
        video_url,
        user_id:userId
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
