import { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { generatePitchReportPDF } from "../services/pdfService.ts";
import { getEntitlements } from "../services/entitlementService.ts";
import {
  removeOwnedRecordingReference,
  signLocalFileUrl,
  uploadDir,
} from "../services/storageService.ts";
import { isOwnRecordingReference } from "../utils/storagePath.ts";
import { authorizedRecordingTarget } from "../utils/recordingAuth.ts";
import {
  computeAttemptStates,
  loadAttemptStates,
  serializeAttemptState,
  MAX_PITCH_ATTEMPTS,
  PITCH_RETENTION_DAYS,
} from "../services/pitchAttemptService.ts";

/**
 * Safely parses stringified JSON structures, falling back to a structured object
 * containing the string text in case of database corruptions or plain text logs.
 */
const safeParseJSON = (val: any) => {
  if (!val)
    return {
      summary: "No evaluation details available.",
      scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
      strengths: [],
      risks: [],
      next_steps: [],
      sentiments: [],
    };
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch (e: any) {
    console.warn(
      "⚠️ Failed to parse session JSON, using fallback report structure:",
      e.message,
    );
    return {
      summary: val || "No evaluation details available.",
      scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
      strengths: [],
      risks: [],
      next_steps: [],
      sentiments: [],
    };
  }
};

/**
 * Fallback attempt state for a row we could not place in a chain.
 *
 * Only reachable when the chain query failed. Reports the pitch as active with
 * one attempt used so the UI degrades to "1 of 5" instead of hiding the pitch —
 * and note that this shape is advisory display data only. Whether a new attempt
 * may actually start is decided by pitchAttemptService at session start, never
 * by what this response said.
 */
const fallbackAttemptState = () => ({
  pitchRootId: 0,
  attemptNumber: 1,
  attemptsUsed: 1,
  attemptsRemaining: MAX_PITCH_ATTEMPTS - 1,
  maxAttempts: MAX_PITCH_ATTEMPTS,
  canStartNewAttempt: true,
  attemptsExhausted: false,
  isReportOnly: false,
  retentionExpiresAt: null,
  isPastRetention: false,
});

export const listSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: sessions, error } = await supabase
      .from("session_list_safe")
      .select("*")
      .eq("user_id", userId)
      .order("timestamp", { ascending: false });

    if (error) {
      console.error("❌ Supabase query error in listSessions:", error);
      return res.status(500).json({ error: "Failed to fetch sessions" });
    }

    // Attempt state is derived here, from the rows we just loaded — no extra
    // query, and the numbers the UI renders are the same ones the session-start
    // gate enforces. The frontend never counts attempts itself.
    const attemptStates = computeAttemptStates((sessions || []) as any[]);

    const formatted = (sessions || []).map((s: any) => {
      const state = attemptStates.get(Number(s.id));
      const parsedReport = safeParseJSON(s.evaluation_report);
      const { transcript: _privateTranscript, ...listReport } = parsedReport || {};
      return {
        ...s,
        created_at: s.created_at || s.timestamp,
        // The database view already removed transcript and recording paths, so
        // these sensitive fields never travel to Node on bulk archive reads.
        evaluation_report: listReport,
        has_recording: s.has_recording === true,
        attempts: state ? serializeAttemptState(state) : fallbackAttemptState(),
      };
    });
    res.json(formatted);
  } catch (error: any) {
    console.error("❌ listSessions exception:", error.message || error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
};

/**
 * One session, owner-only.
 *
 * This route used to branch on whether the identifier looked like a UUID, and if
 * so look the row up by share_id for ANY caller — an attempt at public share
 * links. It never worked (the route sits behind authMiddleware, so an anonymous
 * visitor got a 401 regardless), and once sharing became real it would have been
 * the wrong shape entirely: it returned the whole evaluation_report, transcript
 * and financials included, to any logged-in PitchNest user who came to hold a
 * share id. Public sharing now goes through GET /api/public/pitch/:shareId,
 * which returns a deliberately narrow projection, and this route is strictly the
 * owner's own view.
 */
export const getSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: session, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getSession:", error);
      return res.status(500).json({ error: "Failed to query session" });
    } else if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Attempt state belongs to the owner viewing their own report. A shared
    // pitch is a read-only view of one report and has no business exposing how
    // many attempts the founder has left, or letting a visitor infer the size of
    // their pitch history.
    const attemptState = (await loadAttemptStates(userId)).get(Number(session.id));

    const { video_url: _privateRecordingPath, ...safeSession } = session as any;
    const formatted = {
      ...safeSession,
      created_at: session.created_at || session.timestamp,
      evaluation_report: safeParseJSON(session.evaluation_report),
      has_recording: !!session.video_url,
      attempts: attemptState ? serializeAttemptState(attemptState) : fallbackAttemptState(),
    };
    res.json(formatted);
  } catch (error: any) {
    console.error("❌ getSession exception:", error.message || error);
    res.status(500).json({ error: "Failed to fetch session" });
  }
};

