import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import jwt from "jsonwebtoken";
import { supabase } from "../config/supabase.ts";
import { config, hasAzureTtsConfig, hasOpenAiConfig } from "../config/env.ts";
import {
  evaluatePitch,
  hasSubstantivePitch,
  isInsufficientPitch,
  getMasterPrompt,
  generatePanelResponse,
  streamPanelResponse,
  generateAnswerTip,
} from "../services/aiService.ts";
import { generatePitchReportPDF } from "../services/pdfService.ts";
import {
  synthesizeSpeech,
  isTtsConfigured,
  resolveVoiceName,
} from "../services/ttsService.ts";
import {
  createStreamingRecognizer,
  hasAzureSttConfig,
  StreamingRecognizer,
} from "../services/sttService.ts";
import { detectSpeaker, sanitizeAiSpeech } from "../utils/aiTextSanitizer.ts";
import {
  detectEndSessionIntent,
  classifyConfirmationReply,
} from "../utils/endSessionIntent.ts";
import { detectFloorHandback } from "../utils/floorControl.ts";
import {
  researchStartup,
  buildMarketSnapshotBlock,
  type MarketSnapshot,
} from "../services/researchService.ts";
import crypto from "crypto";

// Below this Azure STT confidence (0..1) we treat a recognition as likely
// garbled and ask the founder to repeat instead of answering it.
const LOW_STT_CONFIDENCE = 0.2;

// Hard wrap-up window: in the final seconds of a session the panel must not
// launch a NEW spoken turn in response to the founder — no new questions right
// before the buzzer (the 2-minute wrap-up cue has already told them to land the
// plane). The founder's words are still recorded to the transcript; only the AI
// turn is suppressed, so time-up transitions cleanly into verdicts instead of a
// fresh panelist turn overlapping the closing.
const WRAP_UP_HARD_SEC = 20;
// Only the most recent messages are sent to the live model each turn — the
// system prompt already carries the deck + setup, and an unbounded history
// makes responses progressively slower as the session runs. The full history
// stays in memory; the evaluation still sees the entire transcript.
const MAX_LLM_HISTORY = 20;

// ── Varied opening greetings ─────────────────────────────────────────────────
// "Welcome to the Nest" (play on PitchNest). A fresh one is picked at random each
// session so the opening never feels canned. {b} is the business name.
const PANEL_GREETINGS = [
  "Welcome to the Nest — whenever you're ready, walk us through {b}.",
  "Great to have you in the Nest. Take a breath, then kick off your pitch for {b} whenever you're set.",
  "Welcome to the Nest — the panel's listening, so start your pitch for {b} whenever you'd like.",
  "You've made it to the Nest. Let's hear what {b} is all about whenever you're ready.",
  "Welcome to the Nest — the floor is yours; introduce {b} whenever you're ready.",
  "Glad you're here in the Nest. Start your pitch for {b} whenever you feel ready.",
];
const COACH_GREETINGS = [
  "Welcome to the Nest — I'm Riley. Let's sharpen your pitch for {b} whenever you're ready.",
  "Great to have you in the Nest. Take your time, then walk me through {b}.",
  "Welcome to the Nest — whenever you're set, start your pitch for {b} and I'll coach you through it.",
  "You're in the Nest now. Let's make {b} shine — begin whenever you're ready.",
  "Welcome to the Nest — I'm Riley, your coach. Kick off {b} whenever you're ready.",
];

// Re-pitch greetings: the founder has pitched {b} to us before and chose
// "Pitch Again", so the panel acknowledges the return instead of a cold open.
const PANEL_GREETINGS_RETURN = [
  "Welcome back to the Nest — we remember {b}. Show us what's changed since last time.",
  "Good to see you again. The panel remembers your last pitch for {b} — let's see how it's evolved.",
  "Welcome back — {b} left us with questions last time. The floor is yours whenever you're ready.",
  "Back in the Nest. We've kept our notes on {b}, so pick it up whenever you're ready.",
];
const COACH_GREETINGS_RETURN = [
  "Welcome back to the Nest — I'm glad you returned. Let's pick up where we left off with {b}.",
  "Good to have you back. I remember our last session on {b} — show me what you've improved.",
  "Welcome back — I've still got my notes on {b}. Start whenever you're ready and we'll build on last time.",
];

function pickGreeting(
  isCoach: boolean,
  businessName: string,
  isReturning = false,
): string {
  const pool = isReturning
    ? isCoach
      ? COACH_GREETINGS_RETURN
      : PANEL_GREETINGS_RETURN
    : isCoach
      ? COACH_GREETINGS
      : PANEL_GREETINGS;
  const line = pool[Math.floor(Math.random() * pool.length)];
  return line.replace("{b}", businessName || "your startup");
}

// ── Voice end-session: canned confirmation + closing lines ──────────────────
// Spoken by the lead (Marcus / Riley) when the founder's transcript signals
// they want to end. The confirmation MUST be an explicit question so nothing
// ends without an affirmative reply. Kept canned (not LLM-generated) so it is
// instant, reliable, and can never accidentally ask a new pitch question.
const PANEL_END_CONFIRM = [
  "Just to confirm — would you like to end the session here and go to your verdicts?",
  "Before we wrap — do you want to end the session here and hear our final verdicts?",
  "Got it — shall we end the session here and move to the panel's verdicts?",
];
const COACH_END_CONFIRM = [
  "Just to confirm — would you like to end the session here and see your report?",
  "Before we wrap — do you want to finish up here and go to your coaching report?",
  "Got it — shall we end the session here and pull together your feedback?",
];
const PANEL_CLOSING = [
  "Thanks for pitching to us today — nice work getting through it. Let's bring the panel together for final verdicts.",
  "Good session — thank you for walking us through it. We'll take it from here and share our verdicts.",
];
const COACH_CLOSING = [
  "Great work today — thanks for putting in the reps. Let me pull your feedback together now.",
  "Nice session — you should be proud of that effort. I'll get your report ready now.",
];

// Two-step interruption (Item D): spoken by the interjecting panelist when the
// founder keeps pitching through the intent line instead of handing the floor
// back. Canned (not LLM) so it is instant and can never accidentally ask the
// held question early — the whole point is to wait for the hand-back.
const PANEL_FLOOR_RESIGNAL = [
  "Sorry — I really do need to jump in for a second. Can I ask my question?",
  "Hold on, if you don't mind — I have a quick question before you go on.",
  "Let me stop you there for just a moment — may I ask something?",
];
const COACH_FLOOR_RESIGNAL = [
  "Sorry to cut in — can I ask you something real quick before you continue?",
  "Hold that thought for one second — I'd like to ask a quick question.",
];

function pickLine(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Clamp the client-supplied previous-session context to a compact, trusted
// shape. The WS bypasses Express auth, so nothing from the client is trusted
// as-is: strings are truncated, numbers coerced, arrays capped.
function clampPreviousSession(raw: any): {
  sessionId: number;
  date: string;
  overallScore: number;
  scores: { delivery: number; clarity: number; scalability: number; readiness: number };
  summary: string;
  topRisks: string[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: any) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  };
  return {
    sessionId: Number(raw.sessionId) || 0,
    date: String(raw.date || "").slice(0, 40),
    overallScore: num(raw.overallScore),
    scores: {
      delivery: num(raw.scores?.delivery),
      clarity: num(raw.scores?.clarity),
      scalability: num(raw.scores?.scalability),
      readiness: num(raw.scores?.readiness),
    },
    summary: String(raw.summary || "").slice(0, 400),
    topRisks: (Array.isArray(raw.topRisks) ? raw.topRisks : [])
      .slice(0, 3)
      .map((r: any) => String(r || "").slice(0, 140)),
  };
}

// Yields a fixed string as a single chunk so a canned line (e.g. the greeting)
// can flow through the same sentence/TTS pipeline as streamed LLM output.
async function* singleChunkStream(text: string): AsyncGenerator<string, void, unknown> {
  yield text;
}

async function resolveDeckText(clientConfig: any): Promise<string> {
  const deck = clientConfig?.selectedDeck;
  if (!deck) return "";

  if (deck.extracted_text?.trim()) {
    return deck.extracted_text.trim();
  }

  if (deck.id && config.supabaseUrl && config.supabaseAnonKey) {
    try {
      const { data } = await supabase
        .from("decks")
        .select("extracted_text")
        .eq("id", deck.id)
        .single();
      if (data?.extracted_text?.trim()) {
        console.log(`📄 Loaded deck text from DB for deck id ${deck.id}`);
        return data.extracted_text.trim();
      }
    } catch (err) {
      console.warn("⚠️ Could not fetch deck text from database:", err);
    }
  }

  return "";
}

