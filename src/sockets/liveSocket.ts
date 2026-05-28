import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt } from "../services/aiService.ts";
import crypto from "crypto";

export function initLiveSocket(wss: WebSocketServer) {
  wss.on("connection", async (ws) => {
    let currentVideoUrl = "";
    let currentBusinessName = "Unknown Pitch";
    let currentUserId: number | null = null;
    let hasSentSetup = false;

    console.log("✅ Client connected to PitchNest Brain");

    if (!config.geminiApiKey) {
      console.error("🚨 CRITICAL ERROR: GEMINI_API_KEY is missing from environment variables!");
      return ws.send(JSON.stringify({ type: "error", message: "API Key Missing" }));
    }

    const aiWs = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.geminiApiKey}`
    );

    aiWs.on("error", (error) => {
      console.error("❌ Gemini Live WebSocket error:", error);
    });

    aiWs.on("close", (code, reason) => {
      console.log(`🔌 Gemini Live WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
    });

    ws.on("close", () => {
      console.log("🔌 Client disconnected. Cleaning up AI socket.");
      if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
    });

    aiWs.on("open", () => {
      console.log("🟢 Gemini Live WebSocket connected successfully!");
      ws.send(JSON.stringify({ type: "status", status: "vertex_ready" }));
    });

    aiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.setupComplete) {
          console.log("🟢 Gemini setup complete! Triggering pitch introduction...");
          if (aiWs.readyState === WebSocket.OPEN) {
            aiWs.send(JSON.stringify({ 
              clientContent: { 
                turns: [{ role: "user", parts: [{ text: "Hi, I'm ready to pitch. Please welcome me, introduce yourself and the panel, and invite me to begin." }] }], 
                turnComplete: true 
              } 
            }));
          }
          return;
        }

        if (ws.readyState === WebSocket.OPEN) {
          if (response.serverContent?.interrupted) ws.send(JSON.stringify({ type: "stop_audio" }));

          const modelTurn = response.serverContent?.modelTurn;
          if (modelTurn?.parts) {
            modelTurn.parts.forEach((part: any) => {
              if (part.text) {
                let cleanText = part.text;
                cleanText = cleanText.replace(/\[[^\]]*\]/g, '');
                cleanText = cleanText.replace(/\([^\)]*\)/g, '');
                cleanText = cleanText.replace(/\*[^*]*\*/g, '');
                cleanText = cleanText.replace(/^(marcus|riley|sarah|chen|investor|founder):\s*/i, '');
                
                // Strip action headers or thinking headers (e.g. "Confirming Deck Access", "Initiating Immediate Analysis")
                cleanText = cleanText.replace(/^(confirming deck access|initiating immediate analysis|quantitative deep-dive|technical deep-dive|strategic coaching|deepening the dialogue|challenging the moat|welcome to the boardroom|first slide analysis|pacing assessment|delivery challenge|lead partner marcus|investor panel|analyst sarah|tech expert chen)[:\s\-\*]*/i, '');
                
                cleanText = cleanText.trim();
                
                // Remove the overly aggressive isMeta block entirely to prevent swallowing valid responses
                if (cleanText) {
                  ws.send(JSON.stringify({ type: "transcript", text: cleanText }));
                }
              }
              if (part.inlineData?.data) ws.send(JSON.stringify({ type: "audio", data: part.inlineData.data }));
            });
          }
        }
      } catch (e) { 
        console.error("Error parsing Gemini message:", e); 
      }
    });

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "set_video_url") {
          currentVideoUrl = data.url;
          return;
        }

        if (data.type === "client_ready" && !hasSentSetup) {
          hasSentSetup = true;
          const clientConfig = data.config || {};
          currentBusinessName = clientConfig.businessName || "Unknown Pitch";
          currentUserId = clientConfig.userId || null;

          const isCoach = clientConfig.mode === 'coach';
          const agentVoice = isCoach ? "Aoede" : "Charon";

          // Get properly configured system prompt from aiService
          const masterPrompt = getMasterPrompt(isCoach, currentBusinessName, clientConfig);

          // Bidi WebSocket ONLY supports Gemini Live models.
          // On this environment, the supported model is gemini-2.5-flash-native-audio-latest.
          const bidiModel = "gemini-2.5-flash-native-audio-latest";

          aiWs.send(JSON.stringify({
            setup: {
              model: `models/${bidiModel}`,
              tools: [{ googleSearch: {} }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } }
              },
              systemInstruction: { parts: [{ text: masterPrompt }] }
            }
          }));

          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          aiWs.send(JSON.stringify({ 
            clientContent: { 
              turns: [{ role: "user", parts: [{ text: data.text }] }], 
              turnComplete: true 
            } 
          }));
          return;
        }

        if (data.type === "end_session") {
          console.log("🏁 Session ended, starting REST evaluation...");
          const frontendTranscript = Array.isArray(data.transcript) ? data.transcript : [];
          if (aiWs.readyState === WebSocket.OPEN) aiWs.close();

          let reportData: any = {
            summary: "Pitch was too short to perform a full venture capital evaluation. Please speak for at least 2 minutes to get full VC grading.",
            scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
            sentiments: [], strengths: [], risks: [], next_steps: [], transcript: frontendTranscript, duration: data.duration || 0
          };

          try {
            const evaluated = await evaluatePitch(frontendTranscript, currentBusinessName);
            reportData = { ...reportData, ...evaluated };
          } catch (evalErr) { 
            console.error("❌ Evaluation failed:", evalErr); 
          }

          let sessionId = 0;
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

            if (dbError) {
              if (dbError.code === '42703') {
                console.warn("⚠️ Warning: Supabase 'sessions' table is missing columns (like share_id or user_id). Falling back to un-filtered insert.");
                const fallbackPayload = {
                  business_name: currentBusinessName,
                  summary: reportData.summary,
                  evaluation_report: reportData,
                  video_url: currentVideoUrl
                };
                if (currentUserId) (fallbackPayload as any).user_id = currentUserId;
                let fallback = await supabase.from("sessions").insert([fallbackPayload]).select().single();
                if (fallback.error && fallback.error.code === '42703') {
                    const basicPayload = {
                      business_name: currentBusinessName,
                      summary: reportData.summary,
                      evaluation_report: reportData,
                      video_url: currentVideoUrl
                    };
                    fallback = await supabase.from("sessions").insert([basicPayload]).select().single();
                }
                if (!fallback.error && fallback.data) {
                  dbData = fallback.data;
                  dbError = null;
                }
              }
            }

            if (!dbError && dbData) {
              sessionId = dbData.id;
              if (dbData.share_id) shareId = dbData.share_id;
            }
          } catch (dbErr) { 
            console.error("❌ Failed to save session to Supabase:", dbErr); 
          }

          // Send report ONLY to the originating client
          const payload = JSON.stringify({ type: "report", data: reportData, sessionId, shareId });
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
          return;
        }

        if (aiWs.readyState === WebSocket.OPEN && hasSentSetup) {
          aiWs.send(message.toString());
        }
      } catch (err) {
        // Safe catch-all for parse exceptions
      }
    });
  });
}
