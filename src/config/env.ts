import dotenv from "dotenv";

dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  isGoogleCloud: !!process.env.K_SERVICE,
  jwtSecret: process.env.JWT_SECRET || "pitchnest-dev-secret-change-in-production",
  allowedOrigin: process.env.ALLOWED_ORIGIN || "http://localhost:5174",
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || "",
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || "",
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "",
  azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  // Defaults to "production" so a deploy that FORGETS to set NODE_ENV fails
  // CLOSED. Getting this backwards is silent and severe: `isProduction` gates
  // the CORS allow-list in app.ts, so a "development" default would reflect
  // ANY origin with credentials:true on the live site. Local dev sets
  // NODE_ENV=development explicitly in .env / npm scripts.
  nodeEnv: process.env.NODE_ENV || "production",
  emailFrom: process.env.EMAIL_FROM || "PitchNest <hello@pitchnest.app>",
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || "pitchnest-media",
  // Item A: avatars stay PUBLIC (low-sensitivity, shown unsigned on every page)
  // in a SEPARATE bucket, so the main media bucket can be fully private.
  avatarBucket: process.env.SUPABASE_AVATAR_BUCKET || "pitchnest-avatars",
  // Internal-only admin key for the transcript-review endpoint (Item C). Not a
  // user role — a single shared secret sent as the x-admin-key header. Empty
  // disables the admin routes entirely (they 404).
  adminApiKey: process.env.ADMIN_API_KEY || "",
  corsExtraOrigins: (process.env.CORS_EXTRA_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  // Background web research (market snapshot for live panel + evaluation).
  // Off unless explicitly enabled AND a search provider key is present.
  researchEnabled: process.env.RESEARCH_ENABLED === "true",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  serperApiKey: process.env.SERPER_API_KEY || "",
  // ── Billing: Flutterwave v3 Standard (hosted checkout) ──────────────────
  // Empty secret key disables billing entirely: the checkout route 404s and the
  // paywall still works, users just cannot self-upgrade. Fail closed, never
  // fail open into a free-money path.
  //
  // The v3 Standard secret key is `FLWSECK-...` (live) or `FLWSECK_TEST-...`
  // (test). Environment values are trimmed to prevent stray spaces/newlines
  // from causing phantom 401s.
  flutterwaveSecretKey: (process.env.FLW_SECRET_KEY || "").trim(),
  flutterwavePublicKey: (process.env.FLW_PUBLIC_KEY || "").trim(),
  // The dashboard-set secret hash Flutterwave echoes in the `verif-hash`
  // webhook header. Without it we cannot tell a real webhook from a forged one,
  // so billing is treated as NOT configured until it is set (see
  // hasBillingConfig) — the webhook also independently refuses every request.
  flutterwaveWebhookHash: (process.env.FLW_WEBHOOK_HASH || "").trim(),
  // Price is config, not code, so a currency or amount change is a deploy env
  // change. Amount is MAJOR units (9.99 = $9.99 USD).
  proPlanAmount: process.env.PRO_PLAN_AMOUNT ? Number(process.env.PRO_PLAN_AMOUNT) : 9.99,
  proPlanCurrency: process.env.PRO_PLAN_CURRENCY || "USD",
  /** Days of Pro granted per successful payment. */
  proPlanDays: process.env.PRO_PLAN_DAYS ? Number(process.env.PRO_PLAN_DAYS) : 30,
  /** Where Flutterwave returns the user after checkout. */
  appBaseUrl: process.env.APP_BASE_URL || process.env.ALLOWED_ORIGIN || "http://localhost:5174",
};

// A missing JWT_SECRET means every JWT is signed with the publicly-known
// fallback string below — i.e. anyone can forge a token for any user (and the
// WebSocket auth relies entirely on this secret). Refuse to boot rather than run
// with a forgeable secret.
//
// Deliberately NOT gated on nodeEnv. A guard that only fires "in production"
// is disarmed by the very same misconfiguration it exists to catch: forget
// NODE_ENV and you get both the dev CORS policy AND a forgeable secret. The
// secret being the public fallback is itself the danger, whatever the
// environment claims to be. Local dev opts in via .env instead.
const FALLBACK_JWT_SECRET = "pitchnest-dev-secret-change-in-production";
if (config.jwtSecret === FALLBACK_JWT_SECRET) {
  const allowInsecure = process.env.ALLOW_INSECURE_JWT_SECRET === "true";
  if (!allowInsecure) {
    throw new Error(
      "FATAL: JWT_SECRET is not set. Refusing to start with the public " +
        "fallback secret (all tokens would be forgeable, over HTTP and the " +
        "WebSocket). Set JWT_SECRET in your environment. For local dev only, " +
        "set ALLOW_INSECURE_JWT_SECRET=true to bypass this.",
    );
  }
  console.warn(
    "⚠️ SECURITY: running with the PUBLIC fallback JWT secret because " +
      "ALLOW_INSECURE_JWT_SECRET=true. Every token is forgeable. Never do this " +
      "on a deployed environment.",
  );
}

export function hasGoogleAuthConfig(): boolean {
  return !!config.googleClientId;
}

export function hasAzureOpenAiConfig(): boolean {
  return !!(
    config.azureOpenAiEndpoint &&
    config.azureOpenAiApiKey &&
    config.azureOpenAiDeployment
  );
}

export function hasOpenAiConfig(): boolean {
  return hasAzureOpenAiConfig() || !!config.openAiApiKey;
}

export function hasAzureTtsConfig(): boolean {
  return !!(config.azureSpeechKey && config.azureSpeechRegion);
}

export function hasResearchConfig(): boolean {
  return (
    config.researchEnabled && !!(config.tavilyApiKey || config.serperApiKey)
  );
}

/**
 * Checkout can only be offered when we can BOTH call Flutterwave (secret key)
 * AND verify its webhooks (secret hash).
 *
 * Requiring the hash here is what makes the failure mode safe: with no hash the
 * webhook cannot prove a payment is real, so rather than run a half-open state
 * (checkout works, grants can't be verified) we treat billing as fully off.
 * Checkout returns 503, the paywall still holds, and there is no unverifiable
 * grant path. This is a service-level "off", NOT a server-killing throw — a
 * missing hash must never take down auth, pitching, and everything else.
 */
export function hasBillingConfig(): boolean {
  return !!(config.flutterwaveSecretKey && config.flutterwaveWebhookHash);
}

// Loud, non-fatal warning when the secret is present but the hash is not: this
// is almost always a deploy that half-configured billing, and the operator
// needs to see WHY checkout is 503-ing without having to read the source.
if (config.flutterwaveSecretKey && !config.flutterwaveWebhookHash) {
  console.warn(
    "⚠️ Billing DISABLED: FLW_SECRET_KEY is set but FLW_WEBHOOK_HASH is missing. " +
      "Checkout will return 503 until the webhook hash (from your Flutterwave " +
      "dashboard → Settings → Webhooks) is set, because grants could not be verified.",
  );
}

if (!config.supabaseUrl || !config.supabaseAnonKey || !config.supabaseServiceRoleKey) {
  console.warn(
    "⚠️ Warning: SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY is missing in your backend environment variables!",
  );
}

if (!hasOpenAiConfig()) {
  console.error(
    "🚨 CRITICAL: No AI provider configured. Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY + AZURE_OPENAI_DEPLOYMENT (or OPENAI_API_KEY).",
  );
}

if (!hasAzureTtsConfig()) {
  console.error(
    "🚨 CRITICAL: Azure TTS is not configured. Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION for voice output.",
  );
}
