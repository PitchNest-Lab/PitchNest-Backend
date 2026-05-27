import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { uploadDir } from "../services/storageService.ts";
import path from "path";
import fs from "fs";

export const uploadVideo = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file provided" });
    
    const originalName = req.file.originalname || `pitch.webm`;
    const filePath = `pitches/${Date.now()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from("pitchnest-media")
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
      .from("pitchnest-media")
      .getPublicUrl(filePath);

    res.status(200).json({ videoUrl: publicUrl });
  } catch (error) { 
    res.status(500).json({ error: "Upload failed" }); 
  }
};
