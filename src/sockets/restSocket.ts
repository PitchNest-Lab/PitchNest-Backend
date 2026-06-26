import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config, hasAzureTtsConfig, hasOpenAiConfig } from "../config/env.ts";
import {
  evaluatePitch,
  getMasterPrompt,
  generatePanelResponse,
  streamPanelResponse,
  summarizeVoiceInput,
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
const LOW_STT_CONFIDENCE = 0.4;

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

function pickGreeting(isCoach: boolean, businessName: string): string {
  const pool = isCoach ? COACH_GREETINGS : PANEL_GREETINGS;
  const line = pool[Math.floor(Math.random() * pool.length)];
  return line.replace("{b}", businessName || "your startup");
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
    let sessionMode = "panel";
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
            conversationHistory,
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
              `${isCoachMode ? "Riley" : "Marcus"}: ${pickGreeting(isCoachMode, currentBusinessName)}`,
            )
          : streamPanelResponse(
              userInputToUse,
              conversationHistory,
              promptToUse,
              turnAbort.signal,
            );

        for await (const token of stream) {
          if (turnAbort.signal.aborted) break;
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

        // 4. Wait for the sequential TTS delivery pipeline to completely finish
        await ttsPromiseChain;

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

          console.log("🟢 Setup complete — triggering pitch introduction...");
          enqueueTurn({ text: "", isGreeting: true });

          resolveDeckText(clientConfig)
            .then((text) => {
              resolvedDeckText = text;
              const enrichedConfig = { ...clientConfig, resolvedDeckText };
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

                // Low-confidence recognitions are usually mis-transcriptions
                // (background noise, clipped speech). Rather than have the panel
                // confidently answer garbage like "Sorry, that wasn't a pitch",
                // ask the founder to repeat — and do NOT record the garbled text
                // in the transcript, so it can't pollute the evaluation.
                if (confidence < LOW_STT_CONFIDENCE) {
                  console.log(
                    `[stt] low confidence (${confidence.toFixed(2)}), asking founder to repeat:`,
                    text,
                  );
                  enqueueTurn({
                    text: "[SYSTEM: The founder's last words came through garbled / could not be heard clearly. In ONE short, friendly sentence, ask them to repeat what they just said. Do NOT answer, evaluate, or guess at the unclear input.]",
                    inputMethod: "voice",
                  });
                  return;
                }

                enqueueTurn({ text, inputMethod: "voice" });

                summarizeVoiceInput(text)
                  .then((summary) => {
                    fullTranscript.push({
                      type: "user",
                      text: summary,
                      inputMethod: "voice",
                      fullText: text,
                    });
                    sendJson(ws, {
                      type: "chat_message",
                      role: "user",
                      text: summary,
                      inputMethod: "voice",
                    });
                  })
                  .catch((err) => console.error("Summarization error:", err));
              },
              (_partialText) => {
                if (sessionEnded) return;
                // Barge-in via server STT: abort the in-flight turn so the
                // server stops generating + streaming further audio.
                if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
                  currentTurnAbort.abort();
                }
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
            summarizeVoiceInput(data.text)
              .then((summary) => {
                fullTranscript.push({
                  type: "user",
                  text: summary,
                  inputMethod,
                  fullText: data.text,
                });
                sendJson(ws, {
                  type: "chat_message",
                  role: "user",
                  text: summary,
                  inputMethod,
                });
              })
              .catch((err) => console.error("Summarization error:", err));
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
          const panelists = data.panelists || [
            { name: "Marcus", role: "Lead Investor" },
            { name: "Sarah", role: "Financial Analyst" },
            { name: "Chen", role: "Technical Partner" },
          ];
          const panelistNames = panelists
            .map((p: any) => `${p.name} (${p.role})`)
            .join(", ");

          enqueueTurn({
            text: `[SYSTEM: The pitch session is NOW OVER. Time for final verdicts. Each panelist must give their verdict IN ORDER: ${panelistNames}. Each panelist: prefix with your name, state INVEST or PASS, and give ONE reason in 1-2 sentences. Keep it brief. Do not ask any more questions. Start now.]`,
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

          sessionId = 0;
          let shareId = crypto.randomUUID();
          try {
            const insertPayload: any = {
              business_name: currentBusinessName,
              summary: reportData.summary,
              evaluation_report: reportData,
              video_url: currentVideoUrl,
              share_id: shareId,
            };
            if (currentUserId) insertPayload.user_id = currentUserId;

            const { data: dbData, error: dbError } = await supabase
              .from("sessions")
              .insert([insertPayload])
              .select()
              .single();

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
