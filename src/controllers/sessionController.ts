import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

export const listSessions = async (req: Request, res: Response) => {
  try {
    const { data: sessions, error } = await supabase
      .from("sessions")
      .select("*")
      .order("timestamp", { ascending: false });

    if (error) return res.status(500).json({ error: "Failed to fetch sessions" });

    const formatted = sessions.map((s: any) => ({
      ...s,
      evaluation_report: typeof s.evaluation_report === 'string'
        ? JSON.parse(s.evaluation_report)
        : s.evaluation_report
    }));
    res.json(formatted);
  } catch (error) { 
    res.status(500).json({ error: "Failed to fetch sessions" }); 
  }
};

export const getSession = async (req: Request, res: Response) => {
  try {
    const { data: session, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error || !session) return res.status(404).json({ error: "Session not found" });

    const formatted = {
      ...session,
      evaluation_report: typeof session.evaluation_report === 'string'
        ? JSON.parse(session.evaluation_report)
        : session.evaluation_report
    };
    res.json(formatted);
  } catch (error) { 
    res.status(500).json({ error: "Failed to fetch session" }); 
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: "Failed to delete session" });
    res.status(200).json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: "Failed to delete session" }); 
  }
};
