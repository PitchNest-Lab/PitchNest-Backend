import dotenv from "dotenv";
import { DEFAULT_STT_LOCALE } from "../utils/transcriptionLocales.ts";

dotenv.config();

/**
 * createClient expects the Supabase project base URL. Dashboard API docs also
 * display a `/rest/v1` endpoint, which is easy to copy by mistake; the SDK adds
 * that path itself and a pre-appended value produces `/rest/v1/rest/v1/...`.
 */
function normalizeSupabaseProjectUrl(value: string): string {
  return value
    .trim()
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/+$/, "");
}

export const config = {
  supabaseUrl: normalizeSupabaseProjectUrl(process.env.SUPABASE_URL || ""),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
  isGoogleCloud: !!process.env.K_SERVICE,
  jwtSecret: process.env.JWT_SECRET || "pitchnest-dev-secret-change-in-production",
  allowedOrigin: process.env.ALLOWED_ORIGIN || "http://localhost:5174",
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || "",
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || "",
  // Fallback speech-to-text language for anyone who has not chosen one. en-NG is
  // the Africa-first default — recognition was previously hardcoded to en-US
  // while the panel prompts apologised for Nigerian English, so every
  // mis-transcribed word was scored as though the founder had said it.
  //
  // Config rather than a constant so the global default can be moved without a
  // deploy, and backed out if a Speech region turns out not to serve en-NG.
  // Validated against the allowlist in utils/transcriptionLocales at use time,
  // so a bad value here degrades to the default instead of breaking sessions.
  sttDefaultLocale:
    (process.env.STT_DEFAULT_LOCALE || "").trim() || DEFAULT_STT_LOCALE,
  openAiApiKey: process.env.OPENAI_API_KEY || "",
  azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
  azureOpenAiDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || "",
  azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  resendApiKey: (process.env.RESEND_API_KEY || "").trim(),
  // Defaults to "production" so a deploy that FORGETS to set NODE_ENV fails
  // CLOSED. Getting this backwards is silent and severe: `isProduction` gates
  // the CORS allow-list in app.ts, so a "development" default would reflect
  // ANY origin with credentials:true on the live site. Local dev sets
  // NODE_ENV=development explicitly in .env / npm scripts.
  nodeEnv: process.env.NODE_ENV || "production",
  emailFrom: process.env.EMAIL_FROM || "PitchNest <hello@pitchnest.app>",
  // Where user REPLIES go. This is deliberately a different address from
  // emailFrom: Resend will only send from a domain we have verified by DNS, and
  // gmail.com can never be verified (it returns 403 "domain is not verified"),
  // so a Gmail address cannot be the sender. Reply-To is the supported way to
  // route replies into that inbox while still sending from pitchnest.app.
  emailReplyTo: process.env.EMAIL_REPLY_TO || "pitchnestapp@gmail.com",
  // The public origin of the FRONTEND, used to build links inside outbound email.
  // A verification link or a trial reminder that points at localhost is a dead
  // end for the recipient and silently unrecoverable, so this is read through
  // config rather than scattered process.env lookups. Trailing slashes are
  // tolerated by the consumers, which strip them before composing a path.
  clientUrl: (process.env.CLIENT_URL || "http://localhost:5174").replace(/\/+$/, ""),
  storageBucket: process.env.SUPABASE_STORAGE_BUCKET || "pitchnest-media",
  // Item A: avatars stay PUBLIC (low-sensitivity, shown unsigned on every page)
  // in a SEPARATE bucket, so the main media bucket can be fully private.
  avatarBucket: process.env.SUPABASE_AVATAR_BUCKET || "pitchnest-avatars",
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
  // change. Amount is MAJOR units (15 = $15.00 USD).
  proPlanAmount: process.env.PRO_PLAN_AMOUNT ? Number(process.env.PRO_PLAN_AMOUNT) : 15.00,
  proPlanCurrency: process.env.PRO_PLAN_CURRENCY || "USD",
  /** Days of Pro granted per successful payment. */
  proPlanDays: process.env.PRO_PLAN_DAYS ? Number(process.env.PRO_PLAN_DAYS) : 30,
  /** Where Flutterwave returns the user after checkout. */
  appBaseUrl: process.env.APP_BASE_URL || process.env.ALLOWED_ORIGIN || "http://localhost:5174",
  // ── Ecosystem feature flags ──────────────────────────────────────────────
  // Public mutation surfaces ship dark. Discover engagement (support, follow,
  // comments, reports) is on in development and OFF in production until
  // FEATURE_DISCOVER_ENGAGEMENT=true is set — after migration 0021 is applied
  // and a moderator has been granted users.is_staff.
  discoverEngagementEnabled: process.env.FEATURE_DISCOVER_ENGAGEMENT
    ? process.env.FEATURE_DISCOVER_ENGAGEMENT.trim() === "true"
    : (process.env.NODE_ENV || "production") !== "production",
  // Community discussions (/community). Separate from Discover engagement so
  // it can launch on its own once moderation capacity exists. Same default:
  // on in development, OFF in production until FEATURE_COMMUNITY=true.
  communityEnabled: process.env.FEATURE_COMMUNITY
    ? process.env.FEATURE_COMMUNITY.trim() === "true"
    : (process.env.NODE_ENV || "production") !== "production",
  // Pitch Arena (public text pitches and structured feedback). Same default:
  // on in development, OFF in production until FEATURE_PITCH_ARENA=true.
  pitchArenaEnabled: process.env.FEATURE_PITCH_ARENA
    ? process.env.FEATURE_PITCH_ARENA.trim() === "true"
    : (process.env.NODE_ENV || "production") !== "production",
};

