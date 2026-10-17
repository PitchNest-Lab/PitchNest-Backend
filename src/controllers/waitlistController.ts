import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";

const waitlistFile = path.join(process.cwd(), "waitlist.json");
const surveyFile = path.join(process.cwd(), "survey-responses.json");
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

function cleanSurveyAnswer(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const answer = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return answer ? answer.slice(0, 500) : undefined;
}

async function readJsonArray<T>(file: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(file, "utf-8"));
    return Array.isArray(parsed) ? parsed.slice(-10_000) : [];
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("Local development submission file is invalid:", error);
    }
    return [];
  }
}

/** Add one email to the waitlist without exposing whether it was already present. */
export const handleWaitlist = async (req: Request, res: Response) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    if (!cleanEmail) {
      return res.status(400).json({ error: "Please provide a valid email." });
    }

    const { error } = await supabase.from("waitlist").insert([{ email: cleanEmail }]);

    // PostgreSQL unique violation means this address is already registered and
    // gets the same response, avoiding a public email-enumeration oracle.
    if (error && error.code !== "23505") {
      console.error("Waitlist insert failed:", error);
      // Never put email addresses on a production instance's ephemeral disk.
      // The file fallback exists only to keep local UI development convenient.
      if (config.nodeEnv === "production") {
        return res.status(503).json({
          error: "Waitlist is temporarily unavailable. Please retry.",
        });
      }
      const list = await readJsonArray<string>(waitlistFile);
      if (!list.includes(cleanEmail)) list.push(cleanEmail);
      await fs.promises.writeFile(
        waitlistFile,
        JSON.stringify(list.slice(-10_000), null, 2),
        "utf-8",
      );
    }

    res.status(200).json({ success: true, message: "Thank you for signing up!" });
  } catch (error) {
    console.error("Waitlist error:", error);
    res.status(500).json({ error: "Failed to sign up." });
  }
};

/** Upsert bounded survey answers for a waitlist email. */
export const handleSurvey = async (req: Request, res: Response) => {
  try {
    const cleanEmail = normalizeEmail(req.body?.email);
    if (!cleanEmail) {
      return res.status(400).json({ error: "Please provide a valid email." });
    }

    const row: Record<string, string> = { email: cleanEmail };
    const pitchType = cleanSurveyAnswer(req.body?.pitch_type);
    const frustration = cleanSurveyAnswer(req.body?.frustration);
    const nextPitch = cleanSurveyAnswer(req.body?.next_pitch);
    if (pitchType) row.pitch_type = pitchType;
    if (frustration) row.frustration = frustration;
    if (nextPitch) row.next_pitch = nextPitch;

    const { error } = await supabase
      .from("waitlist")
      .upsert([row], { onConflict: "email" });

    if (error) {
      console.error("Survey upsert failed:", error);
      if (config.nodeEnv === "production") {
        return res.status(503).json({
          error: "Survey is temporarily unavailable. Please retry.",
        });
      }
      const list = await readJsonArray<Record<string, string>>(surveyFile);
      const index = list.findIndex((item) => item.email === cleanEmail);
      if (index >= 0) list[index] = { ...list[index], ...row };
      else list.push(row);
      await fs.promises.writeFile(
        surveyFile,
        JSON.stringify(list.slice(-10_000), null, 2),
        "utf-8",
      );
    }

    res.status(200).json({ success: true, message: "Survey submitted successfully!" });
  } catch (error) {
    console.error("Survey error:", error);
    res.status(500).json({ error: "Failed to submit survey." });
  }
};
