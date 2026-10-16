import { createHash } from "node:crypto";
import { OpenAI, AzureOpenAI } from "openai";
import { Agent } from "undici";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../config/env.ts";
import {
  DEFAULT_LIVE_REASONING_EFFORT,
  DEFAULT_MODEL,
  LIVE_REASONING_EFFORT_ENV,
  MODEL_CATALOG,
  REASONING_EFFORTS,
  REASONING_HEADROOM,
  isModelId,
  parseReasoningEffort,
  type ModelId,
  type ModelSpec,
  type ReasoningEffort,
} from "../config/aiModels.ts";

/**
 * Turns a model id from config/aiModels.ts into a client and request
 * parameters. Every chat call in the app goes through completeChat or
 * streamChat, so adding a model never touches a call site.
 *
 * Four behaviours make a new model safe to drop in:
 *  - Fallback. A model with no deployment configured resolves to the default
 *    model, with one warning, instead of failing sessions.
 *  - Budgets. Callers ask for the visible output they need; room for hidden
 *    reasoning at the effort being sent is added, then the total is capped at
 *    the model's maxOutputTokens.
 *  - Self-correction. If the API rejects an optional parameter (reasoning
 *    effort, JSON mode), the call is retried once without it and the rejection
 *    is remembered for that deployment, so a wrong capability flag costs one
 *    failed request per process rather than every session. A reasoning level
 *    the model does not offer is stepped up to the next level instead.
 *  - Diagnosis. A call that spends its whole budget before answering is logged
 *    with its reasoning-token count, rather than surfacing as a bare "" result.
 */

export interface ResolvedModel {
  /** The catalogue entry actually used, after any fallback. */
  id: ModelId;
  /** What the caller asked for. Differs from `id` when it fell back. */
  requested: ModelId;
  label: string;
  deployment: string;
  endpoint: string;
  apiKey: string;
  reasoningEffort?: ReasoningEffort;
  spec: ModelSpec;
}

export interface ChatRequest {
  messages: ChatCompletionMessageParam[];
  /** Tokens of visible output the caller needs. Room for hidden reasoning is
   *  added on top (REASONING_HEADROOM). */
  maxTokens: number;
  /** Ask for a JSON object. Callers must still parse leniently: a model
   *  without JSON mode answers in prose that contains the object. */
  json?: boolean;
  /** A founder is waiting on this answer in real time. Unless the model has
   *  its own reasoning effort configured, the live effort is sent. */
  live?: boolean;
}

type OptionalParam = "reasoning_effort" | "response_format";

interface OptionalParams {
  reasoning_effort?: ReasoningEffort;
  response_format?: { type: "json_object" };
}

// A session's panel turns are 20–30 s apart, and fetch closes idle sockets
// after ~4 s, so every reply used to start with a fresh TCP + TLS handshake to
// Azure (0.7–1.3 s measured from a developer machine). Keeping idle connections
// for a minute took the first token after a 20 s gap from 2.3 s to 1.1 s. A
// socket the far end dropped meanwhile fails as a connection error, which the
// SDK's retry below absorbs; a shorter Keep-Alive hint from the server wins.
const keepAliveDispatcher = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 60_000 });

// The SDK defaults to a ten-minute timeout and two retries. Live coaching
// should fail promptly enough for the socket to recover and should not keep
// expensive upstream requests alive after the user has moved on.
const CLIENT_OPTIONS = {
  timeout: 90_000,
  maxRetries: 1,
  fetchOptions: { dispatcher: keepAliveDispatcher },
} as const;

function readEnv(name?: string): string {
  return name ? (process.env[name] || "").trim() : "";
}

const fallbackWarnings = new Set<string>();

export function resolveModel(requested: unknown): ResolvedModel {
  const id: ModelId = isModelId(requested) ? requested : DEFAULT_MODEL;
  const spec: ModelSpec = MODEL_CATALOG[id];

  let deployment = readEnv(spec.deploymentEnv);
  // Historical behaviour, kept for installs that use a plain OpenAI key and
  // never set a deployment name.
  if (!deployment && id === DEFAULT_MODEL) deployment = "gpt-4o";

  if (!deployment) {
    if (!fallbackWarnings.has(id)) {
      fallbackWarnings.add(id);
      console.warn(`[ai] Model "${id}" is not configured (${spec.deploymentEnv} is empty); using "${DEFAULT_MODEL}".`);
    }
    return { ...resolveModel(DEFAULT_MODEL), requested: id };
  }

  // A separate endpoint brings its own key; otherwise share the main resource.
  const ownEndpoint = readEnv(spec.endpointEnv);
  const endpoint = ownEndpoint || config.azureOpenAiEndpoint || "";
  const apiKey = (ownEndpoint && readEnv(spec.apiKeyEnv)) || config.azureOpenAiApiKey || "";

  return {
    id,
    requested: id,
    label: spec.label,
    deployment,
    endpoint,
    apiKey,
    reasoningEffort: parseReasoningEffort(readEnv(spec.reasoningEffortEnv)),
    spec,
  };
}

