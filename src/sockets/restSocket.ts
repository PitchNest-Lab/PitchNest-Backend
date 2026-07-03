import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config, hasAzureTtsConfig, hasOpenAiConfig } from "../config/env.ts";
import {
  evaluatePitch,
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
import crypto from "crypto";

const MIN_EVAL_USER_CHARS = 150;
const MIN_EVAL_DURATION_SEC = 60;
// Below this Azure STT confidence (0..1) we treat a recognition as likely
// garbled and ask the founder to repeat instead of answering it.
const LOW_STT_CONFIDENCE = 0.2;
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

function shouldRunEvaluation(
  userTurns: any[],
  totalUserTextLength: number,
  durationSec: number,
): boolean {
  if (userTurns.length < 1) return false;
  return (
    totalUserTextLength >= MIN_EVAL_USER_CHARS ||
    durationSec >= MIN_EVAL_DURATION_SEC
  );
}

type QueuedTurn = {
  text: string;
  timeLeft?: number;
  inputMethod?: "voice" | "chat";
  isVerdict?: boolean;
  isGreeting?: boolean;
  isNudge?: boolean;
  panelists?: any[];
};

export function initRestSocket(wss: WebSocketServer) {
  wss.on("connection", async (ws) => {
    let currentVideoUrl = "";
    let currentBusinessName = "Unknown Pitch";
    let currentUserId: number | null = null;
    let hasSentSetup = false;
    let sessionId = 0;
    let resolvedDeckText = "";
    let masterPrompt = "";
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

    // Evaluation can be pre-started (in parallel with the verdict phase) so the
    // report is ready by the time the panel finishes speaking. See the
    // `prepare_evaluation` handler and `end_session` below.
    let evaluationPromise: Promise<any> | null = null;

    // Barge-in: aborts the in-flight AI turn (LLM generation + TTS streaming).
    // Set when processing a standard turn; triggered by an `interrupt` message
    // or an STT partial transcript. See processAiTurn and the message handler.
    let currentTurnAbort: AbortController | null = null;

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
          const aiResponse = await generatePanelResponse(
            userInput,
            conversationHistory.slice(-MAX_LLM_HISTORY),
            masterPrompt,
          );
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
            let verdictVerdict: "invest" | "pass" | "maybe" = "maybe";
            if (
              /\b(invest|i'm in|i am in|fund|back this|green light)\b/i.test(
                lowerText,
              )
            ) {
              verdictVerdict = "invest";
            } else if (
              /\b(pass|i'm out|i am out|decline|not invest|no deal|walk away)\b/i.test(
                lowerText,
              )
            ) {
              verdictVerdict = "pass";
            }

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

        let promptToUse = masterPrompt;
        let userInputToUse = userInput;

        // Greeting: speak a varied, code-chosen "Welcome to the Nest" line
        // directly (no LLM call) so the opening is consistent on brand, varied
        // each session, and instant. It still flows through the normal
        // sentence/TTS pipeline via singleChunkStream.
        const stream = turn.isGreeting
          ? singleChunkStream(
              `${isCoachMode ? "Riley" : "Marcus"}: ${pickGreeting(isCoachMode, currentBusinessName, !!previousSessionCtx)}`,
            )
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

            if (sentence.length > 0) {
              const cleanSentence = sanitizeAiSpeech(sentence) || sentence;
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
          }
        }

        // 3. Process the final remaining chunk in the buffer (skip if barged in)
        if (!turnAbort.signal.aborted && currentSentenceBuffer.trim().length > 0) {
          const finalSentence = currentSentenceBuffer.trim();
          const cleanSentence =
            sanitizeAiSpeech(finalSentence) || finalSentence;
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
        // (not real questions). The client falls back to its local keyword card
        // if this never arrives (slow/failed), so the tip layer can't break.
        if (!turn.isGreeting && !turn.isNudge && fullSpokenText.trim()) {
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

        // 5. Update histories (record whatever was actually spoken, even if the
        // turn was cut short by a barge-in, so context stays coherent)
        if (!turn.isGreeting) {
          conversationHistory.push({ role: "user", text: userInput });
        }
        conversationHistory.push({ role: "assistant", text: fullSpokenText });
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
      } catch (err: any) {
        if (currentTurnAbort) currentTurnAbort = null;
        console.error("❌ Error generating AI response:", err);
        sendJson(ws, {
          type: "error",
          message: err.message || "Failed to generate AI response",
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
          currentUserId = clientConfig.userId || null;
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
          resolveDeckText(clientConfig)
            .then((text) => {
              resolvedDeckText = text;
              if (isSoloMode) return;
              const enrichedConfig = {
                ...clientConfig,
                resolvedDeckText,
                previousSession: previousSessionCtx,
              };
              masterPrompt = getMasterPrompt(
                isCoachMode,
                currentBusinessName,
                enrichedConfig,
              );
            })
            .catch((err) => console.error("Error resolving deck text:", err));

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

                enqueueTurn({ text, inputMethod: "voice" });

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
                const hadActiveTurn =
                  !!currentTurnAbort && !currentTurnAbort.signal.aborted;
                if (!hadActiveTurn) return;
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
          hasNudged = false;

          idleCheckInterval = setInterval(() => {
            const idleMs = Date.now() - lastUserActivityTime;
            const NUDGE_THRESHOLD = 60 * 1000; // 60 seconds
            const END_THRESHOLD = 5 * 60 * 1000; // 5 minutes

            const elapsedSeconds = Math.floor(
              (Date.now() - sessionStartTimestamp) / 1000,
            );
            const timeLeftSeconds = Math.max(
              0,
              initialDurationSeconds - elapsedSeconds,
            );
            const mins = Math.floor(timeLeftSeconds / 60);
            const secs = timeLeftSeconds % 60;

            if (idleMs >= END_THRESHOLD) {
              console.log("⏱️ User idle for 5+ minutes. Auto-ending session.");
              sendJson(ws, {
                type: "idle_end",
                message:
                  "Session ended due to inactivity. The panel noticed you've been silent for over 5 minutes.",
              });
              if (idleCheckInterval) clearInterval(idleCheckInterval);
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

          enqueueTurn({
            text: data.text,
            timeLeft:
              typeof data.timeLeft === "number" ? data.timeLeft : undefined,
            inputMethod,
          });

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
          // Abort any in-flight turn and drop everything still queued so the
          // verdict is the very next thing spoken (no "let me finish my point
          // first" before the verdicts).
          if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
            currentTurnAbort.abort();
          }
          turnQueue.length = 0;

          const panelists = data.panelists || [
            { name: "Marcus", role: "Lead Investor" },
            { name: "Sarah", role: "Financial Analyst" },
            { name: "Chen", role: "Technical Partner" },
          ];
          const panelistNames = panelists
            .map((p: any) => `${p.name} (${p.role})`)
            .join(", ");

          enqueueTurn({
            text: `[SYSTEM: The pitch session is NOW OVER. Time for final verdicts. Each panelist must give their verdict IN ORDER: ${panelistNames}. Each panelist: prefix with your name (e.g. "Marcus:"), state INVEST or PASS, and give ONE specific, personalized reason tied to something the founder actually said or failed to address during this pitch. Use phrases like "I'm in because…" or "I'm out because…". Avoid generic phrases — each verdict must feel distinct and authentic to your character. Keep each verdict to 1-2 sentences. Do not ask any more questions. Start now.]`,
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
            const hasUserContent = t.some(
              (m: any) => m.type === "user" && (m.text || "").trim().length > 0,
            );
            if (hasUserContent) {
              console.log(
                "🧠 Pre-starting evaluation in background (parallel with verdicts)...",
              );
              evaluationPromise = evaluatePitch(
                t,
                currentBusinessName,
                resolvedDeckText,
                sessionMode,
                previousSessionCtx,
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
          const durationSec = Number(data.duration) || 0;

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

          const userTurns = frontendTranscript.filter(
            (m: any) => m.type === "user",
          );
          const totalUserTextLength = userTurns.reduce(
            (sum: number, m: any) => sum + (m.text || "").length,
            0,
          );

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
              );
            }
            reportData = {
              ...reportData,
              ...evaluated,
              evaluationStatus: "complete",
            };
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

              // Generate PDF in the background and cache in db
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
