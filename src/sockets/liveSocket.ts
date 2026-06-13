import { WebSocket, WebSocketServer } from "ws";
import { supabase } from "../config/supabase.ts";
import { config } from "../config/env.ts";
import { evaluatePitch, getMasterPrompt } from "../services/aiService.ts";
import { sanitizeAiSpeech, detectSpeaker } from "../utils/aiTextSanitizer.ts";
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
    let resolvedDeckText = "";

    // ── Verdict phase state ──────────────────────────────────────────────
    let verdictInProgress = false;
    let verdictPanelists: { name: string; role: string }[] = [];
    let verdictCurrentIndex = 0;
    let verdictTextBuffer = "";
    let verdictAudioChunks: string[] = [];
    // ─────────────────────────────────────────────────────────────────────

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
                turns: [{ role: "user", parts: [{ text: "I'm ready. Welcome me and invite my opening pitch." }] }], 
                turnComplete: true 
              } 
            }));
          }
          return;
        }

        if (ws.readyState === WebSocket.OPEN) {
          if (response.serverContent?.interrupted) {
            ws.send(JSON.stringify({ type: "stop_audio" }));
          }

          // ── Verdict-phase turnComplete: parse all verdicts and finish ──
          if (response.serverContent?.turnComplete && verdictInProgress) {
            console.log(`🗳️ Verdict turnComplete. Full text buffer: "${verdictTextBuffer.substring(0, 200)}..."`);
            
            // Parse the accumulated text for each panelist's verdict
            for (const panelist of verdictPanelists) {
              // Try to find this panelist's section in the response
              const nameRegex = new RegExp(`${panelist.name}[:\s]`, 'i');
              let panelistText = verdictTextBuffer; // fallback: use full text
              
              // Try to extract just this panelist's portion
              const nameMatch = verdictTextBuffer.match(new RegExp(`${panelist.name}[:\s](.+?)(?=(?:Marcus|Sarah|Chen)[:\s]|$)`, 'is'));
              if (nameMatch) {
                panelistText = nameMatch[1].trim();
              }
              
              const lowerText = panelistText.toLowerCase();
              let verdict: "invest" | "pass" | "maybe" = "maybe";
              if (/\b(invest|i'm in|i am in|fund|back this|green light)\b/i.test(lowerText)) {
                verdict = "invest";
              } else if (/\b(pass|i'm out|i am out|decline|not invest|no deal|walk away)\b/i.test(lowerText)) {
                verdict = "pass";
              }

              console.log(`🗳️ ${panelist.name} verdict: ${verdict}`);
              ws.send(JSON.stringify({
                type: "verdict_message",
                speaker: panelist.name,
                text: panelistText.substring(0, 300),
                verdict
              }));
            }

            // All verdicts parsed — finish
            console.log("🗳️ All verdicts complete!");
            verdictInProgress = false;
            ws.send(JSON.stringify({ type: "verdict_complete" }));
            // Close Gemini so AI cannot speak again
            if (aiWs.readyState === WebSocket.OPEN) {
              aiWs.close();
            }
            return;
          }

          if (response.serverContent?.turnComplete && !verdictInProgress) {
            ws.send(JSON.stringify({ type: "turn_complete" }));
          }

          const modelTurn = response.serverContent?.modelTurn;
          if (modelTurn?.parts) {
            let textToSend = "";
            let audioToSend = "";
            let speakerToSend = "";

            modelTurn.parts.forEach((part: any) => {
              // Discard any thinking/reasoning process parts (Gemini 2.5 chain-of-thought blocks)
              if (part.thought) {
                console.log("🤫 Filtered out Gemini thinking part:", part.text);
                return;
              }
              if (part.text) {
                const cleanText = sanitizeAiSpeech(part.text);
                if (cleanText) {
                  const { speaker: detectedSpeaker, text: spokenText } = detectSpeaker(cleanText);
                  if (spokenText) {
                    textToSend += (textToSend ? " " : "") + spokenText;
                    // Buffer text for verdict detection
                    if (verdictInProgress) {
                      verdictTextBuffer += (verdictTextBuffer ? " " : "") + spokenText;
                    }
                  }
                  if (detectedSpeaker) {
                    speakerToSend = detectedSpeaker;
                  }
                }
              }
              if (part.inlineData?.data) {
                audioToSend = part.inlineData.data;
              }
            });

            // During verdict phase, override speaker with the current panelist
            if (verdictInProgress && verdictPanelists[verdictCurrentIndex]) {
              speakerToSend = verdictPanelists[verdictCurrentIndex].name;
            }

            if (audioToSend || textToSend) {
              ws.send(JSON.stringify({
                type: "audio",
                data: audioToSend || undefined,
                text: textToSend || undefined,
                speaker: speakerToSend || undefined
              }));
            }
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

          resolvedDeckText = await resolveDeckText(clientConfig);
          const enrichedConfig = { ...clientConfig, resolvedDeckText };

          const isCoach = clientConfig.mode === 'coach';
          const agentVoice = isCoach ? "Aoede" : "Charon";
          const masterPrompt = getMasterPrompt(isCoach, currentBusinessName, enrichedConfig);

          aiWs.send(JSON.stringify({
            setup: {
              model: `models/${config.geminiLiveModel}`,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } },
                thinkingConfig: { thinkingBudget: 0 },
                temperature: isCoach ? 0.7 : 0.8,
                maxOutputTokens: 512
              },
              systemInstruction: { parts: [{ text: masterPrompt }] }
            }
          }));

          // Start idle detection — check every 5s, nudge at 35s, auto-end at 3min
          lastUserActivityTime = Date.now();
          const sessionStartTimestamp = Date.now();
          const initialDurationSeconds = Number(clientConfig.duration || 15) * 60;
          hasNudged = false;

          idleCheckInterval = setInterval(() => {
            const idleMs = Date.now() - lastUserActivityTime;
            const NUDGE_THRESHOLD = 35 * 1000;      // 35 seconds
            const END_THRESHOLD = 3 * 60 * 1000;     // 3 minutes

            const elapsedSeconds = Math.floor((Date.now() - sessionStartTimestamp) / 1000);
            const timeLeftSeconds = Math.max(0, initialDurationSeconds - elapsedSeconds);
            const mins = Math.floor(timeLeftSeconds / 60);
            const secs = timeLeftSeconds % 60;

            if (idleMs >= END_THRESHOLD) {
              console.log("⏱️ User idle for 3+ minutes. Auto-ending session.");
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "idle_end", message: "Session ended due to inactivity. The panel noticed you've been silent for over 3 minutes." }));
              }
              if (idleCheckInterval) clearInterval(idleCheckInterval);
            } else if (idleMs >= NUDGE_THRESHOLD && !hasNudged) {
              hasNudged = true;
              console.log("⏱️ User idle for 35+ seconds. Sending AI nudge with time context.");
              if (aiWs.readyState === WebSocket.OPEN) {
                aiWs.send(JSON.stringify({
                  clientContent: {
                    turns: [{ role: "user", parts: [{ text: `[SYSTEM: The founder has been silent for 35 seconds. Pitch time remaining is ${mins} minutes and ${secs} seconds. Gently nudge them to continue their pitch, ask if they need help, or ask a specific follow-up question based on their pitch deck. Keep it conversational.]` }] }],
                    turnComplete: true
                  }
                }));
              }
            }
          }, 5000); // Check every 5 seconds

          return;
        }

        // ── Handle verdict_request — sequential per-panelist verdicts ────
        if (data.type === "verdict_request" && hasSentSetup && !verdictInProgress) {
          console.log("🗳️ Verdict request received!");
          verdictInProgress = true;
          verdictPanelists = Array.isArray(data.personas) && data.personas.length > 0
            ? data.personas
            : [{ name: "Marcus", role: "Lead Partner" }, { name: "Sarah", role: "Financial Analyst" }, { name: "Chen", role: "Technical Partner" }];
          verdictCurrentIndex = 0;
          verdictTextBuffer = "";
          verdictAudioChunks = [];

          // Stop idle detection — no nudges during verdicts
          if (idleCheckInterval) {
            clearInterval(idleCheckInterval);
            idleCheckInterval = null;
          }

          // Prompt ALL panelists at once (Gemini's audio model gives one continuous response)
          const first = verdictPanelists[0];
          console.log(`🗳️ Requesting all verdicts...`);
          if (aiWs.readyState === WebSocket.OPEN) {
            const panelistNames = verdictPanelists.map(p => `${p.name} (${p.role})`).join(', ');
            aiWs.send(JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: `[SYSTEM: The pitch session is NOW OVER. Time for final verdicts. Each panelist must give their verdict IN ORDER: ${panelistNames}. Each panelist: prefix with your name, state INVEST or PASS, and give ONE reason in 1-2 sentences. Keep it brief. Start with ${first.name} now.]` }] }],
                turnComplete: true
              }
            }));
          }
          return;
        }

        if (data.type === "chat_message" && hasSentSetup) {
          // Block all chat messages during verdict phase
          if (verdictInProgress) {
            console.log("⚠️ Blocked chat_message during verdict phase");
            return;
          }

          lastUserActivityTime = Date.now();
          hasNudged = false;

          let textWithTime = data.text;
          if (typeof data.timeLeft === "number") {
            const mins = Math.floor(data.timeLeft / 60);
            const secs = data.timeLeft % 60;
            textWithTime = `[PITCH TIME REMAINING: ${mins}m ${secs}s] ${data.text}`;
          }

          aiWs.send(JSON.stringify({ 
            clientContent: { 
              turns: [{ role: "user", parts: [{ text: textWithTime }] }], 
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

        if (aiWs.readyState === WebSocket.OPEN && hasSentSetup && !verdictInProgress) {
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
