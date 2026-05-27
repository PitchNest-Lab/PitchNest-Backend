import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { uploadDir } from "../services/storageService.ts";
import path from "path";
import fs from "fs";

export const uploadDeck = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No deck file provided" });
    
    const userId = req.user?.id;
    const originalName = req.file.originalname.replace(/\s+/g, '_');
    const sizeMB = parseFloat((req.file.size / (1024 * 1024)).toFixed(2));
    const deckName = req.file.originalname.replace(/\.[^/.]+$/, "");
    const filePath = `decks/${Date.now()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from("pitchnest-media")
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: 'half'
      });

    let publicUrl = "";
    if (error) {
      // Local fallback
      const localFileName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localFileName), req.file.buffer);
      publicUrl = `/uploads/${localFileName}`;
    } else {
      const { data: { publicUrl: pUrl } } = supabase.storage
        .from("pitchnest-media")
        .getPublicUrl(filePath);
      publicUrl = pUrl;
    }

    const insertData: any = { name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY' };
    if (userId) insertData.user_id = userId;

    const { data: dbData, error: dbError } = await supabase
      .from("decks")
      .insert([insertData])
      .select()
      .single();

    if (dbError || !dbData) {
      return res.status(500).json({ error: "Failed to save deck to database" });
    }

    res.status(200).json({
      id: dbData.id,
      name: dbData.name,
      file_url: dbData.file_url,
      size: dbData.size,
      status: dbData.status
    });
  } catch (error) { 
    res.status(500).json({ error: "Error uploading deck" }); 
  }
};

export const listDecks = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    let query = supabase
      .from("decks")
      .select("*")
      .order("created_at", { ascending: false });

    // Filter by user_id for data isolation
    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data: decks, error } = await query;

    if (error) return res.status(500).json({ error: "Failed to fetch decks" });
    res.json(decks);
  } catch (error) { 
    res.status(500).json({ error: "Failed to fetch decks" }); 
  }
};

export const deleteDeck = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    let query = supabase
      .from("decks")
      .delete()
      .eq("id", req.params.id);

    // Ensure user can only delete their own decks
    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { error } = await query;

    if (error) return res.status(500).json({ error: "Failed to delete" });
    res.status(200).json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: "Failed to delete" }); 
  }
};
