import "../helpers/testEnv.ts";
import "../helpers/billingEnvKeysOnly.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signUserToken } from "../helpers/tokens.ts";
import { DUMMY_FLW_HASH } from "../helpers/billingEnv.ts";

/**
 * PROD billing posture: Flutterwave keys PRESENT, BILLING_CHECKOUT_ENABLED="false".
 * Checkout must stay off, no Flutterwave call may be made, and the existing
 * free-trial experience must be unchanged.
 */

const db = new FakeSupabase();
let base = "";
let close: () => Promise<void>;
const flutterwaveCalls: string[] = [];
const realFetch = globalThis.fetch;

const TRIAL = { id: 71, email: "trial@x.test" };
const EXPIRED = { id: 72, email: "expired@x.test" };
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString();

before(async () => {
  // Record (and refuse) any attempt to reach Flutterwave; pass local calls through.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("flutterwave.com")) {
      flutterwaveCalls.push(url);
      return new Response(JSON.stringify({ status: "error" }), { status: 500 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  db.seed("users", [
    { ...TRIAL, isEmailVerified: true, plan: "free", trial_started_at: inDays(-5), trial_expires_at: inDays(25), trial_status: "active" },
    { ...EXPIRED, isEmailVerified: true, plan: "free", trial_started_at: inDays(-40), trial_expires_at: inDays(-10), trial_status: "expired" },
  ]);
  db.seed("payments", []);
  ({ base, close } = await startApp(db));
});

after(async () => {
  globalThis.fetch = realFetch;
  await close();
});

test("public price: billingEnabled=false and Pro monthly is USD 10 for 30 days", async () => {
  const r = await call(base, "GET", "/api/billing/price");
  assert.equal(r.status, 200);
  assert.equal(r.json.billingEnabled, false, "keys alone must not enable billing");
  assert.deepEqual(r.json.price, { amount: 10, currency: "USD", days: 30 });
  const proMonthly = r.json.catalog.find((c: any) => c.plan === "pro" && c.term === "monthly");
  assert.deepEqual(proMonthly, { plan: "pro", term: "monthly", amount: 10, currency: "USD", days: 30, purchasable: true });
  const unsold = r.json.catalog.filter((c: any) => !(c.plan === "pro" && c.term === "monthly"));
  assert.ok(unsold.length > 0 && unsold.every((c: any) => c.purchasable === false), "only Pro monthly is on sale by default");
});

test("checkout is refused with 503 even though both Flutterwave keys are present", async () => {
  const token = signUserToken(TRIAL);
  for (const body of [undefined, {}, { plan: "pro", term: "monthly" }, { plan: "pro", term: "annual" }, { plan: "prep" }]) {
    const r = await call(base, "POST", "/api/billing/checkout", { token, body });
    assert.equal(r.status, 503, `body=${JSON.stringify(body)}`);
    assert.equal(r.json.error, "billing_unavailable");
  }
  assert.equal(db.rows("payments").length, 0, "no payment row may be created");
  assert.deepEqual(flutterwaveCalls, [], "Flutterwave must never be contacted");
});

test("checkout still requires authentication", async () => {
  const r = await call(base, "POST", "/api/billing/checkout");
  assert.equal(r.status, 401);
});

test("webhook: missing or wrong signature is rejected before any processing", async () => {
  const body = { data: { id: 1, tx_ref: "pn-71-0-x", status: "successful", amount: 10, currency: "USD" } };
  assert.equal((await call(base, "POST", "/api/billing/webhook", { body })).status, 401);
  const res = await fetch(`${base}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "verif-hash": DUMMY_FLW_HASH + "x" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(flutterwaveCalls, []);
});

test("free trial preserved: an active-trial user gets the full Pro trial", async () => {
  const r = await call(base, "GET", "/api/billing/plan", { token: signUserToken(TRIAL) });
  assert.equal(r.status, 200);
  assert.equal(r.json.plan, "pro");
  assert.equal(r.json.isTrial, true);
  assert.ok(r.json.trialDaysRemaining >= 24 && r.json.trialDaysRemaining <= 26);
  assert.equal(r.json.billingEnabled, false);
  assert.deepEqual(flutterwaveCalls, [], "plan reads never call Flutterwave in production mode");
});

test("free trial preserved: an expired trial falls back to the free tier", async () => {
  const r = await call(base, "GET", "/api/billing/plan", { token: signUserToken(EXPIRED) });
  assert.equal(r.status, 200);
  assert.equal(r.json.plan, "free");
  assert.equal(r.json.isTrial, false);
});

test("trial length is independent of PRO_PLAN_DAYS (still 30 days for new accounts)", async () => {
  const { FREE_TRIAL_DAYS, entitlementsForPlan } = await import("../../services/entitlementService.ts");
  assert.equal(FREE_TRIAL_DAYS, 30);
  const ent = entitlementsForPlan("free", null, inDays(10), "active", inDays(-20));
  assert.equal(ent.isTrial, true);
  assert.equal(ent.pdfDownload, true);
  assert.equal(ent.maxWeeklySessions, Infinity);
});
