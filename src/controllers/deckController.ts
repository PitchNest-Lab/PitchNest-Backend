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

    let extractedText = "";
    if (req.file.mimetype === "application/pdf") {
      try {
        // Dynamic import — pdf-parse is CJS and has no default ESM export
        const pdfParseModule: any = await import("pdf-parse");
        
        if (typeof pdfParseModule.PDFParse === 'function') {
          const parser = new pdfParseModule.PDFParse({ data: req.file.buffer });
          const result = await parser.getText();
          extractedText = result.text || "";
          await parser.destroy();
          console.log("✅ Successfully extracted text from PDF using PDFParse class! Length:", extractedText.length);
        } else {
          console.warn("⚠️ Warning: Could not resolve PDFParse class in pdf-parse module.", pdfParseModule);
        }
      } catch (err) {
        console.warn("⚠️ Warning: Failed to parse PDF text using PDFParse class:", err);
      }
    }

    const { data, error } = await supabase.storage
      .from("pitchnest-media")
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
        .from("pitchnest-media")
        .getPublicUrl(filePath);
      publicUrl = pUrl;
    }

    const insertData: any = { name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY', extracted_text: extractedText };
    if (userId) insertData.user_id = userId;

    let { data: dbData, error: dbError } = await supabase
      .from("decks")
      .insert([insertData])
      .select()
      .single();

    if (dbError) {
      console.error("❌ Primary Supabase insertion failed:", dbError);
      console.warn("⚠️ Warning: Primary insert failed. Executing resilient database insert fallback (omitting optional user_id and extracted_text)...");
      
      const fallbackData = { name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY' };
      let fallback = await supabase.from("decks").insert([fallbackData]).select().single();
      
      if (fallback.error) {
        console.error("❌ Resilient database insert fallback also failed:", fallback.error);
        return res.status(500).json({ error: "Failed to save deck to database (All insertions failed)" });
      }
      
      console.log("✅ Success! Resilient insert fallback successfully saved deck in database!");
      dbData = fallback.data;
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

    let query = supabase
      .from("decks")
      .select("*")
      .order("created_at", { ascending: false });

    // Filter by user_id for data isolation
    if (userId) {
      query = query.eq("user_id", userId);
    }

    let { data: decks, error } = await query;

    if (error) {
      if (error.code === '42703') {
        console.warn("⚠️ Warning: Supabase 'decks' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.");
        const fallback = await supabase
          .from("decks")
          .select("*")
          .order("created_at", { ascending: false });
        if (fallback.error) return res.status(500).json({ error: "Failed to fetch decks" });
        decks = fallback.data;
      } else {
        return res.status(500).json({ error: "Failed to fetch decks" });
      }
    }
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

    if (error) {
      if (error.code === '42703') {
        console.warn("⚠️ Warning: Supabase 'decks' table is missing the 'user_id' column. Please run the SQL migration. Falling back to un-filtered query.");
        const fallback = await supabase
          .from("decks")
          .delete()
          .eq("id", req.params.id);
        if (fallback.error) return res.status(500).json({ error: "Failed to delete deck" });
      } else {
        return res.status(500).json({ error: "Failed to delete deck" });
      }
    }
    res.status(200).json({ success: true });
  } catch (error) { 
    res.status(500).json({ error: "Failed to delete deck" }); 
  }
};
