import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { config } from "./config/env.ts";
import authRoutes from "./routes/authRoutes.ts";
import deckRoutes from "./routes/deckRoutes.ts";
import uploadRoutes from "./routes/uploadRoutes.ts";
import fileRoutes from "./routes/fileRoutes.ts";
import sessionRoutes from "./routes/sessionRoutes.ts";
import profileRoutes from "./routes/profileRoutes.ts";
import adminRoutes from "./routes/adminRoutes.ts";
import billingRoutes from "./routes/billingRoutes.ts";
import { handleWaitlist, handleSurvey } from "./controllers/waitlistController.ts";

const app = express();

// Required for Render (and any reverse proxy) — lets Express see real client IPs
// so express-rate-limit can correctly identify users via X-Forwarded-For.
app.set("trust proxy", 1);

// Global Middlewares — CORS restricted to allowed origins
const isProduction = config.nodeEnv === "production";

// In production, only the real frontend domain(s) are allowed. Localhost dev
// origins are permitted only outside production.
const allowedOrigins = [
  config.allowedOrigin,
  'https://pitchnestapp.vercel.app',
  'https://www.pitchnest.app',
  'https://pitchnest.app',
  ...config.corsExtraOrigins,
  ...(isProduction ? [] : ['http://localhost:5173', 'http://localhost:3000']),
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, native clients).
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (isProduction) {
      console.warn(`⚠️ CORS blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    } else {
      // Dev only: allow unknown origins to keep local tooling friction-free.
      console.warn(`⚠️ CORS: allowing unlisted origin in dev: ${origin}`);
      callback(null, true);
    }
  },
  credentials: true,
}));

// ── Security headers ────────────────────────────────────────────────────────
// helmet sets sensible defaults: X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, Referrer-Policy, X-DNS-Prefetch-Control, etc.
app.use(
  helmet({
    // CSP is relaxed because the backend may serve the frontend SPA.
    contentSecurityPolicy: false,
    // Allow framing from same origin (needed for embedded previews).
    frameguard: { action: "sameorigin" },
  }),
);

/**
 * ⚠️ MUST STAY ABOVE express.json — the payment webhook needs the raw bytes.
 *
 * express.json consumes the request stream and leaves only a parsed object.
 * Re-serialising that object does not reproduce the original body (key order and
 * whitespace differ), so any body-based signature check would break. Flutterwave
 * v3 happens to authenticate with a header rather than a body HMAC, so this is
 * currently belt-and-braces — but it is what makes the route correct if we ever
 * switch providers or Flutterwave moves to a body signature, and getting it
 * wrong fails silently until real money is involved.
 */
app.use("/api/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Local-fallback files are delivered ONLY via the token-gated /api/files route
// (S7) — the previous unauthenticated static mount let anyone who knew a
// filename read another user's deck or video. No raw /uploads serving.
app.use("/api/files", fileRoutes);

// API Routers
app.use("/api/auth", authRoutes);
app.use("/api/decks", deckRoutes);
app.use("/api", uploadRoutes); // Hooks /api/upload-video and /api/upload-deck directly
app.use("/api/sessions", sessionRoutes);
app.use("/api/profile", profileRoutes);
// Internal admin surface (Item C) — gated by ADMIN_API_KEY, 404 when unset.
app.use("/api/admin", adminRoutes);
// Billing: checkout + the webhook that grants paid access.
app.use("/api/billing", billingRoutes);
app.post("/api/waitlist", handleWaitlist);
app.post("/api/survey", handleSurvey);

// Health check endpoints — kept dependency-free so they return instantly and can
// be used to pre-warm the Render service (which spins down on the free tier).
// The frontend pings /api/health on Landing/Login/Signup mount to trigger the
// cold start while the user is still typing, so login doesn't hit a sleeping server.
const handleHealth = (_req: express.Request, res: express.Response) =>
  res.status(200).json({ status: "ok", service: "pitchnest-live", time: new Date().toISOString() });

app.get("/health", handleHealth);
app.get("/api/health", handleHealth);

// Frontend Static Build Serving & Single Page App Fallback
const distPath = path.join(process.cwd(), "../frontend/dist");
const hasFrontendBuild = fs.existsSync(path.join(distPath, "index.html"));

if (hasFrontendBuild) {
  console.log(`🟢 Frontend static assets found at: ${distPath}. Serving single-page application.`);
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  console.log(`ℹ️ Frontend static assets not found at: ${distPath}. Running in API-only mode.`);
  
  // Landing route for API root
  app.get("/", (req, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>PitchNest Live API</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b0f19; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .container { text-align: center; border: 1px solid #1e293b; background: #111827; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); max-width: 400px; }
            h1 { color: #3b82f6; margin-top: 0; }
            p { color: #9ca3af; line-height: 1.5; }
            .badge { display: inline-block; background: #10b981; color: #ffffff; padding: 4px 12px; border-radius: 9999px; font-size: 0.875rem; font-weight: 500; margin-top: 10px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🚀 PitchNest Brain</h1>
            <p>The high-performance real-time Venture Capital pitch evaluator is online and listening.</p>
            <span class="badge">API ACTIVE</span>
          </div>
        </body>
      </html>
    `);
  });

  // Fallback 404 for other non-API routes
  app.get("*", (req, res) => {
    res.status(404).json({ error: "Not Found", message: "Use /api routes to connect to PitchNest Live API services." });
  });
}

// Global error handler — guarantees API errors come back as JSON, never as
// Express's default HTML error page (which the frontend can't JSON.parse and
// surfaces as "Unexpected token '<'"). Notably catches CORS rejections.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const isCors = err?.message === "Not allowed by CORS";
  const status = isCors ? 403 : err?.status || 500;
  if (status >= 500) console.error("Unhandled error:", err);
  res.status(status).json({
    error: isCors ? "Origin not allowed." : "Something went wrong. Please try again.",
  });
});

export default app;