/**
 * Short-lived playback URL for a completed session's AUDIO recording.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE HAD TO EXIST
 * ──────────────────────────────────────────────────────────────────────────────
 * The recording is written to a PRIVATE bucket and only its bare object path is
 * stored (sessions.video_url). Until now nothing ever read it back — the upload
 * path even documented recordings as "write-only, never replayed" — so there was
 * no signed-URL route, and /api/files only authorises against the `decks` table.
 * Replay could not play audio because the audio was unreachable, not missing.
 *
 * The column keeps its historical name. It is read by the account-deletion path
 * to purge storage objects and is declared in the mobile client's session type,
 * so renaming it would be a breaking change for no functional gain. What it
 * holds is an audio recording — video is never captured (getUserMedia is called
 * with video: false).
 *
 * Ownership is enforced on the row before anything is signed, and a 404 (not a
 * 403) is returned for someone else's session so this cannot be used to probe
 * which session ids exist.
 */
const RECORDING_URL_TTL_SECONDS = 3600; // 1h — long enough to play a full pitch

export const getSessionRecording = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: session, error } = await supabase
      .from("sessions")
      .select("id, user_id, video_url")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getSessionRecording:", error);
      return res.status(500).json({ error: "Failed to load session" });
    }
    if (!session) return res.status(404).json({ error: "Session not found" });

    const stored = (session.video_url as string | null) || "";
    if (!stored.trim()) {
      // Not an error: sessions that predate audio capture, or whose upload
      // failed, simply have no recording. Replay stays available on transcript.
      return res.json({ url: "", available: false });
    }

    // Only a recording this user owns is ever signed. Rows written before
    // set_video_url was validated may point at a deck, another user's
    // recording or an arbitrary URL; those must never get a service-role
    // signed URL or be reflected back (see utils/recordingAuth.ts).
    const target = await authorizedRecordingTarget(stored, userId);
    if (!target) {
      console.warn(`⚠️ Refusing to sign an unowned recording reference for session ${session.id}`);
      return res.json({ url: "", available: false });
    }

    // Local-fallback recording — token-gated through /api/files, which
    // re-checks ownership at serve time.
    if (target.kind === "local") {
      return res.json({
        url: signLocalFileUrl(target.name, userId, RECORDING_URL_TTL_SECONDS),
        available: true,
      });
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(config.storageBucket)
      .createSignedUrl(target.path, RECORDING_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      console.error("❌ createSignedUrl failed in getSessionRecording:", signErr);
      return res.status(500).json({ error: "Failed to sign recording URL" });
    }

    res.json({ url: signed.signedUrl, available: true });
  } catch (error: any) {
    console.error("❌ getSessionRecording exception:", error.message || error);
    res.status(500).json({ error: "Failed to load recording" });
  }
};

/**
 * Attempt/lifecycle state for one pitch chain, addressed by any session in it.
 *
 * The pre-pitch setup screen calls this before offering to start a re-pitch, so
 * the button reflects server state rather than a client-side count. It is a
 * convenience for the UI only — the authoritative gate runs at session start in
 * restSocket, which is what makes refreshing, a second tab, re-login, or edited
 * client state unable to buy a sixth attempt.
 */
export const getPitchAttempts = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: session, error } = await supabase
      .from("sessions")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getPitchAttempts:", error);
      return res.status(500).json({ error: "Failed to load session" });
    }
    if (!session) return res.status(404).json({ error: "Session not found" });

    const state = (await loadAttemptStates(userId)).get(Number(session.id));
    res.json({
      ...(state ? serializeAttemptState(state) : fallbackAttemptState()),
      retentionDays: PITCH_RETENTION_DAYS,
    });
  } catch (error: any) {
    console.error("❌ getPitchAttempts exception:", error.message || error);
    res.status(500).json({ error: "Failed to load attempt state" });
  }
};

