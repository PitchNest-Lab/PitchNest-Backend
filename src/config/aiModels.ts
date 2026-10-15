/**
 * AI model catalogue and per-plan AI profiles.
 *
 * This is the one file to edit when adding a model or changing which plan gets
 * which model. The runtime that reads it (services/aiModelRouter.ts) resolves a
 * model id to a client and request parameters, and adapts to what the model
 * accepts, so call sites never name a deployment themselves.
 *
 * ── TO ADD A MODEL ───────────────────────────────────────────────────────────
 *   1. Add an entry to MODEL_CATALOG below (copy "advanced" and rename it).
 *   2. Set its deployment env var on the server. If it lives in a different
 *      Azure resource, also set the endpoint and key env vars it names.
 *   3. Point a plan at it in PLAN_AI_PROFILES.
 * A model whose deployment env var is empty falls back to "standard", so a half
 * configured model never breaks a session; startup logs say which ones are live.
 *
 * ── THE RULE: UPGRADE THE COACH, NEVER THE JUDGE ─────────────────────────────
 * Plans change the coaching side only: the live panel and the on-screen tips.
 * Scoring (the pitch evaluation and Deck Check) always runs on JUDGE_MODEL, the
 * same for every plan, so a score means the same thing whatever the founder
 * pays, survives an upgrade or downgrade, and stays comparable across re-pitches
 * and shared reports. PLAN_AI_PROFILES deliberately has no field for scoring.
 */

/** Reasoning effort accepted by reasoning-capable models. */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export interface ModelSpec {
  /** Shown in logs only. */
  label: string;
  /** Env var holding the deployment name (Azure) or model name (OpenAI). */
  deploymentEnv: string;
  /** Optional: env vars for a model hosted on a different resource. When unset
   *  or empty, AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY are used. */
  endpointEnv?: string;
  apiKeyEnv?: string;
  /** Env var holding this model's reasoning effort. Unset means "not sent", so
   *  the model uses its own default. */
  reasoningEffortEnv?: string;
  /** What the model accepts. Wrong flags are survivable: the router retries
   *  once without a rejected parameter and remembers the result. */
  supportsReasoningEffort: boolean;
  supportsJsonMode: boolean;
  /** Ceiling for output tokens; larger requests are clamped to it. */
  maxOutputTokens: number;
}

export const MODEL_CATALOG = {
  /** The existing deployment. Every task used it before tiers existed. */
  standard: {
    label: "Standard",
    deploymentEnv: "AZURE_OPENAI_DEPLOYMENT",
    reasoningEffortEnv: "AI_STANDARD_REASONING_EFFORT",
    supportsReasoningEffort: true,
    supportsJsonMode: true,
    maxOutputTokens: 4000,
  },
  /** Stronger coaching for Pro. Until AZURE_OPENAI_DEPLOYMENT_ADVANCED is set it
   *  resolves to "standard". It can also be the same deployment as standard
   *  with a higher AI_ADVANCED_REASONING_EFFORT. */
  advanced: {
    label: "Advanced",
    deploymentEnv: "AZURE_OPENAI_DEPLOYMENT_ADVANCED",
    endpointEnv: "AZURE_OPENAI_ENDPOINT_ADVANCED",
    apiKeyEnv: "AZURE_OPENAI_API_KEY_ADVANCED",
    reasoningEffortEnv: "AI_ADVANCED_REASONING_EFFORT",
    supportsReasoningEffort: true,
    supportsJsonMode: true,
    maxOutputTokens: 4000,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODEL_CATALOG;

/** Always-available fallback for any model that is not configured. */
export const DEFAULT_MODEL: ModelId = "standard";

/** Scores pitches and decks. Identical on every plan — see the rule above. */
export const JUDGE_MODEL: ModelId = "standard";

/** Background helpers (research summaries, health checks). */
export const UTILITY_MODEL: ModelId = "standard";

/** The coaching side of a plan: what talks to the founder during a session. */
export interface PlanAiProfile {
  /** Live panel and coach replies, including the closing verdict. */
  coachModel: ModelId;
  /** The short on-screen answer tips. */
  tipModel: ModelId;
}

/** Entitlement plan keys (entitlementService.Entitlement["plan"] minus aliases). */
export type AiPlanKey = "free" | "prep" | "pro";

export const PLAN_AI_PROFILES: Record<AiPlanKey, PlanAiProfile> = {
  free: { coachModel: "standard", tipModel: "standard" },
  prep: { coachModel: "standard", tipModel: "standard" },
  pro: { coachModel: "advanced", tipModel: "standard" },
};

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODEL_CATALOG, value);
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
}