// ── Billing catalog: purchasable SKUs (level × term) ─────────────────────────
// Two paid levels, each on two terms. Price and day-count are SERVER-SIDE and
// authoritative: both the display (/price, /plan) and the charge (createCheckout)
// read the SAME resolver, so what a founder is shown can never drift from what
// the checkout records and the webhook grants.
export type PaidPlan = "prep" | "pro";
export type BillingTerm = "monthly" | "annual";

export interface ResolvedPrice {
  plan: PaidPlan;
  term: BillingTerm;
  /** Major units (15 = $15.00). */
  amount: number;
  currency: string;
  /** Days of access this SKU grants. */
  days: number;
}

function envAmount(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const ANNUAL_DAYS = process.env.PRO_ANNUAL_DAYS
  ? Number(process.env.PRO_ANNUAL_DAYS)
  : 365;

// Amounts per (plan, term). Founder (Prep) = $9.99/mo, Pro Founder = $15.00/mo
// (matches the published pricing deck). Annual defaults to 10x the monthly
// (≈2 months free), kept to 2 decimals so $9.99/mo → $99.90/yr not $100.
const FOUNDER_MONTHLY = envAmount("FOUNDER_PLAN_AMOUNT", envAmount("PREP_PLAN_AMOUNT", 9.99));
const twoDp = (n: number) => Math.round(n * 100) / 100;
const PLAN_AMOUNTS: Record<PaidPlan, Record<BillingTerm, number>> = {
  prep: {
    monthly: FOUNDER_MONTHLY,
    annual: envAmount("FOUNDER_ANNUAL_AMOUNT", twoDp(FOUNDER_MONTHLY * 10)),
  },
  pro: {
    monthly: config.proPlanAmount,
    annual: envAmount("PRO_ANNUAL_AMOUNT", twoDp(config.proPlanAmount * 10)),
  },
};

const TERM_DAYS: Record<BillingTerm, number> = {
  monthly: config.proPlanDays,
  annual: ANNUAL_DAYS,
};

export function isPaidPlan(v: unknown): v is PaidPlan {
  return v === "prep" || v === "pro";
}

export function isBillingTerm(v: unknown): v is BillingTerm {
  return v === "monthly" || v === "annual";
}

/** The authoritative price for one SKU. Never takes client input. */
export function resolvePlanPrice(plan: PaidPlan, term: BillingTerm): ResolvedPrice {
  return {
    plan,
    term,
    amount: PLAN_AMOUNTS[plan][term],
    currency: config.proPlanCurrency,
    days: TERM_DAYS[term],
  };
}

/** Every purchasable SKU, for the pricing UI. */
export function listBillingCatalog(): ResolvedPrice[] {
  const plans: PaidPlan[] = ["prep", "pro"];
  const terms: BillingTerm[] = ["monthly", "annual"];
  return plans.flatMap((p) => terms.map((t) => resolvePlanPrice(p, t)));
}


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
