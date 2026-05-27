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
