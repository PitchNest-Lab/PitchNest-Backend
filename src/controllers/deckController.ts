import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { uploadDir } from "../services/storageService.ts";
import { auditDeck } from "../services/aiService.ts";
import { generateDeckAuditPDF } from "../services/pdfService.ts";
import { storagePathFromUrl } from "../utils/storagePath.ts";
import path from "path";
import fs from "fs";

// Below this many characters of extracted text, an audit would be judging
// noise (image-only PDFs extract as empty/near-empty text).
const MIN_AUDITABLE_TEXT_CHARS = 200;

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
      // Item A: the bucket is private, so store the BARE object path (not a
      // public URL). Deck rendering goes through GET /:id/signed-url, which
      // signs this path on demand; the deletion path derives the same path.
      publicUrl = filePath;
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

// ── Signed deck URL (Item A: private-bucket access) ──────────────────────────
// The pitch-media bucket is private, so decks can no longer be loaded via a
// public URL. This returns a short-lived signed URL for the OWNER's deck only.
// Ownership is enforced by the user_id match — a signed URL is never issued for
// a deck the caller does not own. Local-fallback decks ("/uploads/..") and any
// non-storage value are returned as-is so dev and legacy rows still render.
const SIGNED_URL_TTL_SECONDS = 300; // 5 min — long enough for a pitch to load it

export const getDeckSignedUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: deck, error } = await supabase
      .from("decks")
      .select("file_url")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getDeckSignedUrl:", error);
      return res.status(500).json({ error: "Failed to load deck" });
    }
    if (!deck) return res.status(404).json({ error: "Deck not found" });

    const stored = deck.file_url as string | null;

    // Local-fallback file or empty — nothing to sign; hand back what we have.
    if (!stored || stored.startsWith("/uploads/")) {
      return res.json({ url: stored || "" });
    }

    const objectPath = storagePathFromUrl(stored);
    if (!objectPath) {
      // Unrecognized (e.g. an external URL we didn't store) — return as-is
      // rather than 500, so an odd legacy row still renders.
      return res.json({ url: stored });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(config.storageBucket)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      console.error("❌ createSignedUrl failed in getDeckSignedUrl:", signErr);
      return res.status(500).json({ error: "Failed to sign deck URL" });
    }

    res.json({ url: signed.signedUrl });
  } catch (err) {
    console.error("❌ getDeckSignedUrl exception:", err);
    res.status(500).json({ error: "Failed to sign deck URL" });
  }
};

// ── Deck Check: static deck-only audit ───────────────────────────────────────

export const runDeckAudit = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: deck, error } = await supabase
      .from("decks")
      .select("id, name, extracted_text")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in runDeckAudit:", error);
      return res.status(500).json({ error: "Failed to load deck" });
    }
    if (!deck) return res.status(404).json({ error: "Deck not found" });

    const text = (deck.extracted_text || "").trim();
    if (text.length < MIN_AUDITABLE_TEXT_CHARS) {
      return res.status(400).json({
        error:
          "No readable text in this deck — image-only PDFs can't be audited yet. Try exporting your deck with selectable text.",
      });
    }

    const report = await auditDeck(text, deck.name);

    const { data: auditRow, error: insertErr } = await supabase
      .from("deck_audits")
      .insert([{ deck_id: deck.id, user_id: userId, report }])
      .select("id, deck_id, report, created_at")
      .single();

    if (insertErr) {
      // The audit itself succeeded — still return it so the user isn't blocked,
      // it just won't appear in history.
      console.error("❌ Failed to save deck audit:", insertErr);
      return res.status(201).json({ id: null, deck_id: deck.id, report, created_at: new Date().toISOString() });
    }

    res.status(201).json(auditRow);
  } catch (err) {
    console.error("❌ runDeckAudit exception:", err);
    res.status(500).json({ error: "Failed to audit deck. Please try again." });
  }
};

export const listDeckAudits = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: audits, error } = await supabase
      .from("deck_audits")
      .select("id, deck_id, report, created_at")
      .eq("deck_id", req.params.id)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("❌ Supabase query error in listDeckAudits:", error);
      return res.status(500).json({ error: "Failed to fetch audits" });
    }
    res.json(audits || []);
  } catch (err) {
    console.error("❌ listDeckAudits exception:", err);
    res.status(500).json({ error: "Failed to fetch audits" });
  }
};

export const downloadDeckAuditPDF = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: audit, error } = await supabase
      .from("deck_audits")
      .select("id, deck_id, report, created_at")
      .eq("id", req.params.auditId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in downloadDeckAuditPDF:", error);
      return res.status(500).json({ error: "Failed to load audit" });
    }
    if (!audit) return res.status(404).json({ error: "Audit not found" });

    const { data: deck } = await supabase
      .from("decks")
      .select("name")
      .eq("id", audit.deck_id)
      .maybeSingle();
    const deckName = deck?.name || "Deck";

    // Deck-audit PDFs are 1-2 pages and regenerate in milliseconds, so no
    // cache table (unlike session_pdfs).
    const pdfBuffer = await generateDeckAuditPDF(audit, deckName);

    const safeName = deckName.replace(/[^\w\-]+/g, "_").slice(0, 60) || "Deck";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="PitchNest_DeckCheck_${safeName}.pdf"`,
    );
    res.send(pdfBuffer);
  } catch (err) {
    console.error("❌ downloadDeckAuditPDF exception:", err);
    res.status(500).json({ error: "Failed to generate audit PDF" });
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