/** Attach an uploaded audio object to its owner session without relying on a live WebSocket. */
export const attachSessionRecording = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  const recording = typeof req.body?.recording === "string" ? req.body.recording.trim() : "";
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  if (!isOwnRecordingReference(recording, userId)) {
    return res.status(400).json({ error: "Invalid recording reference" });
  }

  try {
    const { data: session, error: readError } = await supabase
      .from("sessions")
      .select("id, video_url")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (readError) throw readError;
    if (!session) {
      await removeOwnedRecordingReference(recording, userId).catch((error) =>
        console.error("Unattached recording cleanup failed:", error),
      );
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.video_url === recording) return res.json({ success: true });
    if (typeof session.video_url === "string" && session.video_url.trim()) {
      await removeOwnedRecordingReference(recording, userId).catch((error) =>
        console.error("Duplicate recording cleanup failed:", error),
      );
      return res.status(409).json({ error: "This session already has a recording" });
    }

    // Older sessions store "" rather than NULL for "no recording yet". Update
    // only if the value is still the one read above, so concurrent attaches
    // cannot both succeed.
    const attach = supabase
      .from("sessions")
      .update({ video_url: recording })
      .eq("id", session.id)
      .eq("user_id", userId);
    const { data: updated, error: updateError } = await (
      typeof session.video_url === "string"
        ? attach.eq("video_url", session.video_url)
        : attach.is("video_url", null)
    )
      .select("id")
      .maybeSingle();
    if (updateError || !updated) {
      await removeOwnedRecordingReference(recording, userId).catch((error) =>
        console.error("Failed recording rollback cleanup:", error),
      );
      if (updateError) throw updateError;
      return res.status(409).json({ error: "Recording could not be attached" });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Attach session recording failed:", error);
    return res.status(500).json({ error: "Failed to attach recording" });
  }
};

export const deleteSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: session, error: readError } = await supabase
      .from("sessions")
      .select("id, video_url")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (readError) {
      console.error("Session lookup failed in deleteSession:", readError);
      return res.status(500).json({ error: "Failed to delete session" });
    }
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Remove the recording only when this user owns it. A row written before
    // set_video_url was validated may point at someone else's object; that
    // reference is dropped with the row and the object is left alone.
    const recording = typeof session.video_url === "string" ? session.video_url.trim() : "";
    const target = recording ? await authorizedRecordingTarget(recording, userId) : null;
    if (recording && !target) {
      console.warn(`⚠️ Session ${session.id} references a recording it does not own; leaving the object in place.`);
    }
    if (target?.kind === "local") {
      try {
        await fs.promises.rm(path.join(uploadDir, target.name), { force: true });
      } catch (storageError) {
        console.error("Local session recording cleanup failed:", storageError);
        return res.status(503).json({ error: "Could not remove the recording. Please retry." });
      }
    } else if (target?.kind === "storage") {
      const { error: storageError } = await supabase.storage
        .from(config.storageBucket)
        .remove([target.path]);
      if (storageError) {
        console.error("Session recording cleanup failed:", storageError);
        return res.status(503).json({ error: "Could not remove the recording. Please retry." });
      }
    }

    const { error } = await supabase
      .from("sessions")
      .delete()
      .eq("id", session.id)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ Supabase query error in deleteSession:", error);
      return res.status(500).json({ error: "Failed to delete session" });
    }
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("❌ deleteSession exception:", error.message || error);
    res.status(500).json({ error: "Failed to delete session" });
  }
};

// NOTE: createSession was removed alongside its POST /api/sessions/create
// route. It accepted a client-supplied evaluation_report and inserted a session
// row directly, bypassing both the WebSocket pitch flow (which is where
// sessions are actually created, at end_session) and the plan quota. It had no
// callers in the web app, the mobile app, or the backend.

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC SHARING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many highlights a shared pitch shows. Three is the whole card: enough to
 * be a credible summary, few enough that the shared page is a calling card for
 * the full report rather than a replacement for it.
 */
const PUBLIC_HIGHLIGHT_LIMIT = 3;

/**
 * Turn the public link on for one session. Owner-only.
 *
 * OPT-IN, AND WHY THAT IS NOT THE OBVIOUS DESIGN. Every session already carries
 * a share_id, generated at creation, long before anyone asked to share anything.
 * So "has an id" must never be the thing that makes a report public: a founder
 * who has never pressed Share cannot end up on the open internet because of a
 * UUID that was minted on their behalf. share_enabled is the only gate, it
 * defaults to false, and it did not exist before migration 0015.
 *
 * Re-enabling reuses the existing id rather than minting a new one, so a link
 * already pasted into a deck or an email keeps working. Rotation, if we ever
 * want it, belongs in its own explicit action.
 *
 * Returns the id, not a full URL — the URL is composed by the client from its
 * own origin, so a preview deployment hands out preview links and the backend
 * never has to guess which hostname the founder is actually looking at.
 */
