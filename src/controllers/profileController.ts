import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

/**
 * Save or update user profile (onboarding data).
 * Upserts into the `profiles` table keyed by user_id.
 */
export const saveProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required." });

    const { startup_name, industry, goal, funding_stage } = req.body;

    // Upsert: insert if not exists, update if exists
    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        { user_id: userId, startup_name, industry, goal, funding_stage },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (error) {
      console.error("❌ Profile save error:", error);
      return res.status(500).json({ error: "Failed to save profile." });
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("❌ Profile save exception:", error);
    res.status(500).json({ error: "Failed to save profile." });
  }
};

/**
 * Get the authenticated user's profile.
 */
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required." });

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Profile fetch error:", error);
      return res.status(500).json({ error: "Failed to fetch profile." });
    }

    // Return empty object if no profile exists yet (user hasn't onboarded)
    res.status(200).json(data || {});
  } catch (error) {
    console.error("❌ Profile fetch exception:", error);
    res.status(500).json({ error: "Failed to fetch profile." });
  }
};
