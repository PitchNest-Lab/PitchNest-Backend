import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request, Response as ExpressResponse } from "express";
import { config, resolvePlanPrice } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  addMonthsUtc,
  initialGrantDays,
  nextChargeDate,
  renewalGrantDays,
  RENEWAL_GRACE_DAYS,
  stopRenewalsForDeletion,
} from "../services/subscriptionService.ts";
import {
  cancelSubscription,
  getPlan,
  handleWebhook,
  startCheckout,
} from "../controllers/billingController.ts";

// ── Calendar maths ───────────────────────────────────────────────────────────
const d = (iso: string) => new Date(iso);
assert.equal(addMonthsUtc(d("2026-01-31T10:00:00Z"), 1).toISOString(), "2026-02-28T10:00:00.000Z", "month end clamps");
assert.equal(addMonthsUtc(d("2026-10-16T00:00:00Z"), 12).toISOString(), "2027-10-16T00:00:00.000Z");
assert.equal(initialGrantDays("monthly", 0, d("2026-10-16T00:00:00Z")), 31 + RENEWAL_GRACE_DAYS);
assert.equal(initialGrantDays("monthly", 1, d("2026-10-16T00:00:00Z")), 31 + 30 + RENEWAL_GRACE_DAYS, "first month free adds November");
assert.equal(initialGrantDays("annual", 1, d("2026-10-16T00:00:00Z")), 365 + 31 + RENEWAL_GRACE_DAYS);
assert.equal(
  renewalGrantDays("monthly", d("2026-12-18T00:00:00Z"), d("2026-11-16T00:00:00Z")),
  31,
  "a renewal adds one calendar month to the current expiry",
);
assert.equal(renewalGrantDays("monthly", d("2026-01-01T00:00:00Z"), d("2026-02-10T00:00:00Z")), 28, "lapsed: from now");
assert.equal(
  nextChargeDate(d("2026-10-16T00:00:00Z"), "monthly", d("2026-11-20T00:00:00Z")).toISOString(),
  "2026-12-16T00:00:00.000Z",
);

// ── Fake database ────────────────────────────────────────────────────────────
type Row = Record<string, any>;
const NOW = Date.now();
const future = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const db: Record<string, Row[]> = {
  users: [
    { id: 10, email: "new@example.com", name: "New Founder", plan: "free", plan_expires_at: null },
    { id: 11, email: "paid-before@example.com", name: "Returning", plan: "free", plan_expires_at: null },
    { id: 12, email: "subscribed@example.com", name: "Subscribed", plan: "pro", plan_expires_at: future(20) },
    { id: 13, email: "pro-annual@example.com", name: "Pro Annual", plan: "pro", plan_expires_at: future(200) },
    { id: 14, email: "deleting@example.com", name: "Leaving", plan: "pro", plan_expires_at: future(10) },
  ],
  payments: [
    { id: 1, user_id: 11, tx_ref: "pn-11-1700000000000-aaaaaaaaaaaaaaaa", provider: "flutterwave", status: "successful", provider_ref: "500", amount: 15, currency: "USD", plan: "pro", term: "monthly", granted_days: 30, kind: "one_time", bonus_days: 0 },
  ],
  billing_provider_plans: [],
  subscriptions: [
    { id: "sub-12", user_id: 12, plan: "pro", term: "monthly", amount: 15, currency: "USD", provider_plan_id: 7001, provider_subscription_id: null, customer_email: "subscribed@example.com", status: "active", provider_cancel_pending: false, cancelled_at: null, created_at: "2026-09-16T00:00:00.000Z", initial_tx_ref: "pn-12-x" },
    { id: "sub-14", user_id: 14, plan: "pro", term: "monthly", amount: 15, currency: "USD", provider_plan_id: 7001, provider_subscription_id: 9014, customer_email: "deleting@example.com", status: "active", provider_cancel_pending: false, cancelled_at: null, created_at: "2026-09-16T00:00:00.000Z", initial_tx_ref: "pn-14-x" },
  ],
};
let nextPaymentId = 100;
let nextSubscriptionId = 1;

