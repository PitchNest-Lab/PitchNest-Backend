import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";

/**
 * Save or update user profile (onboarding data).
 * Upserts into the `profiles` table keyed by user_id.
 */
export const saveProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId)
      return res.status(401).json({ error: "Authentication required." });

    const { startup_name, industry, goal, funding_stage } = req.body;

    // Server-side validation — enforce types and length limits.
    const MAX_FIELD_LEN = 200;
    for (const [name, val] of Object.entries({ startup_name, industry, goal, funding_stage })) {
      if (val !== undefined && val !== null && val !== "") {
        if (typeof val !== "string") {
          return res.status(400).json({ error: `${name} must be text.` });
        }
        if ((val as string).length > MAX_FIELD_LEN) {
          return res.status(400).json({ error: `${name} is too long (max ${MAX_FIELD_LEN} characters).` });
        }
      }
    }

    // Upsert: insert if not exists, update if exists
    const { data, error } = await supabase
      .from("profiles")
      .upsert(
        { user_id: userId, startup_name, industry, goal, funding_stage },
        { onConflict: "user_id" },
      )
      .select()
      .single();

    await supabase
      .from("users")
      .update({
        onboardingCompleted: true,
      })
      .eq("id", userId);

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

export const skipOnbording = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    let data = await supabase
      .from("users")
      .update({
        onboardingCompleted: true,
      })
      .eq("id", userId);

    res.status(200).json(data);
  } catch (error) {
    console.error("❌ skip onboarding exception:", error);
    res.status(500).json({ error: "Failed to save profile." });
  }
};

/**
 * Get the authenticated user's profile.
 */
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId)
      return res.status(401).json({ error: "Authentication required." });

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
