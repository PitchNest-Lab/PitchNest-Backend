import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import fs from "fs";
import path from "path";

// Waitlist local fallback file path
const waitlistFile = path.join(process.cwd(), "waitlist.json");

/**
 * Handle waitlist signups.
 * Attempts to save to Supabase table `waitlist`, falling back to local waitlist.json.
 */
export const handleWaitlist = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Please provide a valid email." });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Try Supabase insert
    const { error } = await supabase
      .from("waitlist")
      .insert([{ email: cleanEmail }]);

    if (error) {
      console.warn("⚠️ Warning: Supabase 'waitlist' table is missing. Saving to local waitlist.json instead.");
      
      // Fallback: save to local waitlist.json
      let list: string[] = [];
      if (fs.existsSync(waitlistFile)) {
        try {
          list = JSON.parse(fs.readFileSync(waitlistFile, "utf-8"));
        } catch (e) {}
      }
      if (!list.includes(cleanEmail)) {
        list.push(cleanEmail);
        fs.writeFileSync(waitlistFile, JSON.stringify(list, null, 2));
      }
    }

    res.status(200).json({ success: true, message: "Thank you for signing up!" });
  } catch (error) {
    console.error("❌ Waitlist error:", error);
    res.status(500).json({ error: "Failed to sign up." });
  }
};

/**
 * Handle survey submissions.
 * Upserts into Supabase `waitlist` table with survey-specific fields
 * (pitch_type, frustration, next_pitch) using on_conflict=email.
 */
export const handleSurvey = async (req: Request, res: Response) => {
  try {
    const { email, pitch_type, frustration, next_pitch } = req.body;

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Please provide a valid email." });
    }

    const cleanEmail = email.toLowerCase().trim();

    const row: Record<string, string> = { email: cleanEmail };
    if (pitch_type) row.pitch_type = pitch_type;
    if (frustration) row.frustration = frustration;
    if (next_pitch) row.next_pitch = next_pitch;

    // Upsert so repeat submissions update existing rows
    const { error } = await supabase
      .from("waitlist")
      .upsert([row], { onConflict: "email" });

    if (error) {
      console.error("❌ Supabase survey upsert error:", error);

      // Fallback: save to local file
      const surveyFile = path.join(process.cwd(), "survey-responses.json");
      let list: Record<string, string>[] = [];
      if (fs.existsSync(surveyFile)) {
        try {
          list = JSON.parse(fs.readFileSync(surveyFile, "utf-8"));
        } catch (e) {}
      }
      // Replace existing entry for the same email, or add new
      const idx = list.findIndex((item) => item.email === cleanEmail);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...row };
      } else {
        list.push(row);
      }
      fs.writeFileSync(surveyFile, JSON.stringify(list, null, 2));
    }

    res.status(200).json({ success: true, message: "Survey submitted successfully!" });
  } catch (error) {
    console.error("❌ Survey error:", error);
    res.status(500).json({ error: "Failed to submit survey." });
  }
};