function fakeFrom(table: string) {
  let filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  let headCount = false;
  let orderColumn: string | null = null;
  let orderAscending = true;
  let limit = Infinity;
  const rows = () => {
    let result = (db[table] ?? []).filter((row) => filters.every((f) => f(row)));
    if (orderColumn) {
      const column = orderColumn;
      result = [...result].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (orderAscending ? 1 : -1));
    }
    return result.slice(0, limit);
  };
  const query: any = {
    select: (_columns?: string, options?: { head?: boolean }) => { if (options?.head) headCount = true; return query; },
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
    order: (column: string, options?: { ascending?: boolean }) => { orderColumn = column; orderAscending = options?.ascending !== false; return query; },
    limit: (n: number) => { limit = n; return query; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (input: Row | Row[]) => {
      const list = Array.isArray(input) ? input : [input];
      for (const row of list) {
        if (table === "payments" && db.payments.some((p) => p.tx_ref === row.tx_ref)) {
          return { error: { code: "23505", message: "duplicate tx_ref" } };
        }
        if (
          table === "billing_provider_plans" &&
          db.billing_provider_plans.some((p) => ["plan", "term", "amount", "currency"].every((k) => p[k] === row[k]))
        ) {
          return { error: { code: "23505", message: "duplicate sku" } };
        }
        db[table].push(table === "payments" ? { id: nextPaymentId++, status: "pending", ...row } : { ...row });
      }
      return { error: null };
    },
    update: (values: Row) => { patch = values; return query; },
    then: (resolve: (value: any) => void) => {
      const matched = rows();
      if (patch) {
        for (const row of matched) Object.assign(row, patch);
        return resolve({ data: null, error: null });
      }
      return resolve(headCount ? { count: matched.length, data: null, error: null } : { data: matched, error: null });
    },
  };
  return query;
}

async function fakeRpc(name: string, args: Row) {
  if (name === "grant_pro_access") {
    const payment = db.payments.find((p) => p.tx_ref === args.p_tx_ref);
    if (!payment) return { data: null, error: { message: "UNKNOWN_TX_REF" } };
    if (payment.status === "successful") return { data: false, error: null };
    if (args.p_amount < payment.amount || args.p_currency !== payment.currency) {
      return { data: null, error: { message: "PAYMENT_AMOUNT_MISMATCH" } };
    }
    Object.assign(payment, { status: "successful", provider_ref: args.p_provider_ref, amount: args.p_amount });
    const user = db.users.find((u) => u.id === payment.user_id)!;
    const base = user.plan_expires_at && new Date(user.plan_expires_at).getTime() > Date.now()
      ? new Date(user.plan_expires_at).getTime()
      : Date.now();
    user.plan = payment.plan;
    user.plan_expires_at = new Date(base + payment.granted_days * 86_400_000).toISOString();
    return { data: true, error: null };
  }
  if (name === "start_subscription_from_payment") {
    const payment = db.payments.find((p) => p.tx_ref === args.p_tx_ref);
    if (!payment || payment.status !== "successful" || payment.kind !== "subscription_initial") return { data: null, error: null };
    if (payment.subscription_id) return { data: payment.subscription_id, error: null };
    const plan = db.billing_provider_plans.find((p) => p.provider_plan_id === payment.provider_plan_id)!;
    for (const sub of db.subscriptions) {
      if (sub.user_id === payment.user_id && sub.status === "active") {
        Object.assign(sub, { status: "cancelled", cancelled_at: new Date().toISOString(), provider_cancel_pending: true });
      }
    }
    const id = `sub-new-${nextSubscriptionId++}`;
    db.subscriptions.push({
      id, user_id: payment.user_id, plan: payment.plan, term: payment.term, amount: plan.amount, currency: payment.currency,
      provider_plan_id: payment.provider_plan_id, provider_subscription_id: null,
      customer_email: String(args.p_customer_email).toLowerCase(), status: "active", provider_cancel_pending: false,
      cancelled_at: null, created_at: new Date().toISOString(), initial_tx_ref: payment.tx_ref,
    });
    payment.subscription_id = id;
    return { data: id, error: null };
  }
  throw new Error(`unexpected rpc ${name}`);
}

