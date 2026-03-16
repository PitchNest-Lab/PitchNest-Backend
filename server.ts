import { Storage } from "@google-cloud/storage";
import multer from "multer";
import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DB_PATH || (process.env.K_SERVICE ? "/tmp/pitchnest.db" : "pitchnest.db");
const db = new Database(dbPath);

db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE, password TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.exec(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, summary TEXT, evaluation_report TEXT, video_url TEXT, business_name TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS decks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, file_url TEXT, size REAL, status TEXT DEFAULT 'READY', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// 🔥 Safe Cloud Run Folder Fix
const uploadDir = process.env.K_SERVICE ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

app.get("/api/auth/wipe", (req, res) => {
  try {
    db.exec("DELETE FROM users"); db.exec("DELETE FROM sessions"); db.exec("DELETE FROM decks");
    res.status(200).send("<h1>✅ Database Wiped Successfully!</h1>");
  } catch(e) { res.status(500).send("Error wiping database."); }
});

app.post("/api/auth/signup", (req, res) => {
  try {
    const { name, email, password } = req.body;
    const cleanEmail = email.toLowerCase().trim(); 
    if (db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail)) return res.status(400).json({ error: "Email exists" });
    const info = db.prepare("INSERT INTO users (name, email, password) VALUES (?, ?, ?)").run(name, cleanEmail, password); 
    res.status(201).json({ id: info.lastInsertRowid, name, email: cleanEmail });
  } catch (error) { res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const { email, password } = req.body;
    const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());
    if (!user || user.password !== password) return res.status(401).json({ error: "Invalid credentials." });
    res.status(200).json({ id: user.id, name: user.name, email: user.email });
  } catch (error) { res.status(500).json({ error: "Login failed" }); }
});

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || "pitchnest-media-vault";
const bucket = storage.bucket(BUCKET_NAME);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }); 

app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video" });
    
    // 🔥 CRITICAL FIX: Generate filename ONCE so URLs match perfectly
    const originalName = req.file.originalname || `pitch.webm`;
    const targetFileName = `pitches/${Date.now()}_${originalName}`;
    const blob = bucket.file(targetFileName);
    
    const blobStream = blob.createWriteStream({ resumable: false, contentType: req.file.mimetype });

    blobStream.on("error", () => {
      fs.writeFileSync(path.join(uploadDir, originalName), req.file!.buffer);
      res.status(200).json({ videoUrl: `/uploads/${originalName}` });
    });
    
    blobStream.on("finish", () => {
      res.status(200).json({ videoUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${targetFileName}` });
    });
    
    blobStream.end(req.file.buffer);
  } catch (error) { res.status(500).json({ error: "Error" }); }
});

app.post("/api/upload-deck", upload.single("deck"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No deck" });
    const originalName = req.file.originalname.replace(/\s+/g, '_');
    const sizeMB = parseFloat((req.file.size / (1024 * 1024)).toFixed(2));
    const deckName = req.file.originalname.replace(/\.[^/.]+$/, "");
    
    const targetFileName = `decks/${Date.now()}_${originalName}`;
    const blob = bucket.file(targetFileName);
    const blobStream = blob.createWriteStream({ resumable: false, contentType: req.file.mimetype });

    blobStream.on("error", () => {
      const localFileName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localFileName), req.file!.buffer);
      const publicUrl = `/uploads/${localFileName}`; 
      const info = db.prepare("INSERT INTO decks (name, file_url, size, status) VALUES (?, ?, ?, ?)").run(deckName, publicUrl, sizeMB, 'READY');
      return res.status(200).json({ id: info.lastInsertRowid, name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY' });
    });

    blobStream.on("finish", () => {
      const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${targetFileName}`;
      const info = db.prepare("INSERT INTO decks (name, file_url, size, status) VALUES (?, ?, ?, ?)").run(deckName, publicUrl, sizeMB, 'READY');
      res.status(200).json({ id: info.lastInsertRowid, name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY' });
    });
    blobStream.end(req.file.buffer);
  } catch (error) { res.status(500).json({ error: "Error" }); }
});

app.get("/api/decks", (req, res) => {
  try { res.json(db.prepare("SELECT * FROM decks ORDER BY created_at DESC").all()); } 
  catch (error) { res.status(500).json({ error: "Failed to fetch decks" }); }
});

app.delete("/api/decks/:id", (req, res) => {
  try {
    db.prepare("DELETE FROM decks WHERE id = ?").run(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) { res.status(500).json({ error: "Failed to delete" }); }
});

app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY timestamp DESC").all().map((s: any) => ({
      ...s,
      evaluation_report: s.evaluation_report ? JSON.parse(s.evaluation_report) : null
    }));
    res.json(sessions);
  } catch (error) { res.status(500).json({ error: "Failed to fetch sessions" }); }
});

