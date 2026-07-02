import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
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

    let extractedText = "";
    if (req.file.mimetype === "application/pdf") {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: req.file.buffer });
        const result = await parser.getText();
        extractedText = (result.text || "").replace(/\s{2,}/g, " ").trim();
        await parser.destroy();
        console.log("✅ Extracted PDF text. Length:", extractedText.length);
      } catch (err) {
        console.warn("⚠️ Failed to parse PDF text:", err);
      }
    } else if (
      req.file.mimetype === "text/plain" ||
      originalName.endsWith(".txt") ||
      originalName.endsWith(".md")
    ) {
      extractedText = req.file.buffer.toString("utf-8").replace(/\s{2,}/g, " ").trim();
      console.log("✅ Extracted plain-text deck. Length:", extractedText.length);
    }

    const { data, error } = await supabase.storage
      .from(config.storageBucket)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
        duplex: 'half'
      });

    let publicUrl = "";
    if (error) {
      console.warn("⚠️ Supabase storage upload failed, using local fallback. Storage Error:", error);
      // Local fallback
      const localFileName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localFileName), req.file.buffer);
      publicUrl = `/uploads/${localFileName}`;
    } else {
      const { data: { publicUrl: pUrl } } = supabase.storage
        .from(config.storageBucket)
        .getPublicUrl(filePath);
      publicUrl = pUrl;
    }

    const insertData: any = { 
      name: deckName, 
      file_url: publicUrl, 
      size: sizeMB, 
      status: 'READY', 
      extracted_text: extractedText,
      user_id: userId
    };

    const { data: dbData, error: dbError } = await supabase
      .from("decks")
      .insert([insertData])
      .select()
      .single();

    if (dbError) {
      console.error("❌ Supabase insertion failed in uploadDeck:", dbError);
      return res.status(500).json({ error: "Failed to save deck to database" });
    }

    res.status(200).json({
      id: dbData.id,
      name: dbData.name,
      file_url: dbData.file_url,
      size: dbData.size,
      status: dbData.status,
      extracted_text: extractedText
    });
  } catch (error) { 
    console.error("❌ Fatal error in uploadDeck controller:", error);
    res.status(500).json({ error: "Error uploading deck (Fatal exception)" }); 
  }
};

export const listDecks = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: decks, error } = await supabase
      .from("decks")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Supabase query error in listDecks:", error);
      return res.status(500).json({ error: "Failed to fetch decks" });
    }
    res.json(decks);
  } catch (error) { 
    console.error("❌ listDecks exception:", error);
    res.status(500).json({ error: "Failed to fetch decks" }); 
  }
};

export const deleteDeck = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { error } = await supabase
      .from("decks")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ Supabase query error in deleteDeck:", error);
      return res.status(500).json({ error: "Failed to delete deck" });
    }
    res.status(200).json({ success: true });
  } catch (error) { 
    console.error("❌ deleteDeck exception:", error);
    res.status(500).json({ error: "Failed to delete deck" }); 
  }
};