// ── Clients ─────────────────────────────────────────────────────────────────

function buildClient(model: ResolvedModel): OpenAI {
  if (model.endpoint && model.apiKey) {
    const raw = model.endpoint.trim();
    // Azure AI Foundry / Azure OpenAI v1 endpoints route by the `model` field.
    if (raw.includes("/openai/v1")) {
      return new OpenAI({
        ...CLIENT_OPTIONS,
        baseURL: raw.replace(/\/responses$/, "").replace(/\/+$/, ""),
        apiKey: model.apiKey,
        defaultHeaders: { "api-key": model.apiKey },
      });
    }
    // Classic Azure endpoints route by the deployment baked into the client,
    // which is why clients are cached per deployment.
    let origin = raw;
    try {
      origin = new URL(raw).origin;
    } catch {
      origin = raw.replace(/\/+$/, "");
    }
    return new AzureOpenAI({
      ...CLIENT_OPTIONS,
      endpoint: origin,
      apiKey: model.apiKey,
      apiVersion: config.azureOpenAiApiVersion,
      deployment: model.deployment,
    });
  }
  return new OpenAI({ ...CLIENT_OPTIONS, apiKey: config.openAiApiKey });
}

let clientFactory: (model: ResolvedModel) => OpenAI = buildClient;
const clients = new Map<string, OpenAI>();

function clientKey(model: ResolvedModel): string {
  // Never duplicate a provider credential into a long-lived Map key. The
  // fingerprint keeps clients with rotated keys distinct without retaining the
  // plaintext secret anywhere beyond the SDK client that actually needs it.
  const credentialFingerprint = createHash("sha256")
    .update(model.apiKey || config.openAiApiKey || "")
    .digest("hex");
  return `${model.endpoint}|${model.deployment}|${credentialFingerprint}`;
}

export function clientFor(model: ResolvedModel): OpenAI {
  const key = clientKey(model);
  let client = clients.get(key);
  if (!client) {
    client = clientFactory(model);
    clients.set(key, client);
  }
  return client;
}

// ── Parameters ──────────────────────────────────────────────────────────────

/** Optional parameters each deployment has rejected, learned at runtime. */
const rejectedParams = new Map<string, Set<OptionalParam>>();
/** Reasoning levels each deployment has said it does not offer. */
const rejectedEfforts = new Map<string, Set<ReasoningEffort>>();

function deploymentKey(model: ResolvedModel): string {
  return `${model.endpoint}|${model.deployment}`;
}

function remember<V>(map: Map<string, Set<V>>, key: string, value: V): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}

function liveReasoningEffort(): ReasoningEffort {
  return parseReasoningEffort(readEnv(LIVE_REASONING_EFFORT_ENV)) ?? DEFAULT_LIVE_REASONING_EFFORT;
}

/** The effort to send: the model's own, else the live one for live calls,
 *  stepped up past any level this deployment has refused. */
function effortFor(model: ResolvedModel, req: ChatRequest): ReasoningEffort | undefined {
  const wanted = model.reasoningEffort ?? (req.live ? liveReasoningEffort() : undefined);
  if (!wanted) return undefined;
  const refused = rejectedEfforts.get(deploymentKey(model));
  return REASONING_EFFORTS.slice(REASONING_EFFORTS.indexOf(wanted)).find((e) => !refused?.has(e));
}

function optionalParams(model: ResolvedModel, req: ChatRequest): OptionalParams {
  const rejected = rejectedParams.get(deploymentKey(model));
  const out: OptionalParams = {};
  if (model.spec.supportsReasoningEffort && !rejected?.has("reasoning_effort")) {
    const effort = effortFor(model, req);
    if (effort) out.reasoning_effort = effort;
  }
  if (req.json && model.spec.supportsJsonMode && !rejected?.has("response_format")) {
    out.response_format = { type: "json_object" };
  }
  return out;
}

function maxTokensFor(model: ResolvedModel, req: ChatRequest, optional: OptionalParams): number {
  const visible = Math.max(1, Math.floor(Number(req.maxTokens) || 1));
  const reasons =
    model.spec.supportsReasoningEffort &&
    !rejectedParams.get(deploymentKey(model))?.has("reasoning_effort");
  const headroom = reasons ? REASONING_HEADROOM[optional.reasoning_effort ?? "default"] : 0;
  return Math.min(visible + headroom, model.spec.maxOutputTokens);
}

/** Which optional parameter, if any, a 400 response complained about. */
function rejectedParam(err: any, sent: OptionalParams): OptionalParam | null {
  if (Number(err?.status) !== 400) return null;
  const detail = `${err?.message ?? ""} ${JSON.stringify(err?.error ?? "")}`;
  for (const param of Object.keys(sent) as OptionalParam[]) {
    if (detail.includes(param)) return param;
  }
  return null;
}

