import express from "express";
import cors from "cors";
import path from "path";
import { config } from "./config/env.ts";
import { uploadDir } from "./services/storageService.ts";
import authRoutes from "./routes/authRoutes.ts";
import deckRoutes from "./routes/deckRoutes.ts";
import uploadRoutes from "./routes/uploadRoutes.ts";
import sessionRoutes from "./routes/sessionRoutes.ts";
import profileRoutes from "./routes/profileRoutes.ts";
import { handleWaitlist } from "./controllers/waitlistController.ts";

const app = express();

// Global Middlewares — CORS restricted to allowed origins
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  config.allowedOrigin,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked origin: ${origin}`);
      callback(null, true); // Allow anyway in early stage — tighten later
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve local uploads statically
app.use('/uploads', express.static(uploadDir));

// API Routers
app.use("/api/auth", authRoutes);
app.use("/api/decks", deckRoutes);
app.use("/api", uploadRoutes); // Hooks /api/upload-video and /api/upload-deck directly
app.use("/api/sessions", sessionRoutes);
app.use("/api/profile", profileRoutes);
app.post("/api/waitlist", handleWaitlist);

// Health check endpoint
app.get("/health", (req, res) => res.send("🚀 PitchNest Brain Online!"));

// Frontend Static Build Serving & Single Page App Fallback
const distPath = path.join(process.cwd(), "../frontend/dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

export default app;
