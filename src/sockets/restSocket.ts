import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config, hasAzureOpenAiConfig, hasAzureTtsConfig, hasOpenAiConfig } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt, generatePanelResponse } from "../services/aiService.ts";
import { synthesizeSpeech, PANELIST_VOICES, isTtsConfigured } from "../services/ttsService.ts";
import { detectSpeaker } from "../utils/aiTextSanitizer.ts";
import crypto from "crypto";

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

  return { speaker, spokenText };
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

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

    console.log("✅ Client connected to PitchNest Brain (Azure OpenAI + Azure TTS)");

    if (!hasOpenAiConfig()) {
      console.error("🚨 CRITICAL: AI provider env vars are missing");
      sendJson(ws, {
        type: "error",
        message:
          "AI is not configured on the server. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT.",
      });
      return;
    }

    if (!hasAzureTtsConfig()) {
      console.error("🚨 CRITICAL: Azure TTS env vars are missing — voice output disabled");
      sendJson(ws, {
        type: "error",
        message:
          "Voice output is not configured on the server. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.",
        code: "TTS_NOT_CONFIGURED",
      });
    } else if (!hasAzureOpenAiConfig() && config.openAiApiKey) {
      console.log("ℹ️ Using standard OpenAI (non-Azure) for text generation");
    }

    ws.on("close", () => {
      console.log("🔌 Client disconnected.");
    });

    sendJson(ws, { type: "status", status: "vertex_ready" });

    const processAiTurn = async (userInput: string) => {
      try {
        const aiResponse = await generatePanelResponse(userInput, conversationHistory, masterPrompt);

        conversationHistory.push({ role: "user", text: userInput });
        conversationHistory.push({ role: "assistant", text: aiResponse });

        const { speaker, spokenText } = parseSpeakerResponse(aiResponse, isCoachMode);

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

        const voiceName = PANELIST_VOICES[speaker] || PANELIST_VOICES.Marcus;
        const chunks = splitIntoSpokenChunks(spokenText);

        if (chunks.length === 0) {
          sendJson(ws, { type: "turn_complete" });
          return;
        }

        let ttsFailed = false;

        // Synthesize all chunks in parallel, stream to client in order for low latency + no gaps
        const synthesisPromises = chunks.map((chunk) =>
          synthesizeSpeech(chunk, voiceName).then((buf) =>
            Buffer.from(buf).toString("base64"),
          ),
        );

        for (let i = 0; i < synthesisPromises.length; i++) {
          try {
            const base64Audio = await synthesisPromises[i];
            sendJson(ws, {
              type: "audio",
              data: base64Audio,
              speaker,
            });
          } catch (ttsErr: any) {
            ttsFailed = true;
            console.error(`❌ TTS failed on chunk ${i + 1}/${chunks.length}:`, ttsErr.message);
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
          // Text transcript was already sent — user can still read the panel response
          console.warn("⚠️ Continuing session without audio for this turn");
        }

        sendJson(ws, { type: "turn_complete" });
      } catch (err: any) {
        console.error("❌ Error generating AI response:", err);
        sendJson(ws, {
          type: "error",
          message: err.message || "Failed to generate AI response",
          code: "AI_FAILED",
        });
      }
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
          await processAiTurn("I'm ready. Welcome me and invite my opening pitch.");
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          fullTranscript.push({ type: "user", text: data.text, inputMethod: "voice" });
          await processAiTurn(data.text);
          return;
        }

        if (data.type === "end_session") {
          console.log("🏁 Session ended, starting evaluation...");
          const frontendTranscript = Array.isArray(data.transcript) ? data.transcript : fullTranscript;

          let reportData: any = {
            summary:
              "Pitch was too short to perform a full venture capital evaluation. Please speak for at least 2 minutes to get full VC grading.",
            scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
            sentiments: [],
            strengths: [],
            risks: [],
            next_steps: [],
            transcript: frontendTranscript,
            duration: data.duration || 0,
          };

          const userTurns = frontendTranscript.filter((m: any) => m.type === "user");
          const totalUserTextLength = userTurns.reduce(
            (sum: number, m: any) => sum + (m.text || "").length,
            0,
          );

          if (userTurns.length >= 1 && totalUserTextLength >= 25) {
            try {
              const evaluated = await evaluatePitch(
                frontendTranscript,
                currentBusinessName,
                resolvedDeckText,
              );
              reportData = { ...reportData, ...evaluated };
              console.log("✅ Evaluation succeeded! Scores:", reportData.scores);
            } catch (evalErr) {
              console.error("❌ Evaluation failed:", evalErr);
            }
          } else {
            console.log("⚠️ Evaluation skipped: transcript is empty or too short.");
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