export const enableSessionShare = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { data: session, error } = await supabase
      .from("sessions")
      .select("id, share_id")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in enableSessionShare:", error);
      return res.status(500).json({ error: "Failed to load session" });
    }
    // 404 rather than 403: a 403 would confirm the id exists.
    if (!session) return res.status(404).json({ error: "Session not found" });

    const shareId = (session as any).share_id || crypto.randomUUID();

    const { error: updateError } = await supabase
      .from("sessions")
      .update({ share_id: shareId, share_enabled: true })
      .eq("id", req.params.id)
      .eq("user_id", userId);

    if (updateError) {
      console.error("❌ Supabase update error in enableSessionShare:", updateError);
      return res.status(500).json({ error: "Failed to enable sharing" });
    }

    res.json({ shareId, shared: true });
  } catch (error: any) {
    console.error("❌ enableSessionShare exception:", error.message || error);
    res.status(500).json({ error: "Failed to enable sharing" });
  }
};

/**
 * Turn the public link off. Owner-only and idempotent.
 *
 * Keeps share_id. Clearing it would mean a founder who revokes and then changes
 * their mind gets a different URL, silently breaking every copy of the old one
 * that already exists in someone else's inbox — so the flag is what the public
 * route reads, and the id is treated as stable for the life of the session.
 */
export const disableSessionShare = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { error } = await supabase
      .from("sessions")
      .update({ share_enabled: false })
      .eq("id", req.params.id)
      .eq("user_id", userId);

    if (error) {
      console.error("❌ Supabase update error in disableSessionShare:", error);
      return res.status(500).json({ error: "Failed to turn off sharing" });
    }

    res.json({ shareId: null, shared: false });
  } catch (error: any) {
    console.error("❌ disableSessionShare exception:", error.message || error);
    res.status(500).json({ error: "Failed to turn off sharing" });
  }
};

/**
 * The one unauthenticated read in this file: a shared report, addressed by its
 * share_id. This is what /share/<shareId> renders.
 *
 * ALLOWLIST, NOT DENYLIST — and that distinction is the whole point of this
 * function. evaluation_report is a JSONB blob with roughly twenty-five keys
 * holding the founder's transcript, their raise figure, unit economics, the
 * competitive landscape, market gaps, the panel's verbatim quotes and their
 * percentile. Spreading that object and deleting the handful of keys we remember
 * to name would make every field added to the report in future public by
 * default — and a new report field is precisely the kind of thing that gets
 * added by someone with no reason to think about this route. So this builds a
 * new object field by field instead. Anything not named below is not shared, now
 * or later.
 *
 * The cost is deliberate: an investor opening a shared pitch sees the score, the
 * verdict, the strengths and the fixes — not the founder's financials, unless
 * the founder chooses to say them out loud.
 */
export const getPublicPitch = async (req: Request, res: Response) => {
  try {
    const { data: session, error } = await supabase
      .from("sessions")
      .select("business_name, created_at, timestamp, mode, evaluation_report")
      .eq("share_id", req.params.shareId)
      .eq("share_enabled", true)
      .maybeSingle();

    if (error) {
      console.error("❌ Supabase query error in getPublicPitch:", error);
      return res.status(500).json({ error: "Failed to load pitch" });
    }

    // A revoked link and a never-existed link answer identically. "This was
    // shared once, and then withdrawn" is not something a visitor needs to learn
    // about the founder who sent it.
    if (!session) {
      return res.status(404).json({ error: "This pitch is not available." });
    }

    const report = safeParseJSON((session as any).evaluation_report);
    const rawScores = report?.scores || {};
    const scores = {
      delivery: Math.round(Number(rawScores.delivery) || 0),
      clarity: Math.round(Number(rawScores.clarity) || 0),
      scalability: Math.round(Number(rawScores.scalability) || 0),
      readiness: Math.round(Number(rawScores.readiness) || 0),
    };
    const overall = Math.round(
      (scores.delivery + scores.clarity + scores.scalability + scores.readiness) / 4,
    );

    // An unscored pitch (too short, or the evaluation failed) has nothing worth
    // showing. Refusing it here means the client never has to render a hollow
    // "score: 0" card as though it were a result.
    if (report?.evaluationStatus !== "complete" || overall <= 0) {
      return res.status(404).json({ error: "This pitch is not available." });
    }

    const strengths = Array.isArray(report.strengths)
      ? report.strengths
          .filter((s: any) => typeof s === "string" && s.trim())
          .slice(0, PUBLIC_HIGHLIGHT_LIMIT)
          .map((s: string) => s.trim())
      : [];

    const fixes = Array.isArray(report.next_steps)
      ? report.next_steps
          .filter((s: any) => s && typeof s.title === "string" && s.title.trim())
          .slice(0, PUBLIC_HIGHLIGHT_LIMIT)
          .map((s: any) => ({
            title: String(s.title).trim(),
            desc: typeof s.desc === "string" ? s.desc.trim() : "",
            priority: typeof s.priority === "string" ? s.priority.trim() : "",
          }))
      : [];

    // Revocable links must not sit in a CDN or a proxy cache after revocation.
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.json({
      businessName: (session as any).business_name || "A startup pitch",
      date: (session as any).created_at || (session as any).timestamp || null,
      mode: (session as any).mode || report?.mode || "panel",
      score: overall,
      scores,
      strengths,
      fixes,
    });
  } catch (error: any) {
    console.error("❌ getPublicPitch exception:", error.message || error);
    res.status(500).json({ error: "Failed to load pitch" });
  }
};


