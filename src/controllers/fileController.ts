import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { supabase } from "../config/supabase.ts";
import { uploadDir, verifyLocalFileToken } from "../services/storageService.ts";

/**
 * S7: token-gated delivery for LOCAL-FALLBACK files.
 *
 * Supabase-stored decks/videos are served via short-lived Supabase signed
 * URLs; the only files that ever touch disk are the fallback rows written when
 * Supabase Storage errors (decks.file_url = "/uploads/..."). Those used to be
 * served by an unauthenticated `express.static('/uploads')` mount — anyone who
 * learned a filename could read any user's deck or video. This route replaces
 * that mount with a capability-token flow:
 *
 *   1. The owner's authenticated call to GET /api/decks/:id/signed-url (deck) or
 *      GET /api/sessions/:id/recording (pitch audio) mints a short-lived JWT
 *      bound to BOTH the filename and the owner's uid (signLocalFileUrl).
 *   2. The browser loads the file here with ?token=... in the query string
 *      (iframes / <audio> / window.open cannot send Authorization headers).
 *   3. Serve time re-verifies the token (signature, expiry, filename binding)
 *      AND that a row owned by that uid actually points at the file, so a
 *      leaked or forged token alone is never sufficient.
 */
export const getLocalFile = async (req: Request, res: Response) => {
  const name = req.params.name || "";

  // Filename must be a bare basename — never accept path tricks in the URL.
  if (!name || name !== path.basename(name)) {
    return res.status(400).json({ error: "Invalid file name" });
  }

  const uid = verifyLocalFileToken(req.query.token, name);
  if (!uid) {
    return res.status(401).json({ error: "Invalid or expired file token" });
  }

  // Ownership at serve time: the file is deliverable only while a row owned by
  // the token's uid points at it (deleted deck/session → deleted access).
  //
  // Two tables can legitimately own a local-fallback file: `decks` (uploaded
  // deck) and `sessions` (the pitch AUDIO recording, stored in the historically
  // named video_url column). Replay needs the second one — before this the check
  // was decks-only, so a locally-stored recording was unreachable even by its
  // owner. Whichever matches first authorises the read; neither matching is a
  // 404, exactly as before.
  const storedPath = `/uploads/${name}`;

  const { data: deck } = await supabase
    .from("decks")
    .select("id")
    .eq("file_url", storedPath)
    .eq("user_id", uid)
    .maybeSingle();

  let owned = !!deck;

  if (!owned) {
    const { data: session } = await supabase
      .from("sessions")
      .select("id")
      .eq("video_url", storedPath)
      .eq("user_id", uid)
      .maybeSingle();
    owned = !!session;
  }

  if (!owned) {
    return res.status(404).json({ error: "File not found" });
  }

  const absPath = path.join(uploadDir, name);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // Token is in the URL (logs, history, referrers) — never cache it. sendFile
  // sets Content-Type from the extension and supports Range requests.
  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(absPath);
};
