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

const uploadDir = path.join(__dirname, 'uploads');
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
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || "pitchnest-recordings-123";
const bucket = storage.bucket(BUCKET_NAME);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }); 

app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video" });
    const originalName = req.file.originalname || `pitch_${Date.now()}.webm`;
    const blobStream = bucket.file(`pitches/${Date.now()}_${originalName}`).createWriteStream({ resumable: false, contentType: req.file.mimetype });

    blobStream.on("error", () => {
      fs.writeFileSync(path.join(uploadDir, originalName), req.file!.buffer);
      res.status(200).json({ videoUrl: `/uploads/${originalName}` });
    });
    blobStream.on("finish", () => res.status(200).json({ videoUrl: `https://storage.googleapis.com/${BUCKET_NAME}/pitches/${Date.now()}_${originalName}` }));
    blobStream.end(req.file.buffer);
  } catch (error) { res.status(500).json({ error: "Error" }); }
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
  try { res.json(db.prepare("SELECT * FROM sessions ORDER BY timestamp DESC").all().map((s: any) => ({ ...s, evaluation_report: s.evaluation_report ? JSON.parse(s.evaluation_report) : null }))); } 
  catch (error) { res.status(500).json({ error: "Failed to fetch sessions" }); }
});

wss.on("connection", async (ws) => {
  let isEvaluating = false;
  let evaluationBuffer = "";
  let currentVideoUrl = "";
  let isSetupComplete = false; 
  let hasSentSetup = false;
  let currentBusinessName = "Unknown Pitch"; 

  console.log("\n🔌 [SERVER] New client connected to PitchNest Brain!");

  if (!API_KEY) {
    console.error("🚨 CRITICAL ERROR: GEMINI_API_KEY is missing from environment variables!");
    return ws.send(JSON.stringify({ type: "error", message: "API Key Missing" }));
  }

  const aiWs = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`);
  
  aiWs.on("open", () => ws.send(JSON.stringify({ type: "status", status: "vertex_ready" })));

  aiWs.on("message", (data) => {
    const response = JSON.parse(data.toString());

    if (response.setupComplete) {
      isSetupComplete = true;
      aiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: "Hello, I am ready to pitch." }] }], turnComplete: true } }));
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      if (response.serverContent?.interrupted) ws.send(JSON.stringify({ type: "stop_audio" }));

      const modelTurn = response.serverContent?.modelTurn || response.server_content?.model_turn;
      if (modelTurn?.parts) {
        modelTurn.parts.forEach((part: any) => {
          if (isEvaluating && part.text) evaluationBuffer += part.text;
          else if (part.text) ws.send(JSON.stringify({ type: "transcript", text: part.text }));
          else if (part.inlineData || part.inline_data) ws.send(JSON.stringify({ type: "audio", data: (part.inlineData || part.inline_data).data }));
        });
      }

      if (isEvaluating && (response.serverContent?.turnComplete || response.server_content?.turn_complete)) {
        try {
          let reportData = { summary: "Pitch was too short. AI could not generate a full report." };
          
          const firstBrace = evaluationBuffer.indexOf('{');
          const lastBrace = evaluationBuffer.lastIndexOf('}');
          
          if (firstBrace !== -1 && lastBrace !== -1) {
            const cleanJson = evaluationBuffer.substring(firstBrace, lastBrace + 1);
            reportData = JSON.parse(cleanJson);
          }

          const info = db.prepare("INSERT INTO sessions (business_name, summary, evaluation_report, video_url) VALUES (?, ?, ?, ?)").run(
            currentBusinessName, reportData.summary || "Pitch completed.", JSON.stringify(reportData), currentVideoUrl
          );
          
          ws.send(JSON.stringify({ type: "report", data: reportData, sessionId: info.lastInsertRowid }));
        } catch (e) {
          console.error("JSON Parsing Error:", e);
          ws.send(JSON.stringify({ type: "report", data: { summary: "Failed to parse AI evaluation." } }));
        }
        isEvaluating = false;
        evaluationBuffer = "";
      }
    }
  });

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "client_ready" && !hasSentSetup) {
        hasSentSetup = true;
        const config = data.config || {};
        currentBusinessName = config.businessName || "Unknown Pitch";

        // 🔥 FIX: Highly optimized prompts and dynamic voice routing
        const isCoach = config.mode === 'coach';
        const agentVoice = isCoach ? "Aoede" : "Charon"; 
        
        const masterPrompt = isCoach 
        ? `
          You are Riley, a friendly, supportive Startup Pitch Coach.
          BUSINESS CONTEXT: ${currentBusinessName} - ${config.description || "Startup Pitch"}
          
          CRITICAL BEHAVIORAL RULES:
          1. GREETING: Immediately say: "Hey there! I'm Riley, your pitch coach. I'm here to help you practice. Whenever you're ready, let's hear your pitch!"
          2. NO MONOLOGUES: NEVER speak for more than 3 sentences at a time. Keep it punchy, conversational, and fast-paced. End your thoughts by passing the mic back to the founder.
          3. SOUND HUMAN: Use filler words like "umm", "look", "right". Be warm, encouraging, and helpful. If they stumble, encourage them.
          4. VISUAL AWARENESS TEST: You are receiving a live video feed of their camera and screen. Reference their slides kindly: "I love that slide you just pulled up..." If the user explicitly asks "Can you see me?", "What am I wearing?", or anything about their appearance, you MUST look closely at the video feed and accurately describe their appearance, clothing, or background to prove your vision works.
          5. UI IDENTIFICATION: ALWAYS start your text response with "Riley: ". Do not say your name out loud in the audio.
        `
        : `
          You are Marcus, the Lead Partner at an elite, no-nonsense Venture Capital firm.
          BUSINESS CONTEXT: ${currentBusinessName} - ${config.description || "Startup Pitch"}
          
          CRITICAL BEHAVIORAL RULES FOR A LIVE AUDIO CALL:
          1. GREETING: As soon as the user connects, immediately say: "Hey, Marcus here. Welcome to PitchNest. We don't have a lot of time, so let's get right into it, what are you building?"
          2. NO MONOLOGUES: This is a live voice call. NEVER speak for more than 3 sentences at a time. Keep it punchy, conversational, and fast-paced. 
          3. SOUND HUMAN: Use filler words like "umm", "look", "honestly". Do not sound like a text-bot. Be a slightly grumpy but highly intelligent investor.
          4. THE PANEL ILLUSION: You are the only one speaking out loud, but your partners Sarah (Data Analyst) and Chen (Tech Expert) are in the room. Occasionally reference them: "Sarah just pointed out your tech stack..." 
          5. VISUAL AWARENESS TEST: You are receiving a live 4fps video feed of the user's camera and screen. You MUST prove you can see! Say things like, "Looking at this slide right now..." or if they ask "Can you see me?", describe their face, clothing, or room background accurately.
          6. UI IDENTIFICATION: ALWAYS start your text response with "Marcus: " so our frontend UI highlights your avatar. Do not say "Marcus:" out loud.
        `;
        
        aiWs.send(JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: { 
              responseModalities: ["AUDIO"], 
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } } } 
            },
            systemInstruction: { parts: [{ text: masterPrompt }] }
          }
        }));
      } 
      else if (data.type === "chat_message" && isSetupComplete) {
        aiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: data.text }] }], turnComplete: true } }));
      } 
      else if (data.type === "set_video_url") currentVideoUrl = data.url;
      else if (data.type === "end_session") {
        isEvaluating = true;
        
        const evaluationPrompt = `
          [SYSTEM OVERRIDE: DO NOT SPEAK. TEXT OUTPUT ONLY. NO MARKDOWN.]
          The pitch is over. Evaluate performance and return ONLY raw JSON matching this structure exactly:
          {
            "summary": "2-sentence executive summary.",
            "scores": { "delivery": 8, "clarity": 7, "scalability": 9, "readiness": 8 },
            "sentiments": [{ "persona": "VC Panelist", "quote": "Quote here." }],
            "strengths": ["strength 1", "strength 2"],
            "risks": ["risk 1", "risk 2"],
            "next_steps": [{ "title": "Step 1", "desc": "Desc", "priority": "High Priority" }]
          }
        `;
        aiWs.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: evaluationPrompt }] }], turnComplete: true } }));
      } 
      else if (aiWs.readyState === WebSocket.OPEN && isSetupComplete && !isEvaluating) {
        aiWs.send(message.toString());
      }
    } catch (e) {}
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