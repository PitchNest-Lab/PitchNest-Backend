import { Request, Response } from "express";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { uploadDir, sanitizeUploadName, signLocalFileUrl } from "../services/storageService.ts";
import { auditDeck } from "../services/aiService.ts";
import { generateDeckAuditPDF } from "../services/pdfService.ts";
import { storagePathFromUrl } from "../utils/storagePath.ts";
import {
  extractPdfPages,
  extractPlainTextDeck,
  pageCountFromText,
} from "../services/deckTextService.ts";
import path from "path";
import fs from "fs";

// Below this many characters of extracted text, an audit would be judging
// noise (image-only PDFs extract as empty/near-empty text).
const MIN_AUDITABLE_TEXT_CHARS = 200;

/**
 * Resolves what a deck upload ACTUALLY is, from its bytes.
 *
 * The multipart MIME type is set by the client and can be wrong: Windows with
 * a broken file association sends `application/octet-stream` for a real PDF,
 * and some browsers send an empty type. Multer's allow-list now lets those two
 * through the gate, so the truth has to be established here.
 *
 *   • `%PDF-` magic prefix                          → application/pdf
 *   • decodable UTF-8 with no NUL bytes in the head → text/plain
 *   • anything else (e.g. a renamed .pptx = `PK…`)  → null → 415
 */
export function resolveDeckType(buffer: Buffer, mimetype: string | undefined): string | null {
  if (mimetype === "application/pdf" || mimetype === "text/plain" || mimetype === "text/markdown") {
    return mimetype;
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024));
  // Known NON-deck binary containers, rejected before any text heuristic can
  // misfire on them: PK = zip (pptx/docx/xlsx), the OLE compound header = legacy
  // Office (.ppt/.doc), MZ = Windows executables.
  const magic = head.subarray(0, 4).toString("latin1");
  if (magic === "PK\x03\x04" || magic.startsWith("PK")) return null;
  if (
    head.length >= 8 &&
    head.subarray(0, 8).toString("latin1") === "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"
  ) {
    return null;
  }
  if (magic === "MZ\x90\x00" || magic.startsWith("MZ")) return null;
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "application/pdf";
  }
  if (head.length > 0 && !head.includes(0)) {
    const decoded = head.toString("utf-8");
    // � appears when Buffer.toString hits invalid UTF-8 — binary content.
    if (!decoded.includes("�")) return "text/plain";
  }
  return null;
}

