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
    let lastUserActivityTime = Date.now();
    let hasNudged = false;
    let idleCheckInterval: ReturnType<typeof setInterval> | null = null;
    let sessionId = 0;

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
      if (idleCheckInterval) clearInterval(idleCheckInterval);
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
              // Discard any thinking/reasoning process parts (Gemini 2.5 chain-of-thought blocks)
              if (part.thought) {
                console.log("🤫 Filtered out Gemini thinking part:", part.text);
                return;
              }
              if (part.text) {
                let cleanText = part.text;
                
                // Drop meta-talk or chain-of-thought leakages
                if (/^(?:Okay, so the user said|Right, I need to|Okay, so|I need to keep this|I'm structuring the initial|I've successfully synthesized|I will execute Marcus|I've crafted Marcus's|I've refined Marcus's|I am focusing on)/i.test(cleanText)) {
                  console.log("🤫 Filtered out residual meta-talk phrase:", cleanText);
                  return;
                }
                // Strip markdown formatting
                cleanText = cleanText.replace(/\[[^\]]*\]/g, '');
                cleanText = cleanText.replace(/\([^\)]*\)/g, '');
                cleanText = cleanText.replace(/\*[^*]*\*/g, '');
                // Strip "Name:" prefixes
                cleanText = cleanText.replace(/^(marcus|riley|sarah|chen|investor|founder):\s*/i, '');
                
                // Strip thinking/action headers — any Title Case phrase that looks like internal monologue
                // e.g. "Interpreting the Context", "Analyzing the Deck's Content", "Rephrasing the Core Question"
                cleanText = cleanText.replace(/^[A-Z][a-z]+(?:[\s'-]+[A-Za-z]+){1,6}\s*$/gm, '');
                // Strip lines that are just a header followed by nothing useful
                cleanText = cleanText.replace(/^(confirming|initiating|interpreting|analyzing|rephrasing|assessing|evaluating|deepening|challenging|quantitative|technical|strategic|reviewing|processing|considering|formulating|preparing|transitioning|redirecting|addressing|summarizing|concluding|opening|closing|wrapping)[^.!?]*$/gim, '');
                
                cleanText = cleanText.trim();
                
                if (cleanText) {
                  // Detect which panelist is speaking from the text content
                  let detectedSpeaker = "";
                  const speakerMatch = cleanText.match(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)\s+here[,.]?/i)
                    || cleanText.match(/(?:I'm|I am|This is|It's)\s+(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)/i)
                    || cleanText.match(/(?:let me|I'll).*?(?:jump in|chime in|take|weigh in)/i);
                  
                  if (speakerMatch) {
                    const name = speakerMatch[1];
                    if (name) detectedSpeaker = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
                  }
                  
                  // Also check if the text starts with a name reference
                  const nameCheck = cleanText.match(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)[,:\s]/i);
                  if (nameCheck && !detectedSpeaker) {
                    detectedSpeaker = nameCheck[1].charAt(0).toUpperCase() + nameCheck[1].slice(1).toLowerCase();
                    cleanText = cleanText.replace(/^(Marcus|Sarah|Chen|Riley|Taylor|Elena|David|James)[,:\s]+/i, '').trim();
                  }
                  
                  ws.send(JSON.stringify({ type: "transcript", text: cleanText, speaker: detectedSpeaker || undefined }));
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
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } },
                thinkingConfig: { thinkingBudget: 0 } // Disable thinking to reduce latency and eliminate meta-thought generation
              },
              systemInstruction: { parts: [{ text: masterPrompt }] }
            }
          }));

          // Start idle detection — nudge at 2min, auto-end at 4min
          lastUserActivityTime = Date.now();
          hasNudged = false;
          idleCheckInterval = setInterval(() => {
            const idleMs = Date.now() - lastUserActivityTime;
            const NUDGE_THRESHOLD = 2 * 60 * 1000;  // 2 minutes
            const END_THRESHOLD = 4 * 60 * 1000;     // 4 minutes

            if (idleMs >= END_THRESHOLD) {
              console.log("⏱️ User idle for 4+ minutes. Auto-ending session.");
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "idle_end", message: "Session ended due to inactivity. The panel noticed you've been silent for over 4 minutes." }));
              }
              if (idleCheckInterval) clearInterval(idleCheckInterval);
            } else if (idleMs >= NUDGE_THRESHOLD && !hasNudged) {
              hasNudged = true;
              console.log("⏱️ User idle for 2+ minutes. Sending AI nudge.");
              if (aiWs.readyState === WebSocket.OPEN) {
                aiWs.send(JSON.stringify({
                  clientContent: {
                    turns: [{ role: "user", parts: [{ text: "[SYSTEM: The founder has been silent for 2 minutes. Gently nudge them to continue their pitch or ask if they need help. If they don't respond soon, the session will end automatically.]" }] }],
                    turnComplete: true
                  }
                }));
              }
            }
          }, 15000); // Check every 15 seconds

          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          lastUserActivityTime = Date.now();
          hasNudged = false;
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
          console.log(`📊 Transcript entries: ${frontendTranscript.length}, Business: ${currentBusinessName}, User ID: ${currentUserId}`);
          console.log(`🔑 Env check — Gemini key: ${config.geminiApiKey ? 'SET' : 'MISSING'}, Supabase URL: ${config.supabaseUrl ? 'SET' : 'MISSING'}`);
          if (aiWs.readyState === WebSocket.OPEN) aiWs.close();

          let reportData: any = {
            summary: "Pitch was too short to perform a full venture capital evaluation. Please speak for at least 2 minutes to get full VC grading.",
            scores: { delivery: 0, clarity: 0, scalability: 0, readiness: 0 },
            sentiments: [], strengths: [], risks: [], next_steps: [], transcript: frontendTranscript, duration: data.duration || 0
          };

          try {
            const evaluated = await evaluatePitch(frontendTranscript, currentBusinessName);
            reportData = { ...reportData, ...evaluated };
            console.log("✅ Evaluation succeeded! Scores:", reportData.scores);
          } catch (evalErr) { 
            console.error("❌ Evaluation failed:", evalErr); 
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

          // Emit real AI-evaluated scores to the client before sending the full report
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

          // Send report ONLY to the originating client
          const payload = JSON.stringify({ type: "report", data: reportData, sessionId, shareId });
          if (ws.readyState === WebSocket.OPEN) ws.send(payload);
          return;
        }

        if (aiWs.readyState === WebSocket.OPEN && hasSentSetup) {
          // Any raw audio/data from the client = user is active
          lastUserActivityTime = Date.now();
          hasNudged = false;
          aiWs.send(message.toString());
        }
      } catch (err) {
        // Safe catch-all for parse exceptions
      }
    });
  });
}