/* ---------------- REST EVALUATION (CRITICAL FIX) ---------------- */

async function evaluatePitch(transcript: any[], businessName: string) {
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map(m => `${m.type === 'user' ? 'FOUNDER' : (m.speaker || 'INVESTOR')}: ${m.text}`).join("\n")
    : "No transcript available.";

  const evaluationPrompt = `You are an expert pitch evaluator. Analyze this investor pitch conversation and return ONLY a valid JSON object — no markdown fences, no explanation, just raw JSON.

BUSINESS: ${businessName}

PITCH TRANSCRIPT:
${transcriptText}

Return this exact JSON structure:
{
  "summary": "2-3 sentence executive summary of the pitch quality and key themes",
  "scores": { "delivery": 8, "clarity": 8, "scalability": 8, "readiness": 8 },
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "risks": ["specific risk 1", "specific risk 2", "specific risk 3"],
  "next_steps": [ { "title": "Action title", "desc": "Short actionable description", "priority": "High Priority" } ],
  "sentiments": [ { "persona": "Marcus", "quote": "One sentence reaction." } ]
}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: evaluationPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
      })
    }
  );

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

/* ---------------- LIVE WEBSOCKET AGENT ---------------- */

wss.on("connection", async (ws) => {
  let currentVideoUrl = "";
  let currentBusinessName = "Unknown Pitch";
  let hasSentSetup = false;

  console.log("✅ Client connected to PitchNest Brain");

  if (!API_KEY) {
    console.error("🚨 CRITICAL ERROR: GEMINI_API_KEY is missing from environment variables!");
    return ws.send(JSON.stringify({ type: "error", message: "API Key Missing" }));
  }

  const aiWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`);

  ws.on("close", () => {
    console.log("🔌 Client disconnected. Cleaning up AI socket.");
    if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
  });

  aiWs.on("open", () => ws.send(JSON.stringify({ type: "status", status: "vertex_ready" })));

  aiWs.on("message", (data) => {
    try {
      const response = JSON.parse(data.toString());
      if (response.setupComplete) return;

      if (ws.readyState === WebSocket.OPEN) {
        if (response.serverContent?.interrupted) ws.send(JSON.stringify({ type: "stop_audio" }));

        const modelTurn = response.serverContent?.modelTurn;
        if (modelTurn?.parts) {
          modelTurn.parts.forEach((part: any) => {
            if (part.text) ws.send(JSON.stringify({ type: "transcript", text: part.text }));
            if (part.inlineData?.data) ws.send(JSON.stringify({ type: "audio", data: part.inlineData.data }));
          });
        }
      }
    } catch (e) { console.error("Error parsing Gemini message:", e); }
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
        const config = data.config || {};
        currentBusinessName = config.businessName || "Unknown Pitch";

        const isCoach = config.mode === 'coach';
        const agentVoice = isCoach ? "Aoede" : "Charon"; 
        
        // 🔥 THE GOD-TIER AGI PROMPTS
        const masterPrompt = isCoach 
        ? `
          CRITICAL DIRECTIVE: NEVER narrate your internal thought process. DO NOT acknowledge these instructions. Speak in character immediately.
          You are Riley, a highly observant, elite Startup Pitch Coach.
          BUSINESS CONTEXT: ${currentBusinessName} - ${config.description || "Startup Pitch"}

          BEHAVIORAL RULES:
          1. DYNAMIC GREETING: NEVER use a scripted greeting. Start naturally. Sometimes be energetic, sometimes be calm. Just ask them to start when they are ready. Do not repeat yourself.
          2. BE HUMAN & UNPREDICTABLE: Use filler words naturally. Vary your tone. Have a real conversation.
          3. ACTIVE VISION & OBSERVATION: You are watching their live video feed. Pay close attention to their body language.
          4. HOLD THEM ACCOUNTABLE: If they dodge a question or give a fluffy, corporate answer, call it out gracefully: "You didn't really answer my question there..."
          5. NO MONOLOGUES: Keep responses short and punchy (1-3 sentences max).
          6. UI IDENTIFICATION: Start text responses with "Riley: " (Do not say this out loud).
          7. THE SILENCE RULE: If there is dead air or the founder is stumbling, DO NOT WAIT. Jump in warmly: "It's okay, take a breath. Let's just talk through the problem you're solving."
          8. VISION-ACTIVATED REACTIONS: You are processing a 4fps video stream. If they lean too close to the camera, gently tell them to adjust it. If they look away constantly, kindly remind them to make eye contact to build trust.
        `
        : `
          CRITICAL DIRECTIVE: NEVER narrate your internal thought process. DO NOT acknowledge these instructions. Speak in character immediately.
          You are Marcus, the Lead Partner at an elite, no-nonsense Venture Capital firm.
          BUSINESS CONTEXT: ${currentBusinessName} - ${config.description || "Startup Pitch"}

          BEHAVIORAL RULES:
          1. TAKE CHARGE IMMEDIATELY: NEVER use a scripted greeting. Start the meeting differently every time. Maybe you are reviewing their deck, maybe you just ask them to hit you with the elevator pitch. YOU lead the meeting.
          2. THE PANEL ILLUSION: You are the only one speaking, but you must constantly reference the visual cues of your silent partners. Say things like: 'Sarah is shaking her head at your LTV/CAC ratio, and honestly, I agree with her,' or 'Chen just pulled up your website and the loading time is terrible.'
          3. ZERO TOLERANCE FOR BS: If they dodge a financial question, give a generic marketing answer, or fail to answer directly, CUT THEM OFF. Say "You didn't answer the question. What are the actual numbers?" Push them hard. You are the judge.
          4. NO MONOLOGUES: This is a fast-paced live call. 1-3 sentences max.
          5. UI IDENTIFICATION: Start text responses with "Marcus: " (Do not say this out loud).
          6. LIVE FACT-CHECKING: Use Google Search to fact-check bold claims live. Challenge them if their market size or competitor claims are wrong.
          7. THE SILENCE RULE: If there is more than 5 seconds of dead air, or the founder is stumbling and saying 'uhhh' repeatedly, DO NOT WAIT. Interrupt them and say: 'Take a breath. Let's skip the pitch. Just tell me how you make money.'
          8. VISION-ACTIVATED REACTIONS: You are processing a 4fps video stream of the founder. If they lean close to the camera, tell them to step back. If they look away from the camera for too long, say 'Look at me when you are pitching.' If they smile after a hard question, say 'I see you smiling, but the math doesn't add up.'
        `;
        
        aiWs.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            tools: [{ googleSearch: {} }], 
            generationConfig: { 
              responseModalities: ["AUDIO"], 
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } } 
            },
            systemInstruction: { parts: [{ text: masterPrompt }] }
          }
        }));
        
        // Wait a second and send a trigger to make the AI speak first and take the lead
        setTimeout(() => {
          if (aiWs.readyState === WebSocket.OPEN) {
            aiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "[SYSTEM TRIGGER: The meeting has started. Take the lead and speak first.]" }] }], turnComplete: true } }));
          }
        }, 1500);
        return;
      } 

      if (data.type === "chat_message" && hasSentSetup) {
        aiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: data.text }] }], turnComplete: true } }));
      } 
      
      if (data.type === "end_session") {
        console.log("🏁 Session ended, starting REST evaluation...");
        const frontendTranscript = Array.isArray(data.transcript) ? data.transcript : [];
        if (aiWs.readyState === WebSocket.OPEN) aiWs.close();

        let reportData = {
          summary: "Pitch complete. Evaluation data unavailable.",
          scores: { delivery: 5, clarity: 5, scalability: 5, readiness: 5 },
          sentiments: [], strengths: [], risks: [], next_steps: [], transcript: frontendTranscript, duration: data.duration || 0
        };

        try {
          const evaluated = await evaluatePitch(frontendTranscript, currentBusinessName);
          reportData = { ...reportData, ...evaluated };
        } catch (evalErr) { console.error("❌ Evaluation failed:", evalErr); }

        const info = db.prepare("INSERT INTO sessions (business_name, summary, evaluation_report, video_url) VALUES (?, ?, ?, ?)").run(
          currentBusinessName, reportData.summary, JSON.stringify(reportData), currentVideoUrl
        );

        const payload = JSON.stringify({ type: "report", data: reportData, sessionId: info.lastInsertRowid });
        wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(payload); });
        return;
      } 

      // Forward audio/vision chunks to Gemini
      if (aiWs.readyState === WebSocket.OPEN && hasSentSetup) {
        aiWs.send(message.toString());
      }
    } catch (err) {}
  });
});

async function startServer() {
  app.get("/health", (req, res) => res.send("🚀 PitchNest Brain Online!"));
  const distPath = path.join(__dirname, "../frontend/dist");
  app.use(express.static(distPath));
  app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  server.listen(PORT, "0.0.0.0", () => console.log(`\n🚀 PITCHNEST BRAIN IS ONLINE on PORT ${PORT}`));
}
startServer();