export const generateSessionPDF = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // 1. Authorize FIRST, before touching the PDF cache.
    //
    // The session_pdfs cache is keyed on session_id alone, so reading it before
    // establishing ownership would serve any user's report to any caller. The
    // ownership check has to gate the response, not just the filename.
    //
    // 404 rather than 403 on a permission failure: a 403 confirms the id exists
    // and turns this endpoint into an id-enumeration oracle.
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (sessionError) {
      console.error("❌ Supabase query error in generateSessionPDF:", sessionError);
      return res.status(500).json({ error: "Failed to query session" });
    }
    if (!session || session.user_id !== userId) {
      return res.status(404).json({ error: "Session not found" });
    }

    // 2. Entitlement. Checked after ownership (so a stranger still gets 404,
    //    not a 402 that would confirm the session exists) and before the cache
    //    read, so a free user can never be served a cached full report.
    //
    //    402 and NOT 401: the frontend's authFetch treats 401 as a dead token
    //    and logs the user out, so denying with 401 would destroy the session
    //    of the very user we are trying to sell to.
    const entitlement = await getEntitlements(userId);
    if (!entitlement.pdfDownload) {
      return res.status(402).json({
        error: "upgrade_required",
        message: "Downloading the full PDF report is a Pro feature.",
      });
    }

    // 3. Try the cached PDF now that the caller is known to own the session.
    const { data: cached, error: cacheError } = await supabase
      .from("session_pdfs")
      .select("pdf_base64")
      .eq("session_id", req.params.id)
      .maybeSingle();

    let pdfBuffer: Buffer;
    let businessName = "Pitch_Report";

    if (!cacheError && cached?.pdf_base64) {
      console.log(`📦 Serving cached PDF for session ID ${req.params.id}`);
      pdfBuffer = Buffer.from(cached.pdf_base64, "base64");
      // The session row is already loaded above — no second query needed.
      if (session.business_name) {
        businessName = session.business_name;
      }
    } else {
      console.log(`🔨 PDF cache miss. Generating PDF on-demand for session ID ${req.params.id}`);

      const formatted = {
        ...session,
        created_at: session.created_at || session.timestamp,
        evaluation_report:
          typeof session.evaluation_report === "string"
            ? (() => { try { return JSON.parse(session.evaluation_report); } catch { return session.evaluation_report; } })()
            : session.evaluation_report,
      };

      pdfBuffer = await generatePitchReportPDF(formatted);
      businessName = formatted.business_name || "Pitch_Report";

      // 4. Cache generated PDF in database asynchronously
      const base64Pdf = pdfBuffer.toString("base64");
      supabase
        .from("session_pdfs")
        .insert([{ session_id: req.params.id, pdf_base64: base64Pdf }])
        .then(({ error: insertErr }) => {
          if (insertErr) {
            console.warn(`⚠️ Failed to cache generated PDF for session ${req.params.id}:`, insertErr.message);
          } else {
            console.log(`✅ Cached generated PDF for session ${req.params.id}`);
          }
        });
    }

    const safeName = businessName
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .replace(/\s+/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="PitchNest_Report_${safeName}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error: any) {
    console.error("❌ generateSessionPDF exception:", error.message || error);
    res.status(500).json({ error: "Failed to generate PDF report" });
  }
};