// ── Fake Flutterwave ─────────────────────────────────────────────────────────
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let nextProviderPlanId = 8000;
const transactions = new Map<number, Row>();
// Subscriptions Flutterwave holds, by email.
const providerSubscriptions: Array<{ id: number; plan: number; status: string; email: string }> = [
  { id: 9012, plan: 7001, status: "active", email: "subscribed@example.com" },
  { id: 9014, plan: 7001, status: "active", email: "deleting@example.com" },
];
let providerDown = false;

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/v3/, "");
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, path: path + url.search, body });
  if (providerDown) return json({ status: "error", message: "unavailable" }, 503);

  if (method === "POST" && path === "/payment-plans") {
    return json({ status: "success", data: { id: nextProviderPlanId++, ...body, status: "active" } });
  }
  if (method === "POST" && path === "/payments") {
    return json({ status: "success", data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/${body.tx_ref}` } });
  }
  const verify = path.match(/^\/transactions\/(\d+)\/verify$/);
  if (method === "GET" && verify) {
    const tx = transactions.get(Number(verify[1]));
    return tx ? json({ status: "success", data: tx }) : json({ status: "error", message: "not found" }, 404);
  }
  if (method === "GET" && path === "/subscriptions") {
    const email = url.searchParams.get("email");
    const plan = Number(url.searchParams.get("plan"));
    return json({
      status: "success",
      data: providerSubscriptions
        .filter((s) => s.email === email && (!plan || s.plan === plan))
        .map((s) => ({ id: s.id, plan: s.plan, status: s.status, customer: { customer_email: s.email } })),
    });
  }
  const cancel = path.match(/^\/subscriptions\/(\d+)\/cancel$/);
  if (method === "PUT" && cancel) {
    const sub = providerSubscriptions.find((s) => s.id === Number(cancel[1]));
    if (sub) sub.status = "cancelled";
    return json({ status: "success", data: { id: Number(cancel[1]), status: "cancelled" } });
  }
  return json({ status: "error", message: `unhandled ${method} ${path}` }, 404);
}

const mutableSupabase = supabase as any;
const originalFrom = mutableSupabase.from;
const originalRpc = mutableSupabase.rpc;
const originalFetch = globalThis.fetch;
const mutableConfig = config as any;
const originalConfig = {
  key: mutableConfig.flutterwaveSecretKey,
  hash: mutableConfig.flutterwaveWebhookHash,
  nodeEnv: mutableConfig.nodeEnv,
};
mutableSupabase.from = fakeFrom;
mutableSupabase.rpc = fakeRpc;
globalThis.fetch = fakeFetch as typeof fetch;
mutableConfig.flutterwaveSecretKey = "FLWSECK_TEST-fake";
mutableConfig.flutterwaveWebhookHash = "test-webhook-hash";
mutableConfig.nodeEnv = "test";

function recorder() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(field: string, value: string) { this.headers[field] = value; return this; },
    set(field: string, value: string) { this.headers[field] = value; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return res as ExpressResponse & { statusCode: number; body: any };
}
const asUser = (id: number, body: Row = {}) => ({ user: { id }, body } as unknown as Request);
const webhook = (payload: Row) =>
  ({ headers: { "verif-hash": "test-webhook-hash" }, body: Buffer.from(JSON.stringify(payload)) } as unknown as Request);

try {
  const proMonthly = resolvePlanPrice("pro", "monthly");

  // ── Checkout: first subscription gets the free month ──────────────────────
  let res = recorder();
  await startCheckout(asUser(10, { plan: "pro", term: "monthly" }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const planCall = calls.find((c) => c.method === "POST" && c.path === "/payment-plans");
  assert.ok(planCall, "a Flutterwave payment plan is created on first use");
  assert.deepEqual(
    { interval: planCall.body.interval, amount: planCall.body.amount, currency: planCall.body.currency },
    { interval: "monthly", amount: proMonthly.amount, currency: proMonthly.currency },
  );
  const checkoutCall = calls.find((c) => c.method === "POST" && c.path === "/payments")!;
  assert.equal(checkoutCall.body.payment_plan, 8000, "checkout subscribes the card to the plan");
  assert.equal(checkoutCall.body.amount, proMonthly.amount, "the first charge is the normal price");
  const firstPayment = db.payments.find((p) => p.user_id === 10)!;
  assert.equal(firstPayment.kind, "subscription_initial");
  assert.equal(firstPayment.provider_plan_id, 8000);
  assert.ok(firstPayment.bonus_days >= 28 && firstPayment.bonus_days <= 31, "about one month free");
  assert.equal(firstPayment.granted_days, initialGrantDays("monthly", 0) + firstPayment.bonus_days);

  // The plan is cached: a second checkout of the same SKU makes no new plan.
  calls.length = 0;
  res = recorder();
  await startCheckout(asUser(11, { plan: "pro", term: "monthly" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => c.path === "/payment-plans").length, 0);
  const returningPayment = db.payments.filter((p) => p.user_id === 11).at(-1)!;
  assert.equal(returningPayment.bonus_days, 0, "someone who has paid before gets no free month");
  assert.equal(returningPayment.granted_days, initialGrantDays("monthly", 0));

  res = recorder();
  await startCheckout(asUser(12, { plan: "pro", term: "monthly" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "already_subscribed");

  res = recorder();
  await startCheckout(asUser(13, { plan: "prep", term: "monthly" }), res);
  assert.equal(res.statusCode, 409, "no moving down while a higher plan is paid up");
  assert.equal(res.body.error, "downgrade_unavailable");

  // ── Webhook: the first charge settles and starts the subscription ─────────
  transactions.set(61, {
    id: 61, tx_ref: firstPayment.tx_ref, amount: proMonthly.amount, currency: proMonthly.currency,
    status: "successful", payment_type: "card", customer: { email: "NEW@example.com" },
  });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 61, tx_ref: firstPayment.tx_ref } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(firstPayment.status, "successful");
  const sub10 = db.subscriptions.find((s) => s.user_id === 10 && s.status === "active")!;
  assert.ok(sub10, "the subscription is recorded");
  assert.equal(sub10.customer_email, "new@example.com");
  assert.equal(sub10.amount, proMonthly.amount);
  const expiryAfterFirst = db.users.find((u) => u.id === 10)!.plan_expires_at;

  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 61 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.subscriptions.filter((s) => s.user_id === 10).length, 1, "a replay starts nothing new");
  assert.equal(db.users.find((u) => u.id === 10)!.plan_expires_at, expiryAfterFirst, "and grants nothing");

  // ── Renewal: a charge Flutterwave raised itself ───────────────────────────
  providerSubscriptions.push({ id: 9010, plan: 8000, status: "active", email: "new@example.com" });
  transactions.set(62, {
    id: 62, tx_ref: "rpp_renewal_abc", amount: proMonthly.amount, currency: proMonthly.currency,
    status: "successful", payment_type: "card", customer: { email: "new@example.com" },
  });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 62 } }), res);
  assert.equal(res.body.outcome, "granted");
  const renewal = db.payments.find((p) => p.tx_ref === "pn-renew-62")!;
  assert.equal(renewal.kind, "subscription_renewal");
  assert.equal(renewal.subscription_id, sub10.id);
  const expiryAfterRenewal = new Date(db.users.find((u) => u.id === 10)!.plan_expires_at).getTime();
  assert.equal(
    Math.round((expiryAfterRenewal - new Date(expiryAfterFirst).getTime()) / 86_400_000),
    renewal.granted_days,
    "a renewal extends from the current expiry",
  );
  assert.equal(sub10.provider_subscription_id, 9010, "the provider id is learned for cancelling");

  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 62 } }), res);
  assert.equal(res.body.outcome, "replay");

  // A charge on the original checkout reference with a new transaction id is
  // also a renewal, whatever reference format Flutterwave uses for renewals.
  transactions.set(63, { ...transactions.get(61)!, id: 63 });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 63 } }), res);
  assert.equal(res.body.outcome, "granted");

  transactions.set(64, { ...transactions.get(62)!, id: 64, amount: proMonthly.amount - 1 });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 64 } }), res);
  assert.equal(res.body.outcome, "ignored", "a short renewal grants nothing");

  transactions.set(65, { ...transactions.get(62)!, id: 65, customer: { email: "stranger@example.com" } });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 65 } }), res);
  assert.equal(res.body.outcome, "ignored", "an unknown payer grants nothing");

  transactions.set(66, { ...transactions.get(62)!, id: 66, plan: 1234 });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 66 } }), res);
  assert.equal(res.body.outcome, "ignored", "a charge for another plan grants nothing");

  // ── Plan view and offer ───────────────────────────────────────────────────
  res = recorder();
  await getPlan(asUser(10), res);
  assert.equal(res.body.plan, "pro");
  assert.equal(res.body.subscription.autoRenew, true);
  assert.equal(res.body.subscription.term, "monthly");
  assert.ok(res.body.subscription.nextChargeAt);
  assert.deepEqual(res.body.offer, { freeMonths: config.firstSubscriptionFreeMonths, eligible: false }, "offer used up");

  db.users.push({ id: 15, email: "fresh@example.com", name: "Fresh", plan: "free", plan_expires_at: null });
  res = recorder();
  await getPlan(asUser(15), res);
  assert.deepEqual(res.body.offer, { freeMonths: config.firstSubscriptionFreeMonths, eligible: true });
  assert.equal(res.body.subscription, null);

  // ── Switching term retires the old subscription at Flutterwave ────────────
  res = recorder();
  await startCheckout(asUser(10, { plan: "pro", term: "annual" }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const annualPayment = db.payments.filter((p) => p.user_id === 10 && p.kind === "subscription_initial").at(-1)!;
  assert.equal(annualPayment.term, "annual");
  assert.equal(annualPayment.bonus_days, 0);
  transactions.set(67, {
    id: 67, tx_ref: annualPayment.tx_ref, amount: annualPayment.amount, currency: annualPayment.currency,
    status: "successful", payment_type: "card", customer: { email: "new@example.com" },
  });
  calls.length = 0;
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 67 } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(sub10.status, "cancelled");
  assert.equal(sub10.provider_cancel_pending, false, "the old renewal is cancelled at Flutterwave");
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === "/subscriptions/9010/cancel"));
  assert.equal(db.subscriptions.filter((s) => s.user_id === 10 && s.status === "active").length, 1);

  // A provider outage leaves the flag set for the next plan read to retry.
  const annualSub = db.subscriptions.find((s) => s.user_id === 10 && s.status === "active")!;
  annualSub.status = "cancelled";
  annualSub.provider_cancel_pending = true;
  providerSubscriptions.push({ id: 9020, plan: annualSub.provider_plan_id, status: "active", email: "new@example.com" });
  providerDown = true;
  res = recorder();
  await getPlan(asUser(10), res);
  assert.equal(res.statusCode, 200, "plan reads survive a provider outage");
  assert.equal(annualSub.provider_cancel_pending, true);
  providerDown = false;
  res = recorder();
  await getPlan(asUser(10), res);
  assert.equal(annualSub.provider_cancel_pending, false);
  assert.equal(providerSubscriptions.find((s) => s.id === 9020)!.status, "cancelled");

  // ── Cancelling from the app ───────────────────────────────────────────────
  res = recorder();
  await cancelSubscription(asUser(12), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.subscription.autoRenew, false);
  assert.equal(providerSubscriptions.find((s) => s.id === 9012)!.status, "cancelled");
  assert.equal(db.subscriptions.find((s) => s.id === "sub-12")!.status, "cancelled");
  assert.equal(db.users.find((u) => u.id === 12)!.plan_expires_at, future(20), "paid time is kept");

  res = recorder();
  await cancelSubscription(asUser(12), res);
  assert.equal(res.statusCode, 404);

  // ── Flutterwave's own cancellation event ──────────────────────────────────
  db.subscriptions.push({ id: "sub-16", user_id: 16, plan: "prep", term: "monthly", amount: 9.99, currency: "USD", provider_plan_id: 7002, provider_subscription_id: 9016, customer_email: "lapsed@example.com", status: "active", provider_cancel_pending: false, cancelled_at: null, created_at: "2026-08-01T00:00:00.000Z", initial_tx_ref: "pn-16-x" });
  providerSubscriptions.push({ id: 9016, plan: 7002, status: "active", email: "lapsed@example.com" });
  const cancelEvent = { event: "subscription.cancelled", data: { status: "deactivated", customer: { email: "lapsed@example.com" }, plan: { id: 7002, interval: "monthly" } } };
  res = recorder();
  await handleWebhook(webhook(cancelEvent), res);
  assert.equal(res.body.outcome, "ignored", "a forged event is checked against Flutterwave first");
  assert.equal(db.subscriptions.find((s) => s.id === "sub-16")!.status, "active");
  providerSubscriptions.find((s) => s.id === 9016)!.status = "cancelled";
  res = recorder();
  await handleWebhook(webhook(cancelEvent), res);
  assert.equal(res.body.outcome, "cancelled");
  assert.equal(db.subscriptions.find((s) => s.id === "sub-16")!.status, "cancelled");

  // ── Account deletion stops renewals first ─────────────────────────────────
  providerDown = true;
  await assert.rejects(stopRenewalsForDeletion(14), /ACCOUNT_DELETE_SUBSCRIPTION_CANCEL_FAILED/);
  providerDown = false;
  await stopRenewalsForDeletion(14);
  assert.equal(providerSubscriptions.find((s) => s.id === 9014)!.status, "cancelled");

  // ── Migration ─────────────────────────────────────────────────────────────
  const migration = readFileSync(new URL("../../migrations/0031_recurring_subscriptions.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS subscriptions/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user[\s\S]*WHERE status = 'active'/);
  assert.match(migration, /provider_cancel_pending = TRUE/, "a retired subscription is flagged for a provider cancel");
  assert.match(migration, /kind IN \('one_time', 'subscription_initial', 'subscription_renewal'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION start_subscription_from_payment\(TEXT, TEXT\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /VALUES \('0031'/);
  assert.doesNotMatch(migration, /UPDATE users/, "subscriptions never grant access by themselves");

  console.log("Subscription billing tests passed.");
} finally {
  mutableSupabase.from = originalFrom;
  mutableSupabase.rpc = originalRpc;
  globalThis.fetch = originalFetch;
  mutableConfig.flutterwaveSecretKey = originalConfig.key;
  mutableConfig.flutterwaveWebhookHash = originalConfig.hash;
  mutableConfig.nodeEnv = originalConfig.nodeEnv;
}
