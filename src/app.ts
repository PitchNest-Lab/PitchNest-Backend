import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import { config } from "./config/env.ts";
import { isAllowedBrowserOrigin } from "./config/origins.ts";
import authRoutes from "./routes/authRoutes.ts";
import deckRoutes from "./routes/deckRoutes.ts";
import uploadRoutes from "./routes/uploadRoutes.ts";
import fileRoutes from "./routes/fileRoutes.ts";
import sessionRoutes from "./routes/sessionRoutes.ts";
import publicRoutes from "./routes/publicRoutes.ts";
import { publicReadLimiter } from "./routes/publicRoutes.ts";
import {
  getPublicBusinessSitemap,
  publicSiteOrigin,
  readPublicBusinessProfile,
} from "./controllers/publicBusinessController.ts";
import { injectPublicBusinessMetadata } from "./utils/publicBusinessMetadata.ts";
import profileRoutes from "./routes/profileRoutes.ts";
import adminRoutes from "./routes/adminRoutes.ts";
import billingRoutes from "./routes/billingRoutes.ts";
import businessRoutes from "./routes/businessRoutes.ts";
import discoverRoutes from "./routes/discoverRoutes.ts";
import staffRoutes from "./routes/staffRoutes.ts";
import practiceRoutes from "./routes/practiceRoutes.ts";
import notificationRoutes from "./routes/notificationRoutes.ts";
import communityRoutes from "./routes/communityRoutes.ts";
import { handleWaitlist, handleSurvey } from "./controllers/waitlistController.ts";
import router from "./routes/organization/organizationRoutes.ts";

const app = express();

// Required for Render (and any reverse proxy) — lets Express see real client IPs
// so express-rate-limit can correctly identify users via X-Forwarded-For.
app.set("trust proxy", 1);

// Global Middlewares — CORS restricted to allowed origins
const isProduction = config.nodeEnv === "production";

app.use(cors({
  origin: (origin, callback) => {
    // Requests without Origin are non-browser/native/server clients. Browser
    // origins must be explicitly configured; preview domains are no longer
    // trusted by suffix alone.
    const isAllowed = !origin || isAllowedBrowserOrigin(origin);

    if (isAllowed) {
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
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        scriptSrc: ["'self'", "https://accounts.google.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https:", "wss:"],
        frameSrc: ["'self'", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        workerSrc: ["'self'", "blob:"],
        manifestSrc: ["'self'"],
        // Do not make local HTTP development unusable.
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
    // Allow framing from same origin (needed for embedded previews).
    frameguard: { action: "sameorigin" },
    referrerPolicy: { policy: "no-referrer" },
  }),
);
app.use((_req, res, next) => {
  res.set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=()");
  next();
});

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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "256kb", extended: true }));

// Sensitive API payloads are private unless a public controller explicitly
// replaces this with a cache policy after validating its publication state.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

// Local-fallback files are delivered ONLY via the token-gated /api/files route
// (S7) — the previous unauthenticated static mount let anyone who knew a
// filename read another user's deck or video. No raw /uploads serving.
app.use("/api/files", fileRoutes);

// API Routers
app.use("/api/auth", authRoutes);
app.use("/api/organization", router);
app.use("/api/businesses", businessRoutes);
app.use("/api/discover", discoverRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/practice", practiceRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/community", communityRoutes);
app.use("/api/decks", deckRoutes);
app.use("/api", uploadRoutes); // Hooks /api/upload-video and /api/upload-deck directly
app.use("/api/sessions", sessionRoutes);
// The public share read — unauthenticated by definition, and the only route in
// the app a stranger can reach without a token. See routes/publicRoutes.ts.
app.use("/api/public", publicRoutes);
app.use("/api/profile", profileRoutes);
// Internal transcript review surface — authenticated and staff-role gated.
app.use("/api/admin", adminRoutes);
// Billing: checkout + the webhook that grants paid access.
app.use("/api/billing", billingRoutes);
app.post("/api/waitlist", handleWaitlist);
app.post("/api/survey", handleSurvey);
app.get("/sitemap.xml", publicReadLimiter, getPublicBusinessSitemap);

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
  const indexTemplate = fs.readFileSync(path.join(distPath, "index.html"), "utf8");

  // Social crawlers generally do not execute the React bundle. Render profile
  // metadata into the initial HTML, and emit a noindex shell for every slug that
  // does not currently resolve to an active approved publication.
  app.get("/businesses/:slug", async (req, res) => {
    const requestedSlug = String(req.params.slug || "").trim().toLowerCase().slice(0, 80);
    let business: Awaited<ReturnType<typeof readPublicBusinessProfile>> = null;
    try {
      business = await readPublicBusinessProfile(requestedSlug);
    } catch (error) {
      console.error("Business profile metadata lookup failed:", error);
    }
    const html = injectPublicBusinessMetadata(
      indexTemplate,
      business,
      publicSiteOrigin(),
      requestedSlug,
    );
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    res.status(200).type("html").send(html);
  });

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
