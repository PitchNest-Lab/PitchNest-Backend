import "./testEnv.ts";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVE_REASONING_EFFORT,
  JUDGE_MODEL,
  MODEL_CATALOG,
  PLAN_AI_PROFILES,
  REASONING_HEADROOM,
  isModelId,
  type ModelId,
} from "../config/aiModels.ts";
import {
  __setClientFactoryForTests,
  completeChat,
  describeModels,
  resolveModel,
  streamChat,
} from "../services/aiModelRouter.ts";
import { entitlementsForPlan, FREE } from "../services/entitlementService.ts";

// ── Catalogue and plan profiles ─────────────────────────────────────────────

for (const [plan, profile] of Object.entries(PLAN_AI_PROFILES)) {
  assert.ok(isModelId(profile.coachModel), `${plan} coach model exists in the catalogue`);
  assert.ok(isModelId(profile.tipModel), `${plan} tip model exists in the catalogue`);
  assert.equal("judgeModel" in profile, false, `${plan} profile has no say over scoring`);
}
assert.ok(isModelId(JUDGE_MODEL), "judge model exists in the catalogue");
for (const id of Object.keys(MODEL_CATALOG) as ModelId[]) {
  assert.ok(MODEL_CATALOG[id].maxOutputTokens > 0, `${id} declares an output ceiling`);
}

// Entitlements carry the profile for their plan; trial and enterprise coach as Pro.
assert.equal(FREE.ai, PLAN_AI_PROFILES.free);
assert.equal(entitlementsForPlan("prep", null).ai, PLAN_AI_PROFILES.prep);
assert.equal(entitlementsForPlan("pro", null).ai, PLAN_AI_PROFILES.pro);
assert.equal(entitlementsForPlan("enterprise", null).ai, PLAN_AI_PROFILES.pro);
const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
assert.equal(entitlementsForPlan("free", null, future, "active").ai, PLAN_AI_PROFILES.pro);

// ── Resolution and fallback ─────────────────────────────────────────────────

process.env.AZURE_OPENAI_DEPLOYMENT = "base-deploy";
delete process.env.AZURE_OPENAI_DEPLOYMENT_ADVANCED;
delete process.env.AI_ADVANCED_REASONING_EFFORT;
delete process.env.AI_STANDARD_REASONING_EFFORT;
delete process.env.AI_LIVE_REASONING_EFFORT;
__setClientFactoryForTests(null);

const fellBack = resolveModel("advanced");
assert.equal(fellBack.id, "standard", "an unconfigured model falls back to standard");
assert.equal(fellBack.requested, "advanced");
assert.equal(fellBack.deployment, "base-deploy");
assert.equal(resolveModel("not-a-model").id, "standard", "unknown ids resolve to the default");
assert.ok(describeModels().some((line) => line.startsWith("advanced: falls back")));

process.env.AZURE_OPENAI_DEPLOYMENT_ADVANCED = "big-deploy";
process.env.AI_ADVANCED_REASONING_EFFORT = "HIGH";
const advanced = resolveModel("advanced");
assert.equal(advanced.id, "advanced");
assert.equal(advanced.deployment, "big-deploy");
assert.equal(advanced.reasoningEffort, "high", "reasoning effort is read from env, case-insensitively");

process.env.AI_ADVANCED_REASONING_EFFORT = "turbo";
assert.equal(resolveModel("advanced").reasoningEffort, undefined, "invalid efforts are ignored");
process.env.AI_ADVANCED_REASONING_EFFORT = "high";

// ── Calls through a fake client ─────────────────────────────────────────────

const calls: any[] = [];
let rejectNext: string | null = null;
const refusedEfforts = new Set<string>();

function fakeClient(): any {
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          if (rejectNext && rejectNext in params) {
            const err: any = new Error(`400 Unsupported parameter: '${rejectNext}' is not supported with this model.`);
            err.status = 400;
            throw err;
          }
          if (refusedEfforts.has(params.reasoning_effort)) {
            const err: any = new Error(
              `400 Unsupported value: 'reasoning_effort' does not support '${params.reasoning_effort}' with this model.`,
            );
            err.status = 400;
            throw err;
          }
          if (params.stream) {
            return (async function* () {
              yield { choices: [{ delta: { content: "Hel" } }] };
              yield { choices: [{ delta: {} }] };
              yield { choices: [{ delta: { content: "lo" } }] };
            })();
          }
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };
}
__setClientFactoryForTests(fakeClient);

