import "../helpers/testEnv.ts";
import "../helpers/billingEnvEnabled.ts";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FakeSupabase } from "../helpers/fakeSupabase.ts";
import { startApp, call } from "../helpers/httpServer.ts";
import { signUserToken } from "../helpers/tokens.ts";

/**
 * FUTURE posture (switch explicitly "true"): checkout may only ever sell
 * Pro monthly at USD 15 for 30 days. Flutterwave is mocked — no network call
 * leaves this process.
 */

const db = new FakeSupabase();
let base = "";
let close: () => Promise<void>;
const realFetch = globalThis.fetch;
const flutterwaveRequests: { url: string; body: any }[] = [];
const USER = { id: 81, email: "buyer@x.test" };

before(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.includes("flutterwave.com")) {
      flutterwaveRequests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      // Checkout subscribes the card to a payment plan, created once per SKU.
      const data = url.endsWith("/payment-plans")
        ? { id: 8000 }
        : { link: "https://checkout.flutterwave.com/v3/hosted/pay/mock" };
      return new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  // One extra user per refused-SKU case: checkout is rate-limited to 8 per
  // user per 10 minutes, and these tests must not trip that limiter.
  db.seed("users", [
    { ...USER, name: "Buyer", isEmailVerified: true, plan: "free", trial_status: "expired" },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 900 + i, email: `refused${i}@x.test`, isEmailVerified: true, plan: "free", trial_status: "expired",
    })),
  ]);
  ({ base, close } = await startApp(db));
});

beforeEach(() => {
  db.seed("payments", []);
  flutterwaveRequests.length = 0;
});

after(async () => {
  globalThis.fetch = realFetch;
  await close();
});

test("price reports billingEnabled=true only when the switch is explicitly 'true'", async () => {
  const r = await call(base, "GET", "/api/billing/price");
  assert.equal(r.json.billingEnabled, true);
});

for (const [label, body] of [
  ["no body (what the web client sends)", undefined],
  ["explicit pro/monthly", { plan: "pro", term: "monthly" }],
] as const) {
  test(`checkout sells Pro monthly at USD 15 for one monthly term — ${label}`, async () => {
    const { initialGrantDays } = await import("../../services/subscriptionService.ts");
    const r = await call(base, "POST", "/api/billing/checkout", { token: signUserToken(USER), body });
    assert.equal(r.status, 200);
    assert.equal(r.json.paymentLink, "https://checkout.flutterwave.com/v3/hosted/pay/mock");

    const rows = db.rows("payments");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].plan, "pro");
    assert.equal(rows[0].term, "monthly");
    assert.equal(rows[0].amount, 15);
    assert.equal(rows[0].currency, "USD");
    // One calendar month plus the renewal grace, and no free-month bonus.
    assert.equal(rows[0].granted_days, initialGrantDays("monthly", 0));
    assert.equal(rows[0].bonus_days, 0);
    assert.equal(rows[0].status, "pending");

    const payments = flutterwaveRequests.filter((req) => req.url.endsWith("/payments"));
    assert.equal(payments.length, 1);
    assert.equal(payments[0].body.amount, 15);
    assert.equal(payments[0].body.currency, "USD");
    assert.equal(payments[0].body.payment_plan, 8000);
    assert.equal(payments[0].body.meta.plan, "pro");
    assert.equal(payments[0].body.meta.term, "monthly");
  });
}

// Real SKUs that are simply not on sale yet, and values that are no SKU at all.
const UNSOLD_BODIES = [
  { plan: "pro", term: "annual" },
  { plan: "prep", term: "monthly" },
  { plan: "prep", term: "annual" },
  { plan: "prep" },
  { term: "annual" },
];
const INVALID_BODIES = [{ plan: "enterprise" }, { plan: "pro", term: "weekly" }];
[...UNSOLD_BODIES, ...INVALID_BODIES].forEach((body, i) => {
  test(`checkout refuses non-Pro-monthly SKU ${JSON.stringify(body)} with 400 and no charge`, async () => {
    const buyer = { id: 900 + i, email: `refused${i}@x.test` };
    const r = await call(base, "POST", "/api/billing/checkout", { token: signUserToken(buyer), body });
    assert.equal(r.status, 400);
    if (UNSOLD_BODIES.includes(body)) assert.equal(r.json.error, "plan_not_available");
    assert.equal(db.rows("payments").length, 0);
    assert.equal(flutterwaveRequests.length, 0);
  });
});

test("createCheckout itself refuses other SKUs (defence in depth)", async () => {
  const { createCheckout } = await import("../../services/flutterwaveService.ts");
  await assert.rejects(
    createCheckout(
      { id: USER.id, email: USER.email },
      { plan: "pro", term: "annual" },
      { paymentPlanId: 8000, grantedDays: 365, bonusDays: 0 },
    ),
    (e: any) => e.code === "PLAN_NOT_AVAILABLE",
  );
  assert.equal(db.rows("payments").length, 0);
  assert.equal(flutterwaveRequests.length, 0);
});
