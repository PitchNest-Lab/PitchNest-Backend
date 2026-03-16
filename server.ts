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

const uploadDir = process.env.K_SERVICE ? '/tmp/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

/* ---------------- AUTH ---------------- */

app.get("/api/auth/wipe", (req, res) => {
  try {
    db.exec("DELETE FROM users"); db.exec("DELETE FROM sessions"); db.exec("DELETE FROM decks");
    res.status(200).send("<h1>Database wiped</h1>");
  } catch (e) { res.status(500).send("Error wiping database."); }
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

/* ---------------- STORAGE & UPLOADS ---------------- */

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || "pitchnest-media-vault";
const bucket = storage.bucket(BUCKET_NAME);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video" });
    const originalName = req.file.originalname || `pitch.webm`;
    const filename = `pitches/${Date.now()}_${originalName}`;
    const file = bucket.file(filename);

    const blobStream = file.createWriteStream({ resumable: false, contentType: req.file.mimetype });

    blobStream.on("error", () => {
      const localName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localName), req.file!.buffer);
      res.status(200).json({ videoUrl: `/uploads/${localName}` });
    });

    blobStream.on("finish", () => {
      res.status(200).json({ videoUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${filename}` });
    });

    blobStream.end(req.file.buffer);
  } catch (error) { res.status(500).json({ error: "Upload failed" }); }
});

app.post("/api/upload-deck", upload.single("deck"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No deck" });
    const originalName = req.file.originalname.replace(/\s+/g, '_');
    const sizeMB = parseFloat((req.file.size / (1024 * 1024)).toFixed(2));
    const deckName = req.file.originalname.replace(/\.[^/.]+$/, "");
    const blob = bucket.file(`decks/${Date.now()}_${originalName}`);

    const blobStream = blob.createWriteStream({ resumable: false, contentType: req.file.mimetype });

    blobStream.on("error", () => {
      const localFileName = `${Date.now()}_${originalName}`;
      fs.writeFileSync(path.join(uploadDir, localFileName), req.file!.buffer);
      const publicUrl = `/uploads/${localFileName}`;
      const info = db.prepare("INSERT INTO decks (name, file_url, size, status) VALUES (?, ?, ?, ?)").run(deckName, publicUrl, sizeMB, 'READY');
      return res.status(200).json({ id: info.lastInsertRowid, name: deckName, file_url: publicUrl, size: sizeMB, status: 'READY' });
    });

    blobStream.on("finish", () => {
      const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${blob.name}`;
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

/* ---------------- REST EVALUATION ---------------- */

async function evaluatePitch(transcript: any[], businessName: string) {
  const transcriptText = Array.isArray(transcript) && transcript.length > 0
    ? transcript.map(m => `${m.type === 'user' ? 'FOUNDER' : (m.speaker || 'INVESTOR')}: ${m.text}`).join("\n")
    : "No transcript available.";

  const evaluationPrompt = `You are an expert pitch evaluator. Analyze this investor pitch conversation and return ONLY a valid JSON object.

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
        
        // 🔥 THE ULTIMATE HYBRID PROMPT: Structured Phases + Aggressive Vision Features
        const masterPrompt = isCoach 
        ? `
          CRITICAL DIRECTIVE: NEVER narrate your internal thought process. Speak in character immediately.
          You are Riley, an elite Startup Pitch Coach.
          
          BUSINESS CONTEXT:
          ${currentBusinessName} - ${config.description || "Startup Pitch"}

          YOUR ROLE:
          You are helping the founder improve their pitch through a live, dynamic conversation. You are receiving a live video feed of the founder.

          COACHING BEHAVIOR & VISION:
          • Ask questions that help clarify the startup idea.
          • Push the founder to explain their thinking clearly.
          • ACTIVE VISION: Watch their body language. If they look away from the camera constantly, or freeze for more than 4 seconds, interrupt gently and tell them to take a breath.
          • LIVE SEARCH: If they mention a competitor, search them up quickly and ask how they differ.

          FOCUS AREAS:
          1. Problem clarity
          2. Target customer
          3. Value proposition
          4. Business model
          5. Market opportunity

          CONVERSATION STYLE:
          • Friendly but honest
          • Insightful
          • Professional

          RESPONSE RULES:
          • Keep responses under 80 words.
          • Ask one clear question at a time.
          • Avoid long speeches.
          • Always prefix text responses with: "Riley: "
        `
        : `
          CRITICAL DIRECTIVE: NEVER narrate your internal thought process. Speak in character immediately.
          You are Marcus, Lead Partner at a top-tier Venture Capital firm.

          BUSINESS CONTEXT:
          ${currentBusinessName} - ${config.description || "Startup Pitch"}

          YOUR ROLE:
          You are running a startup pitch meeting. You are the only one speaking, but your partners Sarah (Data Analyst) and Chen (Tech Expert) are in the room. You have a live video feed of the founder.

          PITCH MEETING STRUCTURE (YOU CONTROL THE PACE):

          PHASE 1 — OPENING
          Start the meeting professionally but aggressively. Tell the founder: "Marcus here. Sarah and Chen are looking at your deck. You have 3 minutes to pitch. Skip the fluff and tell us what you're building."

          PHASE 2 — LISTEN & OBSERVE
          While the founder is pitching, listen carefully and watch their video feed.
          Evaluate: Problem clarity, Market size, Business model, Traction.
          VISION & INTERRUPTION RULES: Let them pitch, BUT if they freeze for more than 5 seconds, look off-camera like they are reading a script, or start giving generic PR fluff, INTERRUPT THEM IMMEDIATELY. Say "Stop. You aren't answering the question."

          PHASE 3 — PANEL QUESTIONS
          After the pitch, begin investor questioning. Ask focused venture capital questions.
          THE PANEL ILLUSION: Constantly reference your partners. "Sarah is looking at your CAC and doesn't like the math," or "Chen thinks your tech stack is outdated."
          Ask one question at a time. If the founder gives vague answers, cut them off and demand real numbers.

          PHASE 4 — INVESTOR FEEDBACK
          After discussion, provide brief, ruthless feedback on what concerns investors.

          COMMUNICATION STYLE:
          • Direct and highly impatient.
          • Analytical.

          RESPONSE RULES:
          • Keep responses under 80 words. This is a fast-paced live call.
          • Ask concise questions.
          • LIVE FACT-CHECKING: Use your Google Search tool to verify their market size claims.
          • Always prefix text responses with: "Marcus: "
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
      
      // 🔥 THIS BLOCK WAS MISSING IN YOUR PASTED VERSION! It saves the DB and evaluates!
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