// Parameters follow the model: deployment, effort, JSON mode, clamped budget.
let text = await completeChat("advanced", { messages: [{ role: "user", content: "hi" }], maxTokens: 999_999, json: true });
assert.equal(text, "ok");
assert.equal(calls[0].model, "big-deploy");
assert.equal(calls[0].reasoning_effort, "high");
assert.deepEqual(calls[0].response_format, { type: "json_object" });
assert.equal(calls[0].max_completion_tokens, MODEL_CATALOG.advanced.maxOutputTokens, "budget clamped to the model ceiling");

// No effort configured → none sent; no JSON requested → no response_format.
// The budget still leaves room for the reasoning the model does by default.
calls.length = 0;
await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
assert.equal(calls[0].model, "base-deploy");
assert.equal("reasoning_effort" in calls[0], false);
assert.equal("response_format" in calls[0], false);
assert.equal(calls[0].max_completion_tokens, 50 + REASONING_HEADROOM.default, "room for default reasoning");

// Live calls on a model with no effort of its own send the live effort.
calls.length = 0;
await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, live: true });
assert.equal(calls[0].reasoning_effort, DEFAULT_LIVE_REASONING_EFFORT);
assert.equal(calls[0].max_completion_tokens, 50 + REASONING_HEADROOM[DEFAULT_LIVE_REASONING_EFFORT]);
process.env.AI_LIVE_REASONING_EFFORT = "low";
calls.length = 0;
await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, live: true });
assert.equal(calls[0].reasoning_effort, "low", "the live effort can be overridden");
delete process.env.AI_LIVE_REASONING_EFFORT;

// A model's own effort wins over the live one, and sizes the budget.
calls.length = 0;
await completeChat("advanced", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, live: true });
assert.equal(calls[0].reasoning_effort, "high");
assert.equal(calls[0].max_completion_tokens, 50 + REASONING_HEADROOM.high);

// A level the deployment does not offer is stepped up and remembered.
calls.length = 0;
refusedEfforts.add("none");
refusedEfforts.add("minimal");
text = await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, live: true });
assert.equal(text, "ok");
assert.deepEqual(calls.map((c) => c.reasoning_effort), ["none", "minimal", "low"]);
calls.length = 0;
await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, live: true });
assert.deepEqual(calls.map((c) => c.reasoning_effort), ["low"], "refused levels are not retried");
assert.equal(calls[0].max_completion_tokens, 50 + REASONING_HEADROOM.low);
refusedEfforts.clear();

// A rejected optional parameter is retried without it, then remembered.
calls.length = 0;
rejectNext = "reasoning_effort";
text = await completeChat("advanced", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
assert.equal(text, "ok", "the call still succeeds");
assert.equal(calls.length, 2, "one failed attempt, one retry");
assert.equal("reasoning_effort" in calls[1], false);
calls.length = 0;
await completeChat("advanced", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
assert.equal(calls.length, 1, "the rejection is remembered for the deployment");
assert.equal("reasoning_effort" in calls[0], false);
assert.equal(calls[0].max_completion_tokens, 50, "a model that does not reason gets no reasoning room");

// JSON mode rejection is handled the same way.
calls.length = 0;
rejectNext = "response_format";
text = await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50, json: true });
assert.equal(text, "ok");
assert.equal(calls.length, 2);
assert.equal("response_format" in calls[1], false);
rejectNext = null;

// Other errors are not swallowed.
__setClientFactoryForTests(() => ({
  chat: { completions: { create: async () => { const e: any = new Error("429 Too Many Requests"); e.status = 429; throw e; } } },
}) as any);
await assert.rejects(
  completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 }),
  /429/,
);

// A call that spends its whole budget before answering returns "" and says why.
__setClientFactoryForTests(() => ({
  chat: {
    completions: {
      create: async () => ({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
        usage: { completion_tokens_details: { reasoning_tokens: 2098 } },
      }),
    },
  },
}) as any);
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (message?: any) => {
  warnings.push(String(message));
};
text = await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
console.warn = originalWarn;
assert.equal(text, "");
assert.ok(
  warnings.some((w) => w.includes("whole") && w.includes("2098 on reasoning")),
  "an exhausted budget is logged with its reasoning-token count",
);

// Streaming yields only the text deltas, in order.
__setClientFactoryForTests(fakeClient);
let streamed = "";
for await (const delta of await streamChat("advanced", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 })) {
  streamed += delta;
}
assert.equal(streamed, "Hello");

__setClientFactoryForTests(null);
console.log("AI model catalogue, plan profiles and router tests passed.");
process.exit(0);