export const uploadDeck = async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No deck file provided" });

    // Client MIME is a hint; the bytes are the truth (see resolveDeckType).
    const deckType = resolveDeckType(req.file.buffer, req.file.mimetype);
    if (!deckType) {
      return res.status(415).json({
        error:
          "Pitch decks must be PDF, .txt or .md files. PowerPoint files are not supported yet — export your deck as a PDF and upload that.",
      });
    }

    const userId = req.user?.id;
    const originalName = sanitizeUploadName(req.file.originalname);
    const sizeMB = parseFloat((req.file.size / (1024 * 1024)).toFixed(2));
    const deckName = req.file.originalname.replace(/\.[^/.]+$/, "");
    const filePath = `decks/${Date.now()}_${originalName}`;

    let extractedText = "";
    let pageCount = 0;
    // Text extraction MUST keep page boundaries (\f) — that is what makes the
    // deck one slide per page for both the viewer and the AI's slide context.
    // See deckTextService for why normalising with /\s{2,}/ destroyed them.
    if (deckType === "application/pdf") {
      const extraction = await extractPdfPages(req.file.buffer);
      extractedText = extraction.text;
      pageCount = extraction.pageCount;
      console.log(
        `✅ Extracted PDF text. Length: ${extractedText.length}, pages: ${pageCount}`,
      );
    } else if (
      deckType === "text/plain" ||
      deckType === "text/markdown" ||
      originalName.endsWith(".txt") ||
      originalName.endsWith(".md")
    ) {
      const extraction = extractPlainTextDeck(req.file.buffer.toString("utf-8"));
      extractedText = extraction.text;
      pageCount = extraction.pageCount;
      console.log(
        `✅ Extracted plain-text deck. Length: ${extractedText.length}, sections: ${pageCount}`,
      );
    }

    const { data, error } = await supabase.storage
      .from(config.storageBucket)
      .upload(filePath, req.file.buffer, {
        // Store with the sniffed type, not what the client claimed — a PDF
        // that arrived as octet-stream must not be stored as one.
        contentType: deckType,
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
      page_count: pageCount || null,
      user_id: userId
    };

    let { data: dbData, error: dbError } = await supabase
      .from("decks")
      .insert([insertData])
      .select()
      .single();

    // Rollout safety: page_count arrives with migration 0014. If it isn't there
    // yet, save the deck without it rather than failing the upload — the read
    // path treats a missing count as "not measured yet".
    if (dbError && /column|schema/i.test(dbError.message || "")) {
      console.warn(
        "⚠️ Deck insert failed (possibly missing page_count column) — retrying without it:",
        dbError.message,
      );
      const { page_count, ...legacyInsert } = insertData;
      ({ data: dbData, error: dbError } = await supabase
        .from("decks")
        .insert([legacyInsert])
        .select()
        .single());
    }

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
      page_count: dbData.page_count ?? pageCount ?? null,
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
// a deck the caller does not own. Local-fallback decks ("/uploads/..") are
// served through the token-gated /api/files route (S7) — the raw path itself is
// no longer publicly reachable. Any other non-storage value is returned as-is
// so dev and legacy rows still render.
const SIGNED_URL_TTL_SECONDS = 300; // 5 min — long enough for a pitch to load it

/**
 * Measure a deck's real page count, backfilling it (and its page-delimited
 * text) for decks stored before that was recorded.
 *
 * WHY HERE: the viewer needs an authoritative "of N" the moment a deck opens,
 * and decks uploaded before deckTextService existed have neither a page_count
 * nor form feeds in their extracted text — so they would present as one slide
 * over a document the founder can see has more. Re-parsing the stored file once,
 * lazily, on first open repairs both without a bulk data migration and without
 * touching any deck whose file is no longer in storage.
 *
 * Never throws: a deck that cannot be measured falls back to whatever its text
 * implies, and a count of 0 simply means the viewer presents it as a single page.
 */
async function resolveDeckPageCount(
  deckId: string,
  storedPath: string | null,
  knownCount: number | null,
  extractedText: string | null,
): Promise<number> {
  if (knownCount && knownCount > 0) return knownCount;

  const objectPath = storedPath ? storagePathFromUrl(storedPath) : null;
  const isPdf = (storedPath || "").toLowerCase().endsWith(".pdf");

  // Re-parse from storage — the only way to learn the true count.
  if (objectPath && isPdf) {
    try {
      const { data: blob, error } = await supabase.storage
        .from(config.storageBucket)
        .download(objectPath);
      if (!error && blob) {
        const buffer = Buffer.from(await blob.arrayBuffer());
        const extraction = await extractPdfPages(buffer);
        if (extraction.pageCount > 0) {
          const patch: any = { page_count: extraction.pageCount };
          // Only replace the stored text when re-extraction actually produced
          // some — never overwrite existing text with nothing.
          if (extraction.text) patch.extracted_text = extraction.text;
          const { error: patchErr } = await supabase
            .from("decks")
            .update(patch)
            .eq("id", deckId);
          if (patchErr) {
            console.warn(
              "⚠️ Could not backfill deck page_count (non-fatal):",
              patchErr.message,
            );
          }
          return extraction.pageCount;
        }
      }
    } catch (err) {
      console.warn("⚠️ Deck page-count measurement failed (non-fatal):", err);
    }
  }

  // Local-fallback file on disk.
  if (storedPath?.startsWith("/uploads/") && isPdf) {
    try {
      const localPath = path.join(uploadDir, storedPath.slice("/uploads/".length));
      if (fs.existsSync(localPath)) {
        const extraction = await extractPdfPages(fs.readFileSync(localPath));
        if (extraction.pageCount > 0) return extraction.pageCount;
      }
    } catch {
      /* fall through to the text-derived count */
    }
  }

  return pageCountFromText(extractedText);
}

export const getDeckSignedUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // page_count arrives with migration 0014 — degrade to the legacy column set
    // if it isn't deployed yet rather than failing the deck open.
    let { data: deck, error } = await supabase
      .from("decks")
      .select("file_url, page_count, extracted_text")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error && /column|schema/i.test(error.message || "")) {
      ({ data: deck, error } = await supabase
        .from("decks")
        .select("file_url, extracted_text")
        .eq("id", req.params.id)
        .eq("user_id", userId)
        .maybeSingle());
    }

    if (error) {
      console.error("❌ Supabase query error in getDeckSignedUrl:", error);
      return res.status(500).json({ error: "Failed to load deck" });
    }
    if (!deck) return res.status(404).json({ error: "Deck not found" });

    const stored = deck.file_url as string | null;

    if (!stored) {
      return res.json({ url: "", pageCount: 0 });
    }

    const pageCount = await resolveDeckPageCount(
      req.params.id,
      stored,
      (deck as any).page_count ?? null,
      (deck as any).extracted_text ?? null,
    );

    // Local-fallback file — the raw /uploads path is no longer publicly served
    // (S7). Mint a short-lived capability URL bound to this owner + filename;
    // the /api/files route re-verifies ownership from the decks table.
    if (stored.startsWith("/uploads/")) {
      const name = stored.slice("/uploads/".length);
      return res.json({ url: signLocalFileUrl(name, userId), pageCount });
    }

    const objectPath = storagePathFromUrl(stored);
    if (!objectPath) {
      // Unrecognized (e.g. an external URL we didn't store) — return as-is
      // rather than 500, so an odd legacy row still renders.
      return res.json({ url: stored, pageCount });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(config.storageBucket)
      .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      console.error("❌ createSignedUrl failed in getDeckSignedUrl:", signErr);
      return res.status(500).json({ error: "Failed to sign deck URL" });
    }

    res.json({ url: signed.signedUrl, pageCount });
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
