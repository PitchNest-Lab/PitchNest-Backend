import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt, generatePanelResponse } from "../services/aiService.ts";
import { synthesizeSpeech, PANELIST_VOICES } from "../services/ttsService.ts";
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

/**
 * Splits text into complete sentences to ensure low-latency audio generation.
 * Splits ONLY on sentence boundaries (. ? !) and NOT on commas or internal punctuation,
 * allowing Azure TTS to natively speak clauses and commas with smooth, natural human inflection.
 */
function splitIntoSpokenChunks(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
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
    
    // Maintain conversation history for Gemini REST
    const conversationHistory: any[] = [];
    // Full transcript for evaluation
    const fullTranscript: any[] = [];

    console.log("✅ Client connected to PitchNest Brain (REST + Azure TTS mode)");

    if (!config.geminiApiKey) {
      console.error("🚨 CRITICAL ERROR: GEMINI_API_KEY is missing!");
      return ws.send(JSON.stringify({ type: "error", message: "API Key Missing" }));
    }

    ws.on("close", () => {
      console.log("🔌 Client disconnected.");
    });

    // We emulate the "vertex_ready" status immediately so the frontend knows it can start
    ws.send(JSON.stringify({ type: "status", status: "vertex_ready" }));

    const processAiTurn = async (userInput: string) => {
      try {
        const aiResponse = await generatePanelResponse(userInput, conversationHistory, masterPrompt);
        
        // Add to history
        conversationHistory.push({ role: "user", text: userInput });
        conversationHistory.push({ role: "assistant", text: aiResponse });

        // Try to extract speaker (e.g., "Marcus: Hello there" -> speaker: "Marcus", text: "Hello there")
        let speaker = "Marcus"; // Default
        let spokenText = aiResponse;
        
        const colonIndex = aiResponse.indexOf(":");
        if (colonIndex !== -1 && colonIndex < 20) { // arbitrary short length for name
          speaker = aiResponse.substring(0, colonIndex).trim();
          spokenText = aiResponse.substring(colonIndex + 1).trim();
        }

        // Send transcript to frontend
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "transcript",
            text: spokenText,
            speaker: speaker
          }));
        }

        fullTranscript.push({ type: 'model', speaker, text: spokenText });

        // Synthesize audio
        try {
          // If the speaker name isn't exactly matched, fallback to Marcus
          const voiceName = PANELIST_VOICES[speaker] || PANELIST_VOICES["Marcus"];
          
          // Split into short conversational chunks to ensure low latency
          const chunks = splitIntoSpokenChunks(spokenText);

          // Start all synthesis tasks in parallel
          const synthesisPromises = chunks.map(async (chunk) => {
            const audioBuffer = await synthesizeSpeech(chunk, voiceName);
            return Buffer.from(audioBuffer).toString('base64');
          });

          // Await and send base64 audio chunks in strict chronological order.
          // This achieves near-instant startup latency AND zero gaps between sentences!
          for (const promise of synthesisPromises) {
            const base64Audio = await promise;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "audio", data: base64Audio }));
            }
          }
        } catch (ttsErr) {
          console.error("❌ TTS failed:", ttsErr);
        }

      } catch (err) {
        console.error("❌ Error generating AI response:", err);
      }
    };

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "set_video_url") {
          currentVideoUrl = data.url;
          if (sessionId && config.supabaseUrl && config.supabaseAnonKey) {
            try {
              await supabase.from('sessions').update({ video_url: currentVideoUrl }).eq('id', sessionId);
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

          resolvedDeckText = await resolveDeckText(clientConfig);
          const enrichedConfig = { ...clientConfig, resolvedDeckText };

          const isCoach = clientConfig.mode === 'coach';
          masterPrompt = getMasterPrompt(isCoach, currentBusinessName, enrichedConfig);

          console.log("🟢 Setup complete! Triggering pitch introduction via REST...");
          
          // Trigger the initial introduction
          await processAiTurn("I'm ready. Welcome me and invite my opening pitch.");
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          fullTranscript.push({ type: 'user', text: data.text, inputMethod: 'voice' }); // Or text depending on STT
          await processAiTurn(data.text);
          return;
        }

        if (data.type === "end_session") {
          console.log("🏁 Session ended, starting REST evaluation...");
          // We can use the frontend transcript or our backend one. We'll use frontend's to be consistent with liveSocket logic.
          const frontendTranscript = Array.isArray(data.transcript) ? data.transcript : fullTranscript;
          
          let reportData: any = {
            summary: "Pitch was too short to perform a full venture capital evaluation. Please speak for at least 2 minutes to get full VC grading.",
            scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
            sentiments: [], strengths: [], risks: [], next_steps: [], transcript: frontendTranscript, duration: data.duration || 0
          };

          const userTurns = frontendTranscript.filter((m: any) => m.type === 'user');
          const totalUserTextLength = userTurns.reduce((sum: number, m: any) => sum + (m.text || "").length, 0);

          if (userTurns.length >= 1 && totalUserTextLength >= 25) {
            try {
              const evaluated = await evaluatePitch(frontendTranscript, currentBusinessName, resolvedDeckText);
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
                share_id: shareId
              };
            if (currentUserId) insertPayload.user_id = currentUserId;

            let { data: dbData, error: dbError } = await supabase
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
            ws.send(JSON.stringify({
              type: "SCORE_UPDATE",
              scores: {
                clarity: reportData.scores.clarity ?? 0,
                confidence: reportData.scores.delivery ?? 0,
                marketFit: reportData.scores.scalability ?? 0,
                readiness: reportData.scores.readiness ?? 0,
              }
            }));
          }

          const payload = JSON.stringify({ type: "report", data: reportData, sessionId, shareId });
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
          return;
        }

      } catch (err) {
        // Assume this is raw PCM audio that the frontend is still sending.
        // We will ignore raw audio data for now until STT is implemented on the backend, 
        // or the frontend is updated to send text only.
      }
    });
  });
}
