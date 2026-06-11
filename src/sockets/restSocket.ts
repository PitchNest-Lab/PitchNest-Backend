import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config, hasAzureTtsConfig, hasOpenAiConfig } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt, generatePanelResponse } from "../services/aiService.ts";
import { synthesizeSpeech, isTtsConfigured, resolveVoiceName } from "../services/ttsService.ts";
import { detectSpeaker, sanitizeAiSpeech } from "../utils/aiTextSanitizer.ts";
import crypto from "crypto";

const MIN_EVAL_USER_CHARS = 150;
const MIN_EVAL_DURATION_SEC = 60;

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

function parseSpeakerResponse(aiResponse: string, isCoach: boolean): { speaker: string; spokenText: string } {
  let speaker = isCoach ? "Riley" : "Marcus";
  let spokenText = aiResponse.trim();

  const colonIndex = spokenText.indexOf(":");
  if (colonIndex !== -1 && colonIndex < 24) {
    const candidate = spokenText.substring(0, colonIndex).trim();
    if (/^[A-Za-z][A-Za-z\s'-]{0,20}$/.test(candidate)) {
      speaker = candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();
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
  return totalUserTextLength >= MIN_EVAL_USER_CHARS || durationSec >= MIN_EVAL_DURATION_SEC;
}

type QueuedTurn = {
  text: string;
  timeLeft?: number;
  inputMethod?: "voice" | "chat";
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

    const conversationHistory: any[] = [];
    const fullTranscript: any[] = [];

    const turnQueue: QueuedTurn[] = [];
    let processingQueue = false;

    console.log("✅ Client connected to PitchNest Brain (Azure OpenAI + Azure TTS)");

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
      console.error("🚨 CRITICAL: Azure TTS env vars are missing — voice output disabled");
      sendJson(ws, {
        type: "error",
        message:
          "Voice output is not configured on the server. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
        code: "TTS_NOT_CONFIGURED",
      });
    }

    ws.on("close", () => {
      console.log("🔌 Client disconnected.");
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
        const aiResponse = await generatePanelResponse(userInput, conversationHistory, masterPrompt);

        conversationHistory.push({ role: "user", text: userInput });
        conversationHistory.push({ role: "assistant", text: aiResponse });

        const { speaker, spokenText } = parseSpeakerResponse(aiResponse, isCoachMode);

        if (!spokenText.trim()) {
          sendJson(ws, { type: "turn_complete" });
          return;
        }

        sendJson(ws, {
          type: "transcript",
          text: spokenText,
          speaker,
        });

        fullTranscript.push({ type: "model", speaker, text: spokenText });

        if (!isTtsConfigured()) {
          sendJson(ws, { type: "turn_complete" });
          return;
        }

        const voiceName = resolveVoiceName(speaker);
        const chunks = splitIntoSpokenChunks(spokenText);

        if (chunks.length === 0) {
          sendJson(ws, { type: "turn_complete" });
          return;
        }

        let ttsFailed = false;

        for (const chunk of chunks) {
          try {
            const buf = await synthesizeSpeech(chunk, voiceName);
            const base64Audio = Buffer.from(buf).toString("base64");
            sendJson(ws, {
              type: "audio",
              data: base64Audio,
              speaker,
            });
          } catch (ttsErr: any) {
            ttsFailed = true;
            console.error("❌ TTS failed:", ttsErr.message);
            sendJson(ws, {
              type: "error",
              message: `Voice synthesis failed: ${ttsErr.message}`,
              code: "TTS_FAILED",
              recoverable: true,
            });
            break;
          }
        }

        if (ttsFailed) {
          console.warn("⚠️ Continuing session without audio for this turn");
        }

        sendJson(ws, { type: "turn_complete", audioChunks: chunks.length });
      } catch (err: any) {
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

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "set_video_url") {
          currentVideoUrl = data.url;
          if (sessionId && config.supabaseUrl && config.supabaseAnonKey) {
            try {
              await supabase.from("sessions").update({ video_url: currentVideoUrl }).eq("id", sessionId);
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
          isCoachMode = clientConfig.mode === "coach";

          resolvedDeckText = await resolveDeckText(clientConfig);
          const enrichedConfig = { ...clientConfig, resolvedDeckText };

          masterPrompt = getMasterPrompt(isCoachMode, currentBusinessName, enrichedConfig);

          console.log("🟢 Setup complete — triggering pitch introduction...");
          enqueueTurn({ text: "I'm ready. Welcome me and invite my opening pitch." });
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          const inputMethod = data.inputMethod === "chat" ? "chat" : "voice";
          fullTranscript.push({
            type: "user",
            text: data.text,
            inputMethod,
          });
          enqueueTurn({
            text: data.text,
            timeLeft: typeof data.timeLeft === "number" ? data.timeLeft : undefined,
            inputMethod,
          });
          return;
        }

        if (data.type === "end_session") {
          console.log("🏁 Session ended, starting evaluation...");
          const frontendTranscript = Array.isArray(data.transcript) ? data.transcript : fullTranscript;
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

          const userTurns = frontendTranscript.filter((m: any) => m.type === "user");
          const totalUserTextLength = userTurns.reduce(
            (sum: number, m: any) => sum + (m.text || "").length,
            0,
          );

          if (shouldRunEvaluation(userTurns, totalUserTextLength, durationSec)) {
            try {
              const evaluated = await evaluatePitch(
                frontendTranscript,
                currentBusinessName,
                resolvedDeckText,
              );
              reportData = { ...reportData, ...evaluated, evaluationStatus: "complete" };
              console.log("✅ Evaluation succeeded! Scores:", reportData.scores);
            } catch (evalErr) {
              console.error("❌ Evaluation failed:", evalErr);
              reportData.evaluationStatus = "failed";
              reportData.summary =
                "We could not generate a full evaluation right now. Your session was saved — try again or contact support if this persists.";
            }
          } else {
            console.log(
              `⚠️ Evaluation skipped: ${totalUserTextLength} chars, ${durationSec}s duration`,
            );
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

          sendJson(ws, { type: "report", data: reportData, sessionId, shareId });
        }
      } catch {
        // Ignore non-JSON messages (legacy raw audio payloads)
      }
    });
  });
}