function splitIntoSpokenChunks(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function formatTimeLeft(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildUserTurnInput(text: string, timeLeft?: number): string {
  if (timeLeft === undefined || timeLeft < 0) return text;
  return `[PITCH TIME REMAINING: ${formatTimeLeft(timeLeft)}]\n${text}`;
}

// ── Panel interest side-channel (@@INTEREST machine tag) ────────────────────
// The panel prompt instructs the model to end every turn with a non-spoken
// line like "@@INTEREST Sarah=cooling | concern: gross margin still unclear".
// The streaming layer intercepts it at both emit sites (mid-stream sentence
// and final-buffer flush) so it never reaches TTS or the visible transcript;
// sanitizeAiSpeech strips any remnant as a reactive backstop.
const PANELIST_NAMES = ["Marcus", "Sarah", "Chen"] as const;
type InterestState = "warming" | "neutral" | "cooling" | "out";

const INTEREST_TAG_RE = /@@INTEREST\b([^\n]*)/i;

// ── Two-step interruption side-channel (@@FLOOR machine tag) ────────────────
// Item D. When a panelist interjects, its turn is ONLY a short intent line
// ("Sorry, can I jump in?") followed by this non-spoken tag on its own line:
//   @@FLOOR hold
// The server strips it (exactly like @@INTEREST) and, seeing it, holds the
// conversational floor: the founder's next utterance is not treated as pitch
// content until they hand the floor back. See the message handler's floor-hold
// routing and floorControl.ts.
const FLOOR_TAG_RE = /@@FLOOR\b[^\n]*/i;

function splitFloorTag(text: string): { spoken: string; floorHold: boolean } {
  const m = text.match(FLOOR_TAG_RE);
  if (!m || m.index === undefined) return { spoken: text, floorHold: false };
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  return {
    spoken: (before + after).replace(/\s{2,}/g, " ").trim(),
    floorHold: /\bhold\b/i.test(m[0]),
  };
}


function splitInterestTag(text: string): {
  spoken: string;
  tagBody: string | null;
} {
  const m = text.match(INTEREST_TAG_RE);
  if (!m || m.index === undefined) return { spoken: text, tagBody: null };
  return {
    spoken: text.slice(0, m.index).trim(),
    tagBody: (m[1] || "").trim(),
  };
}

// ── One-speaker-per-turn runtime guard ──────────────────────────────────────
// The prompt says exactly one panelist speaks per turn, but the model very
// occasionally emits a second "Name:" prefix mid-response ("...makes sense.
// Sarah: But what about churn?"). The streaming pipeline locks the speaker/voice
// on the FIRST prefix only, so without this guard the second panelist's words
// would be spoken aloud in the FIRST panelist's voice — a wrong-persona line.
// This detects an intruding panelist prefix that is NOT the current speaker and
// cuts the text just before it, dropping the stray second turn. Conservative:
// only the three known panel names are treated as speaker prefixes, and only
// when followed by a colon, so ordinary mentions ("as Sarah said") never match.
const SECOND_SPEAKER_RE = new RegExp(
  `(?:^|[\\s"'([-])(${PANELIST_NAMES.join("|")})\\s*:`,
  "i",
);

function cutAtSecondSpeaker(text: string, currentSpeaker: string): string {
  const m = text.match(SECOND_SPEAKER_RE);
  if (!m || m.index === undefined) return text;
  const intruder = m[1];
  // A prefix for the SAME speaker (model repeating its own name) is harmless —
  // let the normal prefix-strip handle it; only cut on a DIFFERENT panelist.
  if (intruder.toLowerCase() === currentSpeaker.toLowerCase()) return text;
  // Keep everything up to (not including) the intruding prefix.
  const cutAt = m.index + (m[0].length - m[0].trimStart().length);
  return text.slice(0, cutAt).trim();
}

function parseInterestTag(tagBody: string): {
  panelist: string;
  state: InterestState;
  concern: string | null;
} | null {
  const m = tagBody.match(
    /^[\s:=-]*([A-Za-z]+)\s*=\s*(warming|neutral|cooling|out)\s*(?:\|\s*concern:\s*(.+))?/i,
  );
  if (!m) return null;
  const panelist = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return {
    panelist,
    state: m[2].toLowerCase() as InterestState,
    concern: m[3]?.trim() || null,
  };
}

// ── Verdict classification (invest / pass / maybe) ──────────────────────────
// The verdict prompt tells each panelist to say "I'm in because…" or "I'm out
// because…". Tier 1 reads those canonical stance phrases first, so a double-
// negative like "I won't pass on this opportunity — I'm in" correctly resolves
// to invest (the explicit "I'm in" wins over the earlier "pass"). Tier 2 then
// applies keyword heuristics for natural phrasings that don't use the exact
// canonical form. Returns "maybe" (amber, genuinely on the fence) when neither
// tier fires.
function classifyPanelVerdict(lowerText: string): "invest" | "pass" | "maybe" {
  // Tier 1 — canonical stance phrases (highest confidence).
  const hasCanonicalIn = /\b(i'?m in|i am in|count me in|we'?re in)\b/.test(
    lowerText,
  );
  const hasCanonicalOut = /\b(i'?m out|i am out)\b/.test(lowerText);
  if (hasCanonicalIn && !hasCanonicalOut) return "invest";
  if (hasCanonicalOut && !hasCanonicalIn) return "pass";

  // Tier 2 — keyword heuristics for natural but non-canonical phrasings.
  if (
    /\b(not invest|can'?t invest|cannot invest|won'?t invest|decline|pass on this|i'?ll pass|i pass|a pass\b|to pass\b|hard pass|no deal(?![\s\-–—]*[-–—]?\s*(killer|breaker))|walk away|not a fit|no thanks)\b/i.test(
      lowerText,
    )
  ) {
    return "pass";
  }
  if (
    /\b(invest|fund|back this|green light|sign me up|let'?s do it)\b/i.test(
      lowerText,
    )
  ) {
    return "invest";
  }
  return "maybe";
}

function parseSpeakerResponse(
  aiResponse: string,
  isCoach: boolean,
): { speaker: string; spokenText: string } {
  let speaker = isCoach ? "Riley" : "Marcus";
  let spokenText = aiResponse.trim();

  const colonIndex = spokenText.indexOf(":");
  if (colonIndex !== -1 && colonIndex < 24) {
    const candidate = spokenText.substring(0, colonIndex).trim();
    if (/^[A-Za-z][A-Za-z\s'-]{0,20}$/.test(candidate)) {
      speaker =
        candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
      spokenText = spokenText.substring(colonIndex + 1).trim();
    }
  }

  const detected = detectSpeaker(spokenText);
  if (detected.speaker) {
    speaker = detected.speaker;
    spokenText = detected.text;
  }

  const sanitized = sanitizeAiSpeech(spokenText);
  spokenText = sanitized || spokenText;

  return { speaker, spokenText };
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

type QueuedTurn = {
  text: string;
  timeLeft?: number;
  inputMethod?: "voice" | "chat";
  isVerdict?: boolean;
  isGreeting?: boolean;
  isNudge?: boolean;
  panelists?: any[];
  // Voice end-session: a canned line spoken directly (no LLM), reusing the
  // greeting's singleChunkStream path. `endAfter` marks the closing remark —
  // after its audio is queued, the server signals the client to conclude.
  isCanned?: boolean;
  endAfter?: boolean;
};

// ── Per-user concurrency cap ───────────────────────────────────────────────
// Prevents a single user from running many concurrent sessions (billing abuse).
const MAX_WS_PER_USER = 3;
const activeWsByUser = new Map<number, Set<WebSocket>>();

function trackUserWs(userId: number, ws: WebSocket) {
  if (!activeWsByUser.has(userId)) activeWsByUser.set(userId, new Set());
  activeWsByUser.get(userId)!.add(ws);
}
function untrackUserWs(userId: number, ws: WebSocket) {
  const set = activeWsByUser.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) activeWsByUser.delete(userId);
  }
}

export function initRestSocket(wss: WebSocketServer) {
  wss.on("connection", async (ws, req: IncomingMessage) => {
    // ── JWT Authentication ──────────────────────────────────────────────────
    // Clients must pass ?token=<JWT> as a query param on the WS URL.
    // Without a valid token the connection is closed immediately.
    let authenticatedUserId: number | null = null;
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");
      if (!token) {
        sendJson(ws, { type: "error", message: "Authentication required.", code: "AUTH_REQUIRED" });
        ws.close(4001, "Authentication required");
        return;
      }
      const decoded = jwt.verify(token, config.jwtSecret) as { id: number; email: string };
      authenticatedUserId = decoded.id;

      // Concurrency cap
      const existing = activeWsByUser.get(authenticatedUserId);
      if (existing && existing.size >= MAX_WS_PER_USER) {
        sendJson(ws, { type: "error", message: "Too many active sessions. Close an existing session first.", code: "TOO_MANY_SESSIONS" });
        ws.close(4002, "Too many sessions");
        return;
      }
      trackUserWs(authenticatedUserId, ws);
    } catch (err) {
      sendJson(ws, { type: "error", message: "Invalid or expired token.", code: "AUTH_FAILED" });
      ws.close(4001, "Authentication failed");
      return;
    }

    let currentVideoUrl = "";
    let currentBusinessName = "Unknown Pitch";
    let currentUserId: number | null = authenticatedUserId;
    let hasSentSetup = false;
    let sessionId = 0;
    let resolvedDeckText = "";
    let masterPrompt = "";
    // Background web research. Fired without awaiting at client_ready; when it
    // resolves, the master prompt is recomposed so LATER turns can ground
    // market/competitor talk in real, dated web results. No turn ever waits.
    let marketSnapshot: MarketSnapshot | null = null;
    let liveConfig: any = null;
    let isCoachMode = false;
    let isSoloMode = false;
    let sessionMode = "panel";
    // Re-pitch: compact setup snapshot saved with the session so future
    // "Pitch Again" clicks can prefill the setup form; parent link + clamped
    // previous-attempt context when this session IS a re-pitch.
    let pitchConfigSnapshot: any = null;
    let parentSessionId: number | null = null;
    let previousSessionCtx: ReturnType<typeof clampPreviousSession> = null;
    let sttRecognizer: StreamingRecognizer | null = null;

    const conversationHistory: any[] = [];
    const fullTranscript: any[] = [];

    const turnQueue: QueuedTurn[] = [];
    let processingQueue = false;

    let lastUserActivityTime = Date.now();
    let hasNudged = false;
    let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
    let sessionStartTimestamp = Date.now();
    let initialDurationSeconds = 15 * 60;
    let sessionEnded = false;

    // ── Voice-triggered end-of-session (additive; parallel to the manual End
    // Session button) ──────────────────────────────────────────────────────
    // When the founder's transcript expresses end-intent, the lead panelist
    // asks them to confirm out loud — the session NEVER ends on the trigger
    // alone. While this flag is set, the founder's next utterance is routed to
    // the confirmation classifier instead of a normal pitch turn:
    //   affirm  → panel gives a short closing remark, then we signal the client
    //             to run its existing conclusion/report flow.
    //   decline → flag clears and that utterance is processed as a normal turn.
    // Panel/coach only — solo mode has no live panel to confirm with.
    let awaitingEndConfirm = false;

    // ── Two-step AI interruption (Item D) ──────────────────────────────────
    // When a panelist interjects, it signals INTENT ONLY ("hold on, I have a
    // question") and sets floorHeldByPanel via the @@FLOOR hold tag. While the
    // floor is held, the founder's next utterance is routed through the
    // hand-back matcher instead of the LLM: it is NOT treated as pitch content
    // until the founder explicitly yields ("go ahead", "ask away"). Only then
    // does the panel ask the actual question and the founder's answer resumes
    // as normal pitch content. This mirrors the founder-interrupts-AI barge-in
    // (one side holds the floor, the other releases it). floorReSignaled bounds
    // the mechanic: if the founder keeps pitching through the intent line, the
    // panel re-signals once, then asks anyway — never an infinite ping-pong.
    let floorHeldByPanel = false;
    let floorReSignaled = false;

    // Server clock is the authority for AI time metadata; the client clock
    // ends phases. time_sync pushes (idle interval below) bound the drift.
    const getTimeLeftSeconds = () =>
      Math.max(
        0,
        initialDurationSeconds -
          Math.floor((Date.now() - sessionStartTimestamp) / 1000),
      );

    // Evaluation can be pre-started (in parallel with the verdict phase) so the
    // report is ready by the time the panel finishes speaking. See the
    // `prepare_evaluation` handler and `end_session` below.
    let evaluationPromise: Promise<any> | null = null;

    // Barge-in: aborts the in-flight AI turn (LLM generation + TTS streaming).
    // Set when processing a standard turn; triggered by an `interrupt` message
    // or an STT partial transcript. See processAiTurn and the message handler.
    let currentTurnAbort: AbortController | null = null;

    // ── Phase 2: per-panelist interest state (panel mode only) ─────────────
    // Fed by the @@INTEREST machine tag on each panel turn. "out" is sticky.
    // The timeline + the unprompted-selling counter feed the report's
    // room_read_note; panelConcerns grounds the circle-back behavior.
    const panelInterest: Record<string, InterestState> = {
      Marcus: "neutral",
      Sarah: "neutral",
      Chen: "neutral",
    };
    const panelConcerns: Record<string, string | null> = {
      Marcus: null,
      Sarah: null,
      Chen: null,
    };
    const interestTimeline: Array<{
      atSeconds: number;
      panelist: string;
      state: InterestState;
    }> = [];
    // The greeting invites the pitch, so the founder's first turn is prompted.
    let lastPanelTurnHadQuestion = true;
    let unpromptedSellingTurns = 0;

    // One-shot proactive time cues (halfway check-in, two-minute wrap-up) —
    // fired from the idle interval so the AI manages the clock out loud
    // instead of the session just hitting 0:00 mid-conversation.
    let halfwayCueSent = false;
    let wrapUpCueSent = false;

    const handleInterestTag = (tagBody: string) => {
      if (isCoachMode || isSoloMode) return;
      const parsed = parseInterestTag(tagBody);
      if (!parsed || !(parsed.panelist in panelInterest)) return;
      const { panelist, state, concern } = parsed;
      if (panelInterest[panelist] === "out") return; // out is permanent
      const changed = panelInterest[panelist] !== state;
      panelInterest[panelist] = state;
      panelConcerns[panelist] = state === "out" ? null : concern;
      if (changed) {
        interestTimeline.push({
          atSeconds: Math.floor((Date.now() - sessionStartTimestamp) / 1000),
          panelist,
          state,
        });
        sendJson(ws, { type: "panel_interest", states: { ...panelInterest } });
      }
    };

    // "[PANEL STATE: ...]" metadata prepended to founder turns once any
    // panelist has moved off neutral — grounded memory of who is warming,
    // cooling, or out, and which concerns are still open.
    const buildPanelStateLine = (): string => {
      const anySignal = PANELIST_NAMES.some(
        (p) => panelInterest[p] !== "neutral" || panelConcerns[p],
      );
      if (!anySignal) return "";
      const parts = PANELIST_NAMES.map((p) => {
        const c = panelConcerns[p]
          ? ` (unresolved concern: ${panelConcerns[p]})`
          : "";
        return `${p}=${panelInterest[p]}${c}`;
      });
      return `[PANEL STATE: ${parts.join(", ")}]`;
    };

    // Room-read signal (Derek Cousins failure mode): the founder volunteering
    // NEW selling content with no open question while ≥2 panelists have
    // cooled is overselling a dead room. Answering a question never counts.
    const noteFounderTurnForRoomRead = () => {
      if (isCoachMode || isSoloMode || sessionEnded) return;
      const lowInterest = PANELIST_NAMES.filter(
        (p) => panelInterest[p] === "cooling" || panelInterest[p] === "out",
      ).length;
      if (!lastPanelTurnHadQuestion && lowInterest >= 2) {
        unpromptedSellingTurns++;
      }
    };

    const buildRoomReadNote = (): string | undefined => {
      if (isCoachMode || isSoloMode) return undefined;
      if (unpromptedSellingTurns >= 2) {
        return `You kept pitching new selling points after the panel had cooled. When investors disengage, pause and ask what's holding them back.`;
      }
      // Praise path: a panelist cooled and was later won back.
      const cooledAt: Record<string, number> = {};
      for (const e of interestTimeline) {
        if (e.state === "cooling") cooledAt[e.panelist] = e.atSeconds;
        if (e.state === "warming" && cooledAt[e.panelist] !== undefined) {
          return `Good room-reading: when ${e.panelist} cooled on the deal, you adjusted and won back interest instead of pushing harder.`;
        }
      }
      return undefined;
    };

    console.log(
      "✅ Client connected to PitchNest Brain (Azure OpenAI + Azure TTS)",
    );

    if (!hasOpenAiConfig()) {
      console.error("🚨 CRITICAL: AI provider env vars are missing");
      sendJson(ws, {
        type: "error",
        message:
          "AI is not configured on the server. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT.",
        code: "AI_NOT_CONFIGURED",
      });
    }

    if (!hasAzureTtsConfig()) {
      console.error(
        "🚨 CRITICAL: Azure TTS env vars are missing — voice output disabled",
      );
      sendJson(ws, {
        type: "error",
        message:
          "Voice output is not configured on the server. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
        code: "TTS_NOT_CONFIGURED",
      });
    }

    ws.on("close", () => {
      console.log("🔌 Client disconnected.");
      if (authenticatedUserId) untrackUserWs(authenticatedUserId, ws);
      if (idleCheckInterval) clearInterval(idleCheckInterval);
      if (sttRecognizer) sttRecognizer.stop();
    });

    sendJson(ws, { type: "status", status: "vertex_ready" });

    const processAiTurn = async (turn: QueuedTurn) => {
      // Solo (practice) mode: never run a live AI turn. The server only
      // receives/stores the founder's audio + transcript (handled in the
      // message handler) and produces an after-the-fact report at session end.
      // No greeting, panel/coach turn, nudge, or verdict is ever generated, and
      // no audio/transcript/turn message is sent back during the session — even
      // if the founder says "Sarah" or "Chen", there is no panel to summon.
      // This is the single, authoritative guard: any turn that reaches the queue
      // in solo mode is silently dropped here regardless of how it was enqueued.
      if (isSoloMode) {
        return;
      }

      if (!hasOpenAiConfig()) {
        sendJson(ws, {
          type: "error",
          message: "AI is not configured on the server.",
          code: "AI_NOT_CONFIGURED",
        });
        sendJson(ws, { type: "turn_complete" });
        return;
      }

      try {
        const userInput = buildUserTurnInput(turn.text, turn.timeLeft);

        // Removed hardcoded greeting block to let it fall through to streaming pipeline

        if (turn.isVerdict) {
          const aiResponse = (
            await generatePanelResponse(
              userInput,
              conversationHistory.slice(-MAX_LLM_HISTORY),
              masterPrompt,
            )
          )
            .replace(/@@INTEREST[^\n]*/gi, "")
            .trim();
          conversationHistory.push({ role: "user", text: userInput });
          conversationHistory.push({ role: "assistant", text: aiResponse });

          const panelists = turn.panelists || [
            { name: "Marcus" },
            { name: "Sarah" },
            { name: "Chen" },
          ];
          const panelistNames = panelists.map((p: any) => p.name);

          // In verdict mode, we need to extract each panelist's verdict and send them sequentially
          for (const pName of panelistNames) {
            let panelistText = "";
            const nameRegex = new RegExp(
              `${pName}[:\\s]+(.+?)(?=(?:${panelistNames.join("|")})[:\\s]|$)`,
              "is",
            );
            const nameMatch = aiResponse.match(nameRegex);

            if (nameMatch) {
              panelistText = nameMatch[1].trim();
            } else {
              if (panelists.length === 1) {
                panelistText = aiResponse
                  .replace(/^(Riley|Marcus|Coach)[\s:]+/i, "")
                  .trim();
              } else {
                continue;
              }
            }

            panelistText = sanitizeAiSpeech(panelistText) || panelistText;

            const lowerText = panelistText.toLowerCase();
            let verdictVerdict: "invest" | "pass" | "maybe" =
              classifyPanelVerdict(lowerText);

            // Send verdict text to UI
            sendJson(ws, {
              type: "verdict_message",
              speaker: pName,
              text: panelistText.substring(0, 300),
              verdict: verdictVerdict,
            });

            // Synthesize audio for this panelist's verdict
            if (isTtsConfigured() && panelistText.trim()) {
              try {
                const vName = resolveVoiceName(pName);
                const buf = await synthesizeSpeech(panelistText, vName);
                const base64Audio = Buffer.from(buf).toString("base64");
                // DO NOT pass `text: panelistText` here to avoid duplicating the verdict message!
                sendJson(ws, {
                  type: "audio",
                  data: base64Audio,
                  speaker: pName,
                });
              } catch (e) {
                console.error("Verdict TTS error:", e);
              }
            }
          }
          sendJson(ws, { type: "verdict_complete" });
          return;
        }

        // ── TURBO-STREAMING PIPELINE FOR STANDARD TURNS ──
        // Fresh abort controller for this turn — barge-in cancels it.
        const turnAbort = new AbortController();
        currentTurnAbort = turnAbort;

        // Latency instrumentation: separates code-side delay (first token /
        // first audio) from network or Azure-side delay when sessions feel slow.
        const turnStartedAt = Date.now();
        let firstTokenAt = 0;
        let firstAudioAt = 0;

        let currentSentenceBuffer = "";
        let isFirstChunk = true;
        let activeSpeaker = isCoachMode ? "Riley" : "Marcus";
        let activeVoiceName = resolveVoiceName(activeSpeaker);
        let fullSpokenText = "";
        let chunksProcessed = 0;
        let ttsPromiseChain = Promise.resolve();

        // Two-step interruption (Item D): set when this turn's @@FLOOR hold tag
        // is seen. Committed to floorHeldByPanel after the turn completes, only
        // if the panel actually held back its question (no "?" was spoken).
        let floorHoldSignaled = false;

        let promptToUse = masterPrompt;
        let userInputToUse = userInput;

        // Panel-state metadata: grounded memory of who is warming/cooling/out
        // and which concerns are still open. Panel turns only.
        if (!isCoachMode && !turn.isGreeting) {
          const stateLine = buildPanelStateLine();
          if (stateLine) userInputToUse = `${stateLine}\n${userInputToUse}`;
        }

        // Greeting: speak a varied, code-chosen "Welcome to the Nest" line
        // directly (no LLM call) so the opening is consistent on brand, varied
        // each session, and instant. It still flows through the normal
        // sentence/TTS pipeline via singleChunkStream.
        // Canned (voice end-session confirm / closing): same direct-speak path
        // as the greeting — turn.text already holds the exact line + speaker.
        const stream =
          turn.isGreeting
            ? singleChunkStream(
                `${isCoachMode ? "Riley" : "Marcus"}: ${pickGreeting(isCoachMode, currentBusinessName, !!previousSessionCtx)}`,
              )
            : turn.isCanned
              ? singleChunkStream(turn.text)
              : streamPanelResponse(
                  userInputToUse,
                  conversationHistory.slice(-MAX_LLM_HISTORY),
                  promptToUse,
                  turnAbort.signal,
                );

        for await (const token of stream) {
          if (turnAbort.signal.aborted) break;
          if (!firstTokenAt) firstTokenAt = Date.now();
          currentSentenceBuffer += token;

          // 1. On the very first burst, extract the speaker identity if it exists
          if (isFirstChunk && currentSentenceBuffer.length > 5) {
            const colonIndex = currentSentenceBuffer.indexOf(":");
            if (colonIndex !== -1 && colonIndex < 24) {
              const candidate = currentSentenceBuffer
                .substring(0, colonIndex)
                .trim();
              if (/^[A-Za-z][A-Za-z\s'-]{0,20}$/.test(candidate)) {
                activeSpeaker =
                  candidate.charAt(0).toUpperCase() +
                  candidate.slice(1).toLowerCase();
                activeVoiceName = resolveVoiceName(activeSpeaker);
                // Strip the prefix
                currentSentenceBuffer = currentSentenceBuffer
                  .substring(colonIndex + 1)
                  .trimStart();
              }
              isFirstChunk = false;
            } else if (currentSentenceBuffer.length > 25) {
              // Give up on finding a colon if text gets too long
              isFirstChunk = false;
            }
          }

          // 2. Look for sentence boundaries to chunk audio seamlessly
          const boundaryMatch = currentSentenceBuffer.match(
            /([.!?]+[\"']?(?:\s+|\n+))/,
          );
          if (!isFirstChunk && boundaryMatch) {
            const boundaryIndex =
              boundaryMatch.index! + boundaryMatch[0].length;
            const sentence = currentSentenceBuffer
              .substring(0, boundaryIndex)
              .trim();
            currentSentenceBuffer = currentSentenceBuffer
              .substring(boundaryIndex)
              .trimStart();

            // Intercept the @@INTEREST machine tag before anything reaches
            // TTS or the transcript (its line has no sentence punctuation, so
            // it normally surfaces in the final-buffer flush — this guard
            // covers the rare mid-stream case too).
            const { spoken: afterFloor, floorHold: midFloor } =
              splitFloorTag(sentence);
            if (midFloor) floorHoldSignaled = true;
            const { spoken: spokenPart, tagBody: midTag } =
              splitInterestTag(afterFloor);
            if (midTag !== null) handleInterestTag(midTag);

            // One-speaker-per-turn guard: if a second panelist's prefix leaked
            // into this sentence, cut it off and stop the turn so the intruding
            // line is never spoken in the current speaker's voice.
            let guardedSpoken = spokenPart;
            let secondSpeakerHit = false;
            if (!isCoachMode && spokenPart) {
              const cut = cutAtSecondSpeaker(spokenPart, activeSpeaker);
              if (cut !== spokenPart) {
                guardedSpoken = cut;
                secondSpeakerHit = true;
              }
            }

            if (guardedSpoken.length > 0) {
              const cleanSentence =
                sanitizeAiSpeech(guardedSpoken) || guardedSpoken;
              fullSpokenText += (fullSpokenText ? " " : "") + cleanSentence;
              chunksProcessed++;

              if (isTtsConfigured()) {
                const currentVoice = activeVoiceName;
                const currentText = cleanSentence;
                const currentSpeaker = activeSpeaker;

                // Chain TTS calls so audio chunks are always sent in the exact correct order
                ttsPromiseChain = ttsPromiseChain.then(async () => {
                  if (turnAbort.signal.aborted) return;
                  try {
                    const buf = await synthesizeSpeech(
                      currentText,
                      currentVoice,
                    );
                    if (turnAbort.signal.aborted) return;
                    const base64Audio = Buffer.from(buf).toString("base64");
                    if (!firstAudioAt) firstAudioAt = Date.now();
                    sendJson(ws, {
                      type: "audio",
                      data: base64Audio,
                      text: currentText,
                      speaker: currentSpeaker,
                    });
                  } catch (e) {
                    console.error("TTS Stream Error:", e);
                  }
                });
              } else {
                sendJson(ws, {
                  type: "transcript",
                  text: cleanSentence,
                  speaker: activeSpeaker,
                });
              }
            }

            // Drop the rest of the model output for this turn — the buffer from
            // here on belongs to a second panelist that must not speak now.
            if (secondSpeakerHit) {
              currentSentenceBuffer = "";
              break;
            }
          }
        }

        // 3. Process the final remaining chunk in the buffer (skip if barged in).
        // The @@INTEREST tag has no sentence punctuation, so this is where it
        // normally lands — split it off before the text can reach TTS.
        const { spoken: finalAfterFloor, floorHold: finalFloor } = splitFloorTag(
          currentSentenceBuffer.trim(),
        );
        if (finalFloor) floorHoldSignaled = true;
        const { spoken: finalSpokenPart, tagBody: finalTag } = splitInterestTag(
          finalAfterFloor,
        );
        if (!turnAbort.signal.aborted && finalTag !== null) {
          handleInterestTag(finalTag);
        }
        // Same one-speaker-per-turn guard as the mid-stream path: a short second
        // panelist interjection with no sentence punctuation lands here.
        const finalGuardedPart =
          !isCoachMode && finalSpokenPart
            ? cutAtSecondSpeaker(finalSpokenPart, activeSpeaker)
            : finalSpokenPart;
        if (!turnAbort.signal.aborted && finalGuardedPart.length > 0) {
          const cleanSentence =
            sanitizeAiSpeech(finalGuardedPart) || finalGuardedPart;
          fullSpokenText += (fullSpokenText ? " " : "") + cleanSentence;
          chunksProcessed++;

          if (isTtsConfigured()) {
            ttsPromiseChain = ttsPromiseChain.then(async () => {
              if (turnAbort.signal.aborted) return;
              try {
                const buf = await synthesizeSpeech(
                  cleanSentence,
                  activeVoiceName,
                );
                if (turnAbort.signal.aborted) return;
                const base64Audio = Buffer.from(buf).toString("base64");
                if (!firstAudioAt) firstAudioAt = Date.now();
                sendJson(ws, {
                  type: "audio",
                  data: base64Audio,
                  text: cleanSentence,
                  speaker: activeSpeaker,
                });
              } catch (e) {
                console.error("Final TTS Error:", e);
              }
            });
          } else {
            sendJson(ws, {
              type: "transcript",
              text: cleanSentence,
              speaker: activeSpeaker,
            });
          }
        }

        // Answer-tip (non-blocking): generate a short, AI-powered coaching card
        // for THIS question and stream it to the client. Fired here so it runs
        // in parallel with the TTS playback below — it is NEVER awaited, so it
        // adds zero latency to the panel's voice. Skipped for greetings/nudges
        // and canned end-session lines (none are real pitch questions). The
        // client falls back to its local keyword card if this never arrives
        // (slow/failed), so the tip layer can't break.
        if (!turn.isGreeting && !turn.isNudge && !turn.isCanned && fullSpokenText.trim()) {
          const tipQuestion = fullSpokenText;
          generateAnswerTip(tipQuestion, currentBusinessName)
            .then((tip) => {
              if (tip) sendJson(ws, { type: "answer_tip", ...tip });
            })
            .catch(() => {});
        }

        // 4. Wait for the sequential TTS delivery pipeline to completely finish
        await ttsPromiseChain;

        console.log(
          `[turn] first token ${firstTokenAt ? firstTokenAt - turnStartedAt : -1}ms, ` +
            `first audio ${firstAudioAt ? firstAudioAt - turnStartedAt : -1}ms, ` +
            `total ${Date.now() - turnStartedAt}ms, history ${conversationHistory.length}${turn.isGreeting ? " (greeting)" : ""}`,
        );

        const wasAborted = turnAbort.signal.aborted;
        if (currentTurnAbort === turnAbort) currentTurnAbort = null;

        // Room-read tracking: does the panel currently have a question on the
        // table? A founder speaking after a statement-only panel turn while
        // the room has cooled counts as unprompted selling.
        if (!isCoachMode && !turn.isGreeting && fullSpokenText.trim()) {
          lastPanelTurnHadQuestion = /\?/.test(fullSpokenText);
        }

        // Two-step interruption (Item D): commit the floor hold. The panel
        // signals intent with @@FLOOR hold AND keeps STEP 1 to a short intent
        // line (no substantive question yet). We hold only when the spoken line
        // is short — an intent line ("Sorry, can I jump in?") is a handful of
        // words, whereas a full pitch question is long. If the model tagged the
        // turn but asked a real question anyway, the length guard declines the
        // hold so the founder's answer is never mistaken for a hand-back.
        const floorHoldWordCount = fullSpokenText.trim()
          ? fullSpokenText.trim().split(/\s+/).length
          : 0;
        if (
          floorHoldSignaled &&
          !wasAborted &&
          !turn.isGreeting &&
          !turn.isCanned &&
          !isCoachMode &&
          floorHoldWordCount > 0 &&
          floorHoldWordCount <= 16
        ) {
          floorHeldByPanel = true;
          floorReSignaled = false;
          console.log(
            "🎙 Two-step interruption: panel signaled intent, floor held until founder hands it back.",
          );
        }

        // 5. Update histories (record whatever was actually spoken, even if the
        // turn was cut short by a barge-in, so context stays coherent).
        // Greetings and canned lines have no founder input to record; canned
        // lines (end-confirm/closing) are also kept out of the LLM history so
        // they never bias a later pitch turn.
        if (!turn.isGreeting && !turn.isCanned) {
          conversationHistory.push({ role: "user", text: userInput });
        }
        if (!turn.isCanned) {
          conversationHistory.push({ role: "assistant", text: fullSpokenText });
        }
        if (fullSpokenText.trim()) {
          fullTranscript.push({
            type: "model",
            speaker: activeSpeaker,
            text: fullSpokenText,
          });
        }

        // Clear turn boundary marker so the client knows it's safe to resume
        // sending audio for the next turn.
        if (wasAborted) {
          sendJson(ws, { type: "turn_aborted" });
        } else {
          sendJson(ws, { type: "turn_complete", audioChunks: chunksProcessed });
        }

        // Voice end-session: the closing remark has now finished streaming to
        // the client. Signal it to run its EXISTING conclusion flow (the same
        // one the manual End Session button triggers) — we reuse, never
        // duplicate, the verdict/report path. Skipped if the founder barged in.
        if (turn.endAfter && !wasAborted) {
          sendJson(ws, { type: "voice_end_session" });
        }
      } catch (err: any) {
        if (currentTurnAbort) currentTurnAbort = null;
        console.error("❌ Error generating AI response:", err);
        sendJson(ws, {
          type: "error",
          message: "Failed to generate AI response. Please try again.",
          code: "AI_FAILED",
        });
        sendJson(ws, { type: "turn_complete" });
      }
    };

    const drainTurnQueue = async () => {
      if (processingQueue) return;
      processingQueue = true;
      try {
        while (turnQueue.length > 0) {
          const nextTurn = turnQueue.shift()!;
          await processAiTurn(nextTurn);
        }
      } finally {
        processingQueue = false;
        if (turnQueue.length > 0) {
          void drainTurnQueue();
        }
      }
    };

    const enqueueTurn = (turn: QueuedTurn) => {
      turnQueue.push(turn);
      void drainTurnQueue();
    };

    // ── Per-connection AI-turn rate limiting (Item B) ──────────────────────
    // Each founder-driven turn triggers an expensive LLM stream + TTS synthesis,
    // and turns drain serially. A buggy or malicious client that floods
    // `chat_message` frames could bury the founder's real input behind a huge
    // backlog and amplify cost. A token bucket smooths bursts; a hard pending-
    // queue cap bounds the serial-drain backlog. Both gate ONLY typed chat_message
    // turns — the sole client-rate-controlled AI-turn vector. Server-generated
    // turns (greeting, nudges, time cues, closing) are self-paced and never
    // throttled, and final STT turns are paced by Azure's recognizer (gating them
    // would risk silently dropping a fast talker's recognized speech). Capacities
    // sit far above any real human chat cadence, so a legitimate founder — who
    // sends at most a message every few seconds — can never hit them.
    const TURN_BUCKET_CAPACITY = 12;
    const TURN_BUCKET_REFILL_PER_SEC = 1;
    const MAX_PENDING_FOUNDER_TURNS = 8;
    let turnTokens = TURN_BUCKET_CAPACITY;
    let lastTokenRefill = Date.now();

    // Returns true if a founder chat turn is allowed, false if it should be
    // dropped as a flood. A dropped turn skips only the expensive AI response —
    // the founder's text is still recorded and echoed by the caller.
    const allowFounderChatTurn = (): boolean => {
      const now = Date.now();
      const elapsedSec = (now - lastTokenRefill) / 1000;
      if (elapsedSec > 0) {
        turnTokens = Math.min(
          TURN_BUCKET_CAPACITY,
          turnTokens + elapsedSec * TURN_BUCKET_REFILL_PER_SEC,
        );
        lastTokenRefill = now;
      }
      if (turnQueue.length >= MAX_PENDING_FOUNDER_TURNS) return false;
      if (turnTokens < 1) return false;
      turnTokens -= 1;
      return true;
    };

    // ── Voice end-session router ────────────────────────────────────────────
    // Called with each FINAL founder utterance (STT voice + typed chat) before
    // it becomes a normal pitch turn. Returns true when it has consumed the
    // utterance (the caller must then NOT enqueue a normal turn for it).
    // Solo mode has no live panel, so it never intercepts there.
    const handleEndSessionVoiceFlow = (text: string): boolean => {
      if (isSoloMode || sessionEnded) return false;
      const speaker = isCoachMode ? "Riley" : "Marcus";

      // Step 2: we already asked the founder to confirm — classify their reply.
      if (awaitingEndConfirm) {
        awaitingEndConfirm = false;
        const reply = classifyConfirmationReply(text);
        if (reply === "affirm") {
          // Speak a short closing remark, then signal the client to conclude.
          const closing = isCoachMode ? pickLine(COACH_CLOSING) : pickLine(PANEL_CLOSING);
          enqueueTurn({
            text: `${speaker}: ${closing}`,
            isCanned: true,
            endAfter: true,
          });
          return true; // consumed — do not run this reply as a pitch turn
        }
        // Declined or ambiguous → resume the pitch. Fall through so the
        // utterance is processed as a normal turn (the founder kept talking).
        return false;
      }

      // Step 1: detect end-intent in a normal utterance. Ask to confirm — never
      // end here. The trigger phrase itself is NOT sent to the LLM as a turn.
      if (detectEndSessionIntent(text)) {
        awaitingEndConfirm = true;
        const confirm = isCoachMode ? pickLine(COACH_END_CONFIRM) : pickLine(PANEL_END_CONFIRM);
        enqueueTurn({ text: `${speaker}: ${confirm}`, isCanned: true });
        return true; // consumed
      }

      return false;
    };

    // ── Two-step interruption: floor-hold router (Item D) ───────────────────
    // Called with each FINAL founder utterance (STT voice + typed chat) while
    // floorHeldByPanel is true — i.e. right after the panel signaled intent but
    // has not yet asked its held question. Returns true when the utterance was
    // consumed (the caller must then NOT enqueue it as a normal pitch turn, and
    // must still record + echo it so the founder sees they were heard).
    //
    //   hand-back  → clear the hold; enqueue a SYSTEM turn telling the panel to
    //                now ask the question it held. The hand-back words are not
    //                pitch content.
    //   kept going → the founder's words are NOT pitch content while the floor
    //                is held: not fed to the LLM as input. The panel re-signals
    //                intent once (canned); if the founder STILL does not hand
    //                back, the panel asks anyway (bounded, no ping-pong).
    const handleFloorHeldUtterance = (text: string, inputMethod: "voice" | "chat"): boolean => {
      if (!floorHeldByPanel) return false;

      if (detectFloorHandback(text)) {
        floorHeldByPanel = false;
        floorReSignaled = false;
        // A [SYSTEM] turn is a normal LLM turn (not canned) so the panel
        // generates the actual question, grounded in what the founder said
        // before the interruption — not a stock line.
        enqueueTurn({
          text: isCoachMode
            ? `[SYSTEM: The founder just handed you the floor back. Riley — now ask the question you were going to interrupt with. ONE short spoken question, then stop.]`
            : `[SYSTEM: The founder just handed the floor back to the panel. The panelist who interrupted — ask the question you were holding. ONE short spoken question, one speaker, then stop.]`,
          inputMethod: "chat",
        });
        console.log(
          "🎙 Two-step interruption: founder handed the floor back — panel asks its held question.",
        );
        return true; // consumed — the hand-back is not pitch content
      }

      // Founder kept talking (or answered the wrong thing) without yielding.
      // Their words are not pitch content: do not feed them to the LLM.
      if (floorReSignaled) {
        // Already re-signaled once and still no hand-back — ask anyway.
        floorHeldByPanel = false;
        floorReSignaled = false;
        enqueueTurn({
          text: isCoachMode
            ? `[SYSTEM: The founder kept talking after your interruption. Riley — go ahead and ask your question now. ONE short spoken question, one speaker, then stop.]`
            : `[SYSTEM: The founder kept talking after the interruption without handing the floor back. The interrupting panelist — go ahead and ask your question now. ONE short spoken question, one speaker, then stop.]`,
          inputMethod: "chat",
        });
        console.log(
          "🎙 Two-step interruption: founder did not hand back after re-signal — panel asks anyway.",
        );
        return true; // consumed — still not pitch content
      }

      // First no-handback: re-signal intent once (canned, instant).
      floorReSignaled = true;
      const speaker = isCoachMode ? "Riley" : "Marcus";
      enqueueTurn({
        text: `${speaker}: ${
          isCoachMode ? pickLine(COACH_FLOOR_RESIGNAL) : pickLine(PANEL_FLOOR_RESIGNAL)
        }`,
        isCanned: true,
      });
      console.log(
        "🎙 Two-step interruption: founder kept talking — re-signaling intent once.",
      );
      return true; // consumed — this utterance is not pitch content
    };

    ws.on("message", async (message, isBinary) => {
      if (isBinary) {
        if (sttRecognizer && !sessionEnded) {
          sttRecognizer.pushAudio(message as Buffer);
        }
        return;
      }
      try {
        const data = JSON.parse(message.toString());

        if (sessionEnded && data.type !== "set_video_url") {
          return;
        }

        // ── Barge-in: client detected the founder talking over the panel ──
        // Abort the in-flight turn so the server stops generating + streaming
        // audio (the client has already silenced local playback).
        if (data.type === "interrupt") {
          if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
            currentTurnAbort.abort();
          }
          lastUserActivityTime = Date.now();
          hasNudged = false;
          return;
        }

        if (data.type === "set_video_url") {
          currentVideoUrl = data.url;
          if (sessionId && config.supabaseUrl && config.supabaseAnonKey) {
            try {
              await supabase
                .from("sessions")
                .update({ video_url: currentVideoUrl })
                .eq("id", sessionId);
            } catch (e) {
              console.error("Failed to async update video URL:", e);
            }
          }
          return;
        }

        if (data.type === "client_ready" && !hasSentSetup) {
          hasSentSetup = true;
          const clientConfig = data.config || {};
          currentBusinessName = clientConfig.businessName || "Unknown Pitch";
          // SECURITY: the session owner is the JWT-authenticated user established
          // at connection time — NEVER the client-supplied config.userId, which a
          // caller could set to another user's id to write sessions into their
          // account. The client value is ignored here.
          currentUserId = authenticatedUserId;
          sessionMode = clientConfig.mode || "panel";
          isCoachMode = sessionMode === "coach";
          isSoloMode = sessionMode === "solo";
          const isResume = !!data.resume;

          // Verify that the user still exists in the database (prevents deleted users
          // from pitching via WebSocket since WS bypasses Express auth middleware).
          if (currentUserId) {
            const { data: dbUser, error: userErr } = await supabase
              .from("users")
              .select("id")
              .eq("id", currentUserId)
              .maybeSingle();

            if (userErr || !dbUser) {
              console.error("❌ WS client_ready: User not found in database. Rejecting.");
              sendJson(ws, {
                type: "error",
                message: "User account no longer exists. Please log in again.",
                code: "USER_DELETED"
              });
              ws.close();
              return;
            }
          }

          // Compact setup snapshot stored with the session row so a future
          // "Pitch Again" can prefill the setup form. Deliberately excludes
          // deck text — only ids/names, keeping the row small.
          pitchConfigSnapshot = {
            mode: sessionMode,
            businessName: currentBusinessName,
            description: clientConfig.description || "",
            industry: clientConfig.industry || "",
            investorArchetype: clientConfig.investorArchetype || "",
            fundingStage: clientConfig.fundingStage || "",
            aggressiveness: clientConfig.aggressiveness ?? null,
            riskAppetite: clientConfig.riskAppetite ?? null,
            duration: clientConfig.duration ?? null,
            deckId: clientConfig.selectedDeck?.id ?? null,
            deckName: clientConfig.selectedDeck?.name ?? null,
          };

          // Re-pitch context. The client claims which session this re-pitch
          // continues from; verify the parent actually belongs to this user
          // before trusting it (WS bypasses Express auth), and clamp the
          // previous-session payload to a small fixed shape.
          parentSessionId = Number(clientConfig.parentSessionId) || null;
          previousSessionCtx = clampPreviousSession(clientConfig.previousSession);
          if (parentSessionId && currentUserId) {
            const { data: parentRow } = await supabase
              .from("sessions")
              .select("id")
              .eq("id", parentSessionId)
              .eq("user_id", currentUserId)
              .maybeSingle();
            if (!parentRow) {
              console.warn(
                `⚠️ Re-pitch parent session ${parentSessionId} not owned by user — ignoring re-pitch context.`,
              );
              parentSessionId = null;
              previousSessionCtx = null;
            }
          } else if (parentSessionId && !currentUserId) {
            // Anonymous sessions can't prove ownership of a previous session.
            parentSessionId = null;
            previousSessionCtx = null;
          }
          if (previousSessionCtx) {
            console.log(
              `🔁 Re-pitch of session ${parentSessionId} (prev score ${previousSessionCtx.overallScore}) — panel will welcome the founder back.`,
            );
          }

          // Solo (practice) mode has no live AI interaction at all — the founder
          // self-records and the session is reviewed only afterward. Skip the
          // greeting entirely so the room opens silently (no pickGreeting, no
          // greeting audio). Coach and Panel still greet as Riley / Marcus.
          // On resume (client reconnected after a refresh) the client is the
          // source of truth for the transcript. Rebuild the panel's conversation
          // memory from it so the AI keeps context, and skip the greeting so the
          // room reopens mid-session instead of re-introducing the panel.
          if (isResume && Array.isArray(data.transcript)) {
            for (const m of data.transcript) {
              const text = (m?.text || "").trim();
              if (!text) continue;
              if (m.type === "user") {
                conversationHistory.push({ role: "user", text });
              } else if (m.type === "ai") {
                conversationHistory.push({ role: "assistant", text });
              }
            }
            console.log(
              `🔁 Resume — rebuilt ${conversationHistory.length} history turns, skipping greeting`,
            );
          }

          if (isSoloMode) {
            console.log(
              "🟢 Setup complete — solo practice mode (no live AI, opening silently)...",
            );
          } else if (isResume) {
            console.log(
              "🔁 Resume — panel will continue on the founder's next turn",
            );
          } else {
            console.log("🟢 Setup complete — triggering pitch introduction...");
            enqueueTurn({ text: "", isGreeting: true });
          }

          // Always resolve the deck text — the after-the-fact evaluation needs
          // it in every mode. Only build the live master prompt when there is a
          // live AI turn to drive (panel/coach); solo never runs one, so leaving
          // masterPrompt empty avoids accidentally arming the panel prompt for a
          // solo session if a turn path is ever added later.
          //
          // rebuildMasterPrompt handles the deck/research race in either order:
          // whichever resolves last recomposes the prompt with everything
          // available at that moment.
          const rebuildMasterPrompt = () => {
            if (isSoloMode || !liveConfig) return;
            masterPrompt = getMasterPrompt(
              isCoachMode,
              currentBusinessName,
              liveConfig,
            );
            if (marketSnapshot) {
              masterPrompt += "\n" + buildMarketSnapshotBlock(marketSnapshot);
            }
          };

          resolveDeckText(clientConfig)
            .then((text) => {
              resolvedDeckText = text;
              if (isSoloMode) return;
              liveConfig = {
                ...clientConfig,
                resolvedDeckText,
                previousSession: previousSessionCtx,
              };
              rebuildMasterPrompt();
            })
            .catch((err) => console.error("Error resolving deck text:", err));

          // Fire-and-forget web research (panel + coach; solo has no live
          // turns and its coach-style report has no competitor section).
          // researchStartup never throws and resolves null when disabled.
          if (!isSoloMode) {
            researchStartup({
              businessName: currentBusinessName,
              description: clientConfig.description || "",
              industry: clientConfig.industry || "",
            })
              .then((snap) => {
                if (!snap || sessionEnded) return;
                marketSnapshot = snap;
                rebuildMasterPrompt();
                console.log(
                  `🔎 [research] Market snapshot ready (${snap.text.length} chars, retrieved ${snap.retrievedAt}) — panel grounded for later turns.`,
                );
              })
              .catch(() => {});
          }

          if (hasAzureSttConfig()) {
            sttRecognizer = createStreamingRecognizer(
              (text, confidence) => {
                if (sessionEnded) return;

                lastUserActivityTime = Date.now();
                hasNudged = false;

                for (let i = turnQueue.length - 1; i >= 0; i--) {
                  if (turnQueue[i].isNudge) turnQueue.splice(i, 1);
                }

                // Low-confidence recognitions are logged but still sent to
                // the AI — the model uses conversational context to interpret
                // accented or unclear speech far better than discarding it.
                // Only truly garbled noise (< 0.2) is skipped.
                if (confidence < LOW_STT_CONFIDENCE) {
                  console.log(
                    `[stt] very low confidence (${confidence.toFixed(2)}), skipping likely noise:`,
                    text,
                  );
                  return;
                }

                // Two-step interruption: if the panel is holding the floor, this
                // utterance is routed to the hand-back logic and is NOT pitch
                // content. It is still echoed to the transcript below.
                // End-session intent still wins over a floor hold: if the founder
                // clearly wants to end, honor that instead of the hand-back.
                const consumedByFloor =
                  floorHeldByPanel && !detectEndSessionIntent(text)
                    ? handleFloorHeldUtterance(text, "voice")
                    : false;

                // Voice end-session: if this utterance drives the end-session
                // confirm flow, it is consumed here — do NOT run it as a pitch
                // turn. The founder's words are still echoed to the transcript
                // below so they see what they said.
                const consumedByEndFlow =
                  !consumedByFloor && handleEndSessionVoiceFlow(text);
                // Hard wrap-up: in the last WRAP_UP_HARD_SEC seconds, don't start
                // a new panel turn — the founder's words are still recorded below,
                // but the panel won't fire a fresh question the buzzer would cut off.
                const inHardWrapUp =
                  !isSoloMode && getTimeLeftSeconds() <= WRAP_UP_HARD_SEC;
                if (!consumedByFloor && !consumedByEndFlow && !inHardWrapUp) {
                  noteFounderTurnForRoomRead();
                  enqueueTurn({
                    text,
                    inputMethod: "voice",
                    timeLeft: getTimeLeftSeconds(),
                  });
                }

                // Raw STT words, shown instantly — no LLM summarization pass.
                // The prompts tell the AI this is speech-recognition output and
                // to read mis-transcribed words from context.
                fullTranscript.push({
                  type: "user",
                  text,
                  inputMethod: "voice",
                });
                sendJson(ws, {
                  type: "chat_message",
                  role: "user",
                  text,
                  inputMethod: "voice",
                });
              },
              (_partialText) => {
                if (sessionEnded) return;
                // Barge-in via server STT: abort the in-flight turn so the
                // server stops generating + streaming further audio.
                // Only a partial that interrupts an ACTIVE turn is a real
                // barge-in. A partial that arrives while the panel is idle
                // (background noise, speaker echo between turns) must NOT emit
                // stop_audio — that would make the client drop the NEXT turn's
                // audio, which is exactly the "panel text shows but no voice
                // plays" bug.
                // ALSO: brief partials (1-2 words) are often spurious noise,
                // breathing, or mic artifacts — especially on mobile with AGC.
                // Require ≥3 words before aborting, so real sustained speech
                // triggers barge-in but brief noise doesn't cut the panel off.
                const hadActiveTurn =
                  !!currentTurnAbort && !currentTurnAbort.signal.aborted;
                if (!hadActiveTurn) return;
                const wordCount = _partialText.trim().split(/\s+/).length;
                if (wordCount < 3) return; // ignore brief noise
                currentTurnAbort!.abort();
                const now = Date.now();
                // Avoid spamming stop_audio too fast
                if (
                  now - (sttRecognizer as any)._lastInterruption > 2000 ||
                  !(sttRecognizer as any)._lastInterruption
                ) {
                  (sttRecognizer as any)._lastInterruption = now;
                  sendJson(ws, { type: "stop_audio" });
                }
              },
            );
          } else {
            console.warn(
              "[stt] AZURE_SPEECH_KEY/REGION not set — voice input via server STT disabled",
            );
          }

          // Start idle detection — check every 5s, nudge at 35s, auto-end at 3min
          lastUserActivityTime = Date.now();
          sessionStartTimestamp = Date.now();
          initialDurationSeconds = Number(clientConfig.duration || 15) * 60;
          // On resume (reconnect after refresh) the client reports how much
          // time was actually left — otherwise the server clock would restart
          // at the full duration and time_sync would extend the session.
          if (isResume && Number.isFinite(Number(data.timeLeftSeconds))) {
            initialDurationSeconds = Math.min(
              initialDurationSeconds,
              Math.max(0, Math.floor(Number(data.timeLeftSeconds))),
            );
          }
          hasNudged = false;

          idleCheckInterval = setInterval(() => {
            const idleMs = Date.now() - lastUserActivityTime;
            const NUDGE_THRESHOLD = 60 * 1000; // 60 seconds
            const END_THRESHOLD = 5 * 60 * 1000; // 5 minutes

            const timeLeftSeconds = getTimeLeftSeconds();
            const mins = Math.floor(timeLeftSeconds / 60);
            const secs = timeLeftSeconds % 60;

            // Keep the client's displayed countdown aligned with the server
            // clock (background-tab throttling can slow the client timer).
            sendJson(ws, { type: "time_sync", timeLeftSeconds });

            // ── Proactive time management (one-shot cues, not nudges — they
            // must survive the founder speaking and fire exactly once). The
            // AI otherwise only sees the clock when the founder talks, which
            // is why sessions used to just hit 0:00 mid-conversation. ──
            if (!isSoloMode && !sessionEnded && timeLeftSeconds > 0) {
              // Halfway check-in — only for sessions long enough that a
              // mid-point marker is useful (≥ 8 minutes).
              if (
                !halfwayCueSent &&
                initialDurationSeconds >= 8 * 60 &&
                timeLeftSeconds <= initialDurationSeconds / 2
              ) {
                halfwayCueSent = true;
                enqueueTurn({
                  text: `[SYSTEM: Time check — about half the session remains (${mins}:${String(secs).padStart(2, "0")} left). ${isCoachMode ? "Riley" : "The most natural panelist"} should acknowledge the time in ONE short spoken sentence and steer toward the most important area not yet covered. Keep it natural — no lecture about time.]`,
                  inputMethod: "chat",
                  timeLeft: timeLeftSeconds,
                });
              }
              // Two-minute wrap-up — start landing the plane so the hard stop
              // never cuts anyone off mid-thought.
              if (!wrapUpCueSent && timeLeftSeconds <= 120) {
                wrapUpCueSent = true;
                enqueueTurn({
                  text: isCoachMode
                    ? `[SYSTEM: Only ${mins}:${String(secs).padStart(2, "0")} remains. Riley — tell the founder time is almost up, invite their closing summary, and prepare one final encouraging takeaway. Short spoken sentences only.]`
                    : `[SYSTEM: Only ${mins}:${String(secs).padStart(2, "0")} remains. Panel — say so out loud and begin wrapping up: no new complex topics, one final clarification at most, then Marcus steers toward closing remarks so the verdict doesn't cut anyone off. ONE speaker, 1-2 sentences.]`,
                  inputMethod: "chat",
                  timeLeft: timeLeftSeconds,
                });
              }
            }

            if (idleMs >= END_THRESHOLD) {
              console.log("⏱️ User idle for 5+ minutes. Auto-ending session.");
              sendJson(ws, {
                type: "idle_end",
                message:
                  "Session ended due to inactivity. The panel noticed you've been silent for over 5 minutes.",
              });
              // Release the Azure Speech connection immediately — an abandoned
              // session must not hold the recognizer open. sessionEnded stays
              // false on purpose: the client answers idle_end by sending
              // prepare_evaluation + end_session ~1.5s later, and both handlers
              // early-return when sessionEnded is true, which would kill the
              // report. end_session performs the real teardown.
              if (sttRecognizer) {
                sttRecognizer.stop();
                sttRecognizer = null;
              }
              if (idleCheckInterval) {
                clearInterval(idleCheckInterval);
                idleCheckInterval = null;
              }
            } else if (idleMs >= NUDGE_THRESHOLD && !hasNudged) {
              hasNudged = true;
              console.log(
                "⏱️ User idle for 60+ seconds. Sending AI nudge with time context.",
              );
              enqueueTurn({
                text: `[SYSTEM: The founder has been silent for 60 seconds. Pitch time remaining is ${mins} minutes and ${secs} seconds. Gently nudge them to continue their pitch, ask if they need help, or ask a specific follow-up question based on their pitch deck. Keep it conversational.]`,
                inputMethod: "chat",
                isNudge: true,
              });
            }
          }, 5000);

          return;
        }

        if (data.type === "audio_chunk" && hasSentSetup) {
          if (sttRecognizer && !sessionEnded) {
            try {
              const buf = Buffer.from(data.data, "base64");
              sttRecognizer.pushAudio(buf);
            } catch (e) {
              console.error("[stt] failed to push audio chunk:", e);
            }
          }
          return;
        }

        if (data.type === "heartbeat") {
          lastUserActivityTime = Date.now();
          hasNudged = false;
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          lastUserActivityTime = Date.now();
          hasNudged = false;

          // Clear any pending nudges from the queue so they don't pile up!
          for (let i = turnQueue.length - 1; i >= 0; i--) {
            if (turnQueue[i].isNudge) {
              turnQueue.splice(i, 1);
            }
          }

          const inputMethod = data.inputMethod === "chat" ? "chat" : "voice";

          // Two-step interruption: while the panel holds the floor, this message
          // is routed to the hand-back logic and is NOT pitch content (still
          // echoed below). End-session intent still wins over a floor hold.
          const consumedByFloor =
            typeof data.text === "string" &&
            floorHeldByPanel &&
            !detectEndSessionIntent(data.text)
              ? handleFloorHeldUtterance(data.text, inputMethod)
              : false;

          // Voice end-session: same interception as the STT path. If consumed,
          // the message drives the confirm flow instead of a normal pitch turn,
          // but is still recorded/echoed to the transcript below.
          const consumedByEndFlow =
            !consumedByFloor &&
            typeof data.text === "string" &&
            handleEndSessionVoiceFlow(data.text);

          // Typed chat is the only client-rate-controlled AI-turn vector, so it
          // carries the full token-bucket throttle. Capacities sit far above human
          // cadence, so only a scripted flood trips it. A tripped turn is dropped
          // whole — no AI response, no transcript record (recording spam would
          // pollute the evaluation) — and the client keeps its own optimistic
          // bubble. A hostile client could forge inputMethod:"voice" to dodge the
          // bucket, so the pending-queue depth cap is enforced on EVERY
          // chat_message turn as a backstop regardless of the claimed method.
          if (!consumedByFloor && !consumedByEndFlow && typeof data.text === "string") {
            const overQueueCap = turnQueue.length >= MAX_PENDING_FOUNDER_TURNS;
            const throttled =
              inputMethod === "chat" ? !allowFounderChatTurn() : overQueueCap;
            if (throttled) {
              console.warn(
                "[rate-limit] chat_message burst dropped (token bucket empty / queue deep)",
              );
              return;
            }
          }

          if (!consumedByFloor && !consumedByEndFlow) {
            // Hard wrap-up: in the last WRAP_UP_HARD_SEC seconds, suppress the new
            // panel turn (no new questions before the buzzer). The founder's words
            // are still echoed to the transcript below.
            const inHardWrapUp =
              !isSoloMode && getTimeLeftSeconds() <= WRAP_UP_HARD_SEC;
            if (!inHardWrapUp) {
              noteFounderTurnForRoomRead();
              enqueueTurn({
                text: data.text,
                timeLeft:
                  typeof data.timeLeft === "number" ? data.timeLeft : undefined,
                inputMethod,
              });
            }
          }

          if (inputMethod === "voice") {
            // Raw voice text, echoed back instantly — no summarization pass.
            fullTranscript.push({
              type: "user",
              text: data.text,
              inputMethod,
            });
            sendJson(ws, {
              type: "chat_message",
              role: "user",
              text: data.text,
              inputMethod,
            });
          } else {
            fullTranscript.push({
              type: "user",
              text: data.text,
              inputMethod,
            });
          }
          return;
        }

        if (data.type === "verdict_request") {
          console.log("🗳️ Verdict requested by user.");
          if (idleCheckInterval) {
            clearInterval(idleCheckInterval);
            idleCheckInterval = null;
          }

          // The founder ended the session — cut the panel off immediately.
          if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
            currentTurnAbort.abort();
          }
          turnQueue.length = 0;
          // Drop any pending two-step interruption hold — the session is ending,
          // so there is no floor left to hand back.
          floorHeldByPanel = false;
          floorReSignaled = false;

          const panelists = data.panelists || [
            { name: "Marcus", role: "Lead Investor" },
            { name: "Sarah", role: "Financial Analyst" },
            { name: "Chen", role: "Technical Partner" },
          ];

          // If no substantive pitch was given, send non-hallucinated PASS verdicts directly
          if (!hasSubstantivePitch(fullTranscript)) {
            console.log("ℹ️ Empty pitch detected for verdict request — returning non-hallucinated PASS verdicts.");
            const emptyVerdicts = [
              {
                speaker: "Marcus",
                text: "PASS — You didn't present your pitch or outline your problem and solution during this session.",
                verdict: "pass" as const,
              },
              {
                speaker: "Sarah",
                text: "PASS — No business model, traction, or financial details were presented for evaluation.",
                verdict: "pass" as const,
              },
              {
                speaker: "Chen",
                text: "PASS — No product details or technical execution plan were presented.",
                verdict: "pass" as const,
              },
            ];

            for (const v of emptyVerdicts) {
              sendJson(ws, {
                type: "verdict_message",
                speaker: v.speaker,
                text: v.text,
                verdict: v.verdict,
              });

              if (isTtsConfigured()) {
                try {
                  const vName = resolveVoiceName(v.speaker);
                  const buf = await synthesizeSpeech(v.text, vName);
                  const base64Audio = Buffer.from(buf).toString("base64");
                  sendJson(ws, {
                    type: "audio",
                    data: base64Audio,
                    speaker: v.speaker,
                  });
                } catch (e) {
                  console.error("Verdict TTS error:", e);
                }
              }
            }

            sendJson(ws, { type: "verdict_complete" });
            return;
          }

          const panelistNames = panelists
            .map((p: any) => `${p.name} (${p.role})`)
            .join(", ");

          enqueueTurn({
            text: `[SYSTEM: The pitch session is NOW OVER. Time for final verdicts. Each panelist must give their verdict IN ORDER: ${panelistNames}. Each panelist: prefix with your name (e.g. "Marcus:") and give ONE specific, personalized reason tied to something the founder actually said or failed to address during this pitch. Weigh this fairly: actively look for the reasons to say YES, not just the reasons to say no. If the pitch genuinely supports it, say you are IN ("I'm in because…") — a conditional yes is allowed ("I'm in, provided you can prove out the retention numbers"). Only say you are OUT ("I'm out because…") when there is a specific, concrete blocker you cannot get past — never as a reflex. If you are genuinely on the fence, say so honestly and name the ONE thing that would tip you. Do not invent flaws to justify a pass, and do not manufacture enthusiasm you do not feel. Each verdict must feel distinct and authentic to your character. Keep each verdict to 1-2 sentences. Do not ask any more questions. Start now.]`,
            isVerdict: true,
            panelists: panelists,
          });
          return;
        }

        if (data.type === "prepare_evaluation") {
          // Kick off the evaluation in the background the moment the user ends
          // their pitch, so it runs in parallel with the verdict phase. By the
          // time the panel finishes speaking, the report is usually ready.
          if (!evaluationPromise && !sessionEnded) {
            const t = Array.isArray(data.transcript)
              ? data.transcript
              : fullTranscript;
            // Duration-aware gate: skip the LLM pre-start when the session was
            // too short to score, so we don't spend tokens (or fabricate a
            // report) for an insufficient pitch. Uses the server's own elapsed
            // clock since the client's `duration` arrives later with end_session.
            const elapsedSec = Math.floor(
              (Date.now() - sessionStartTimestamp) / 1000,
            );
            if (!isInsufficientPitch(t, elapsedSec)) {
              console.log(
                "🧠 Pre-starting evaluation in background (parallel with verdicts)...",
              );
              evaluationPromise = evaluatePitch(
                t,
                currentBusinessName,
                resolvedDeckText,
                sessionMode,
                previousSessionCtx,
                marketSnapshot,
                pitchConfigSnapshot?.fundingStage || "",
                elapsedSec,
              ).catch((err) => {
                console.error("❌ Background evaluation failed:", err);
                return null;
              });
            }
          }
          return;
        }

        if (data.type === "end_session") {
          if (sessionEnded) return;
          sessionEnded = true;
          if (sttRecognizer) {
            sttRecognizer.stop();
            sttRecognizer = null;
          }
          if (idleCheckInterval) {
            clearInterval(idleCheckInterval);
            idleCheckInterval = null;
          }
          console.log("🏁 Session ended, starting evaluation...");
          const frontendTranscript = Array.isArray(data.transcript)
            ? data.transcript
            : fullTranscript;
          // Elapsed pitch time drives the insufficiency gate. Prefer the client's
          // measured duration; fall back to the server's own clock so a missing
          // client value can never misclassify a real, long pitch as too short.
          const serverElapsedSec = Math.floor(
            (Date.now() - sessionStartTimestamp) / 1000,
          );
          const durationSec = Number(data.duration) || serverElapsedSec;

          let reportData: any = {
            summary:
              "Pitch was too short for a full evaluation. Speak for at least 2 minutes or share more detail to receive scored feedback.",
            scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
            sentiments: [],
            strengths: [],
            risks: [],
            next_steps: [],
            transcript: frontendTranscript,
            duration: durationSec,
            evaluationStatus: "insufficient_data",
          };

          try {
            // Reuse the evaluation that was pre-started during the verdict
            // phase if available; otherwise run it now.
            let evaluated = evaluationPromise ? await evaluationPromise : null;
            if (!evaluated) {
              evaluated = await evaluatePitch(
                frontendTranscript,
                currentBusinessName,
                resolvedDeckText,
                sessionMode,
                previousSessionCtx,
                marketSnapshot,
                pitchConfigSnapshot?.fundingStage || "",
                durationSec,
              );
            }
            // Respect the status evaluatePitch reports. It returns
            // "insufficient_data" for a too-short/empty pitch (duration-aware);
            // only a real evaluation carries "complete". Never force "complete"
            // over the top, or a short session would render a fabricated report.
            reportData = {
              ...reportData,
              ...evaluated,
              evaluationStatus: evaluated?.evaluationStatus || "complete",
            };

            // Room-read feedback is derived server-side from the interest
            // timeline (never model-estimated); only attached when it applies.
            const roomReadNote = buildRoomReadNote();
            if (roomReadNote) reportData.room_read_note = roomReadNote;

            console.log("✅ Evaluation succeeded! Scores:", reportData.scores);
          } catch (evalErr) {
            console.error("❌ Evaluation failed:", evalErr);
            reportData.evaluationStatus = "failed";
            reportData.summary =
              "We could not generate a full evaluation right now. Your session was saved — try again or contact support if this persists.";
          }

          // Persist the session mode both as a real column (for filtering) and
          // inside evaluation_report (back-compat with rows that predate the column).
          reportData.mode = sessionMode;

          // Re-pitch: snapshot the previous attempt's numbers into the report so
          // the frontend/PDF compute score deltas deterministically (never the LLM).
          if (previousSessionCtx) {
            reportData.previous_attempt = {
              sessionId: parentSessionId,
              date: previousSessionCtx.date,
              overallScore: previousSessionCtx.overallScore,
              scores: previousSessionCtx.scores,
            };
          }

          sessionId = 0;
          let shareId = crypto.randomUUID();
          try {
            const insertPayload: any = {
              business_name: currentBusinessName,
              summary: reportData.summary,
              evaluation_report: reportData,
              video_url: currentVideoUrl,
              share_id: shareId,
              mode: sessionMode,
              pitch_config: pitchConfigSnapshot,
              parent_session_id: parentSessionId,
            };
            if (currentUserId) insertPayload.user_id = currentUserId;

            let { data: dbData, error: dbError } = await supabase
              .from("sessions")
              .insert([insertPayload])
              .select()
              .single();

            // Rollout safety: if the new columns (mode / pitch_config /
            // parent_session_id) don't exist yet in Supabase, retry without
            // them rather than losing the session entirely.
            if (dbError && /column|schema/i.test(dbError.message || "")) {
              console.warn(
                "⚠️ Session insert failed (possibly missing new columns) — retrying with legacy payload:",
                dbError.message,
              );
              const { mode, pitch_config, parent_session_id, ...legacyPayload } =
                insertPayload;
              ({ data: dbData, error: dbError } = await supabase
                .from("sessions")
                .insert([legacyPayload])
                .select()
                .single());
            }

            if (!dbError && dbData) {
              sessionId = dbData.id;
              if (dbData.share_id) shareId = dbData.share_id;

              // Generate PDF in the background and cache in db — but only for a
              // substantive session. An insufficient session's report is short-form
              // (page 1 only) and the on-demand route generates it deterministically
              // on download, so caching one adds nothing and would persist a stale
              // copy if the short-form logic ever changes.
              const evalStatus = reportData.evaluationStatus;
              const insufficient =
                evalStatus === "insufficient_data" ||
                evalStatus === "failed" ||
                (reportData.scores &&
                  reportData.scores.delivery === 0 &&
                  reportData.scores.clarity === 0 &&
                  reportData.scores.scalability === 0 &&
                  reportData.scores.readiness === 0);
              if (!insufficient) {
                const formattedSession = {
                  ...dbData,
                  created_at: dbData.created_at || dbData.timestamp,
                  evaluation_report: reportData,
                };
                generatePitchReportPDF(formattedSession)
                  .then((buf) => {
                    const base64Pdf = buf.toString("base64");
                    return supabase
                      .from("session_pdfs")
                      .insert([{ session_id: dbData.id, pdf_base64: base64Pdf }]);
                  })
                  .then(({ error: cacheErr }) => {
                    if (cacheErr) {
                      console.warn(
                        `⚠️ Failed to cache background PDF for session ${dbData.id}:`,
                        cacheErr.message,
                      );
                    } else {
                      console.log(
                        `✅ Background PDF cached successfully for session ${dbData.id}`,
                      );
                    }
                  })
                  .catch((err) => {
                    console.error(
                      `❌ Background PDF generation failed for session ${dbData.id}:`,
                      err,
                    );
                  });
              }
            }
          } catch (dbErr) {
            console.error("❌ Failed to save session to Supabase:", dbErr);
          }

          if (ws.readyState === WebSocket.OPEN && reportData.scores) {
            sendJson(ws, {
              type: "SCORE_UPDATE",
              scores: {
                clarity: reportData.scores.clarity ?? 0,
                confidence: reportData.scores.delivery ?? 0,
                marketFit: reportData.scores.scalability ?? 0,
                readiness: reportData.scores.readiness ?? 0,
              },
            });
          }

          sendJson(ws, {
            type: "report",
            data: reportData,
            sessionId,
            shareId,
          });
        }
      } catch {
        // Ignore non-JSON messages (legacy raw audio payloads)
      }
    });
  });
}
