import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt } from "../services/aiService.ts";

export function initLiveSocket(wss: WebSocketServer) {
  wss.on("connection", async (ws) => {
    let currentVideoUrl = "";
    let currentBusinessName = "Unknown Pitch";
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
        if (response.setupComplete) return;

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
                cleanText = cleanText.trim();
                
                // Filter out planning text or meta-narration thoughts
                const isMeta = /^(acknowledge the|i've registered|my response|as per|i'll aim|transitioning into|i'm taking|i will|speak in character|internal thought|reasoning process|stage directions|system trigger)/i.test(cleanText)
                  || cleanText.includes("instructions")
                  || cleanText.includes("handover")
                  || cleanText.includes("readiness to pitch")
                  || cleanText.length > 200 && cleanText.includes("character");
                  
                if (cleanText && !isMeta) {
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

          const isCoach = clientConfig.mode === 'coach';
          const agentVoice = isCoach ? "Aoede" : "Charon";

          // Get properly configured system prompt from aiService
          const masterPrompt = getMasterPrompt(isCoach, currentBusinessName, clientConfig);

          aiWs.send(JSON.stringify({
            setup: {
              model: `models/${config.geminiModel}`,
              tools: [{ googleSearch: {} }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } }
              },
              systemInstruction: { parts: [{ text: masterPrompt }] }
            }
          }));

          setTimeout(() => {
            if (aiWs.readyState === WebSocket.OPEN) {
              aiWs.send(JSON.stringify({ 
                clientContent: { 
                  turns: [{ role: "user", parts: [{ text: "Hi, I'm ready to pitch." }] }], 
                  turnComplete: true 
                } 
              }));
            }
          }, 1500);
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          aiWs.send(JSON.stringify({ 
            clientContent: { 
              turns: [{ role: "user", parts: [{ text: data.text }] }], 
              turnComplete: true 
            } 
          }));
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
          try {
            const { data: dbData, error: dbError } = await supabase
              .from("sessions")
              .insert([{
                business_name: currentBusinessName,
                summary: reportData.summary,
                evaluation_report: reportData,
                video_url: currentVideoUrl
              }])
              .select()
              .single();

            if (!dbError && dbData) {
              sessionId = dbData.id;
            }
          } catch (dbErr) { 
            console.error("❌ Failed to save session to Supabase:", dbErr); 
          }

          const payload = JSON.stringify({ type: "report", data: reportData, sessionId });
          wss.clients.forEach(client => { 
            if (client.readyState === WebSocket.OPEN) client.send(payload); 
          });
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
