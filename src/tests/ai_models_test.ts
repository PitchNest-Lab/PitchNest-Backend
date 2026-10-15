import "./testEnv.ts";
import assert from "node:assert/strict";
import {
  JUDGE_MODEL,
  MODEL_CATALOG,
  PLAN_AI_PROFILES,
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
calls.length = 0;
await completeChat("standard", { messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
assert.equal(calls[0].model, "base-deploy");
assert.equal("reasoning_effort" in calls[0], false);
assert.equal("response_format" in calls[0], false);

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
