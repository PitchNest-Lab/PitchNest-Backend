import express from "express";
import cors from "cors";
import path from "path";
import { uploadDir } from "./services/storageService.ts";
import authRoutes from "./routes/authRoutes.ts";
import deckRoutes from "./routes/deckRoutes.ts";
import uploadRoutes from "./routes/uploadRoutes.ts";
import sessionRoutes from "./routes/sessionRoutes.ts";

const app = express();

// Global Middlewares
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Serve local uploads statically
app.use('/uploads', express.static(uploadDir));

// API Routers
app.use("/api/auth", authRoutes);
app.use("/api/decks", deckRoutes);
app.use("/api", uploadRoutes); // Hooks /api/upload-video directly
app.use("/api/sessions", sessionRoutes);

// Health check endpoint
app.get("/health", (req, res) => res.send("🚀 PitchNest Brain Online!"));

// Frontend Static Build Serving & Single Page App Fallback
const distPath = path.join(process.cwd(), "../frontend/dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

export default app;
