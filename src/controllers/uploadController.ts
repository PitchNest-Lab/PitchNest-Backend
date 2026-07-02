import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { uploadDir } from "../services/storageService.ts";
import path from "path";
import fs from "fs";

export const uploadVideo = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });

    const originalName = req.file.originalname || `pitch.webm`;
    const filePath = `pitches/${Date.now()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from(config.storageBucket)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: 'half'
      });

    if (error) {
      // Local fallback if Supabase Storage has an issue
      const localName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localName), req.file.buffer);
      return res.status(200).json({ videoUrl: `/uploads/${localName}` });
    }

    const { data: { publicUrl } } = supabase.storage
      .from(config.storageBucket)
      .getPublicUrl(filePath);

    res.status(200).json({ videoUrl: publicUrl });
  } catch (error) {
    res.status(500).json({ error: "Upload failed" });
  }
};

/**
 * POST /api/upload-avatar — store a user's profile image in Supabase Storage and
 * persist its public URL on the user row (users.avatar_url, migration 0003).
 * Replaces the old base64-in-localStorage approach so avatars are real, shared
 * across devices, and survive a cache clear. Returns { avatarUrl }.
 */
export const uploadAvatar = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file provided" });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image." });
    }

    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const ext = (req.file.originalname.split(".").pop() || "png")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const filePath = `avatars/${userId}_${Date.now()}.${ext || "png"}`;

    const { error } = await supabase.storage
      .from(config.storageBucket)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
        duplex: "half",
      });

    if (error) {
      console.error("❌ Avatar storage upload failed:", error);
      return res.status(500).json({ error: "Failed to upload image." });
    }

    const { data: { publicUrl } } = supabase.storage
      .from(config.storageBucket)
      .getPublicUrl(filePath);

    const { error: dbError } = await supabase
      .from("users")
      .update({ avatar_url: publicUrl })
      .eq("id", userId);

    if (dbError) {
      console.error("❌ Avatar DB update failed:", dbError);
      return res.status(500).json({
        error:
          "Image uploaded but could not be saved. Ensure the avatar_url column exists (migration 0003).",
      });
    }

    res.status(200).json({ avatarUrl: publicUrl });
  } catch (error) {
    console.error("❌ uploadAvatar error:", error);
    res.status(500).json({ error: "Upload failed" });
  }
};