/** True when the API accepts the parameter but not the value sent. */
function isUnsupportedValue(err: any): boolean {
  const detail = `${err?.message ?? ""} ${JSON.stringify(err?.error ?? "")}`;
  return /unsupported[ _]value/i.test(detail);
}

async function withParamFallback<T>(
  model: ResolvedModel,
  req: ChatRequest,
  run: (optional: OptionalParams) => Promise<T>,
): Promise<T> {
  // At most one retry per optional parameter, plus one per refused effort level.
  for (;;) {
    const optional = optionalParams(model, req);
    try {
      return await run(optional);
    } catch (err) {
      const param = rejectedParam(err, optional);
      if (!param) throw err;
      const key = deploymentKey(model);
      if (param === "reasoning_effort" && optional.reasoning_effort && isUnsupportedValue(err)) {
        remember(rejectedEfforts, key, optional.reasoning_effort);
        const next = effortFor(model, req);
        console.warn(
          `[ai] ${model.label} (${model.deployment}) does not offer reasoning effort "${optional.reasoning_effort}"; ` +
            (next ? `using "${next}".` : "sending none."),
        );
        continue;
      }
      remember(rejectedParams, key, param);
      console.warn(`[ai] ${model.label} (${model.deployment}) rejected ${param}; retrying without it.`);
    }
  }
}

function warnIfBudgetSpent(
  model: ResolvedModel,
  budget: number,
  finishReason: string | null | undefined,
  hadText: boolean,
  usage: any,
): void {
  if (hadText || finishReason !== "length") return;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  console.warn(
    `[ai] ${model.label} (${model.deployment}) used its whole ${budget}-token budget before answering` +
      (typeof reasoning === "number" ? ` (${reasoning} on reasoning).` : "."),
  );
}

// ── Calls ───────────────────────────────────────────────────────────────────

/** One non-streamed completion. Returns the message text ("" when empty). */
export async function completeChat(
  modelId: unknown,
  req: ChatRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const model = resolveModel(modelId);
  const client = clientFor(model);
  return withParamFallback(model, req, async (optional) => {
    const budget = maxTokensFor(model, req, optional);
    const response = await client.chat.completions.create(
      {
        model: model.deployment,
        messages: req.messages,
        max_completion_tokens: budget,
        ...optional,
      },
      { signal: opts.signal },
    );
    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";
    warnIfBudgetSpent(model, budget, choice?.finish_reason, Boolean(text), response.usage);
    return text;
  });
}

/**
 * A streamed completion as text deltas. The request is sent (and any rejected
 * parameter retried) before the first delta, so callers see either a working
 * stream or the original error.
 */
export async function streamChat(
  modelId: unknown,
  req: ChatRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<AsyncIterable<string>> {
  const model = resolveModel(modelId);
  const client = clientFor(model);
  let budget = 0;
  const stream = await withParamFallback(model, req, (optional) => {
    budget = maxTokensFor(model, req, optional);
    return client.chat.completions.create(
      {
        model: model.deployment,
        messages: req.messages,
        max_completion_tokens: budget,
        stream: true,
        ...optional,
      },
      { signal: opts.signal },
    );
  });
  return (async function* () {
    let hadText = false;
    let finishReason: string | null | undefined;
    for await (const chunk of stream) {
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        hadText = true;
        yield text;
      }
    }
    warnIfBudgetSpent(model, budget, finishReason, hadText, undefined);
  })();
}

// ── Startup report ──────────────────────────────────────────────────────────

/** One line per catalogue entry: what it resolves to right now. */
export function describeModels(): string[] {
  const lines = (Object.keys(MODEL_CATALOG) as ModelId[]).map((id) => {
    const model = resolveModel(id);
    const target = model.id === id ? model.deployment : `falls back to "${model.id}"`;
    const effort = model.reasoningEffort ? `, reasoning ${model.reasoningEffort}` : "";
    return `${id}: ${target}${model.id === id ? effort : ""}`;
  });
  lines.push(`live calls: reasoning ${liveReasoningEffort()} where a model sets none`);
  return lines;
}

/** Pings every distinct configured deployment once. Never throws. */
export async function checkModels(): Promise<void> {
  const seen = new Set<string>();
  for (const id of Object.keys(MODEL_CATALOG) as ModelId[]) {
    const model = resolveModel(id);
    if (model.id !== id || seen.has(deploymentKey(model))) continue;
    seen.add(deploymentKey(model));
    try {
      await completeChat(id, { messages: [{ role: "user", content: "ping" }], maxTokens: 5 });
      console.log(`🟢 AI model "${id}" (${model.deployment}) is reachable.`);
    } catch (err: any) {
      console.error(`⚠️ AI model "${id}" (${model.deployment}) failed its startup check:`, err?.message || err);
    }
  }
}

// ── Tests only ──────────────────────────────────────────────────────────────

export function __setClientFactoryForTests(factory: ((model: ResolvedModel) => OpenAI) | null): void {
  clientFactory = factory ?? buildClient;
  clients.clear();
  rejectedParams.clear();
  rejectedEfforts.clear();
  fallbackWarnings.clear();
}
