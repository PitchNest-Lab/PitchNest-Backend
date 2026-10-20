import "./testEnv.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Request, Response as ExpressResponse } from "express";
import { config, resolvePlanPrice } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { checkoutPrice, convertFromUsd, priceListIn } from "../services/localPriceService.ts";
import { getPlan, getPrice, handleWebhook, startCheckout } from "../controllers/billingController.ts";

// ── Rounding ─────────────────────────────────────────────────────────────────
assert.equal(convertFromUsd(15, 1450, "NGN"), 21_800, "rounded up to the next ₦100");
assert.equal(convertFromUsd(150, 1450, "NGN"), 217_500, "an exact figure gains no extra step");
assert.equal(convertFromUsd(9.99, 1450, "NGN"), 14_500);
assert.equal(convertFromUsd(15, 129.4, "KES"), 1_950, "shillings round to 10");
assert.equal(convertFromUsd(15, 11.2, "GHS"), 168, "cedis round to 1");
assert.equal(convertFromUsd(99.9, 17.43, "ZAR"), 1_742, "rand round to 1");

// ── Fake database ────────────────────────────────────────────────────────────
type Row = Record<string, any>;
const db: Record<string, Row[]> = {
  billing_fx_rates: [],
  users: [
    { id: 10, email: "lagos@example.com", name: "Lagos Founder", plan: "free", plan_expires_at: null },
    { id: 11, email: "abuja@example.com", name: "Abuja Founder", plan: "free", plan_expires_at: null },
    { id: 12, email: "accra@example.com", name: "Accra Founder", plan: "free", plan_expires_at: null },
    { id: 13, email: "dollars@example.com", name: "Dollar Founder", plan: "free", plan_expires_at: null },
  ],
  payments: [],
  billing_provider_plans: [],
  subscriptions: [],
};
const tablesRead: string[] = [];
let rateTableError: { code: string; message: string } | null = null;
let nextPaymentId = 1;

function fakeFrom(table: string) {
  tablesRead.push(table);
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  let headCount = false;
  const rows = () => (db[table] ?? []).filter((row) => filters.every((f) => f(row)));
  const query: any = {
    select: (_columns?: string, options?: { head?: boolean }) => { if (options?.head) headCount = true; return query; },
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
    in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
    order: () => query,
    limit: () => query,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (input: Row | Row[]) => {
      for (const row of Array.isArray(input) ? input : [input]) {
        db[table].push(table === "payments" ? { id: nextPaymentId++, status: "pending", ...row } : { ...row });
      }
      return { error: null };
    },
    upsert: async (row: Row, options: { onConflict: string }) => {
      const existing = db[table].find((r) => r[options.onConflict] === row[options.onConflict]);
      if (existing) Object.assign(existing, row);
      else db[table].push({ ...row });
      return { error: null };
    },
    update: (values: Row) => { patch = values; return query; },
    then: (resolve: (value: any) => void) => {
      if (table === "billing_fx_rates" && rateTableError) return resolve({ data: null, error: rateTableError });
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
  const payment = db.payments.find((p) => p.tx_ref === args.p_tx_ref);
  if (name === "grant_pro_access") {
    if (!payment) return { data: null, error: { message: "UNKNOWN_TX_REF" } };
    if (payment.status === "successful") return { data: false, error: null };
    if (args.p_amount < payment.amount || args.p_currency !== payment.currency) {
      return { data: null, error: { message: "PAYMENT_AMOUNT_MISMATCH" } };
    }
    Object.assign(payment, { status: "successful", provider_ref: args.p_provider_ref, amount: args.p_amount });
    const user = db.users.find((u) => u.id === payment.user_id)!;
    user.plan = payment.plan;
    user.plan_expires_at = new Date(Date.now() + payment.granted_days * 86_400_000).toISOString();
    return { data: true, error: null };
  }
  if (name === "start_subscription_from_payment") {
    if (!payment || payment.status !== "successful") return { data: null, error: null };
    const plan = db.billing_provider_plans.find((p) => p.provider_plan_id === payment.provider_plan_id)!;
    const id = `sub-${payment.user_id}`;
    db.subscriptions.push({
      id, user_id: payment.user_id, plan: payment.plan, term: payment.term, amount: plan.amount,
      currency: payment.currency, provider_plan_id: payment.provider_plan_id, status: "active",
      provider_cancel_pending: false, customer_email: args.p_customer_email,
    });
    payment.subscription_id = id;
    return { data: id, error: null };
  }
  throw new Error(`unexpected rpc ${name}`);
}

// ── Fake Flutterwave ─────────────────────────────────────────────────────────
// Units of each currency per dollar, as Flutterwave would quote them.
const quotes: Record<string, number> = { NGN: 1450, KES: 129.4, GHS: 11.2, ZAR: 17.43 };
const rateCalls: string[] = [];
let ratesDown = false;
type Call = { method: string; path: string; body: any };
const calls: Call[] = [];
let nextProviderPlanId = 8000;
const transactions = new Map<number, Row>();
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  const path = url.pathname.replace(/^\/v3/, "");
  const body = init.body ? JSON.parse(String(init.body)) : null;

  if (method === "GET" && path === "/transfers/rates") {
    const source = url.searchParams.get("source_currency")!;
    rateCalls.push(source);
    if (ratesDown) return json({ status: "error", message: "Could not fetch rates", data: null }, 503);
    const amount = Number(url.searchParams.get("amount"));
    return json({
      status: "success",
      message: "Transfer rates fetched",
      data: {
        rate: 1 / quotes[source],
        source: { currency: source, amount: amount * quotes[source] },
        destination: { currency: url.searchParams.get("destination_currency"), amount },
      },
    });
  }
  calls.push({ method, path, body });
  if (method === "POST" && path === "/payment-plans") {
    return json({ status: "success", data: { id: nextProviderPlanId++, ...body } });
  }
  if (method === "POST" && path === "/payments") {
    return json({ status: "success", data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/${body.tx_ref}` } });
  }
  const verify = path.match(/^\/transactions\/(\d+)\/verify$/);
  if (method === "GET" && verify) {
    const tx = transactions.get(Number(verify[1]));
    return tx ? json({ status: "success", data: tx }) : json({ status: "error", message: "not found" }, 404);
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
  checkoutEnabled: mutableConfig.billingCheckoutEnabled,
  purchasableSkus: mutableConfig.purchasableSkus,
  localCurrencies: mutableConfig.billingLocalCurrencies,
  baseCurrency: mutableConfig.proPlanCurrency,
  nodeEnv: mutableConfig.nodeEnv,
};
mutableSupabase.from = fakeFrom;
mutableSupabase.rpc = fakeRpc;
globalThis.fetch = fakeFetch as typeof fetch;
mutableConfig.flutterwaveSecretKey = "FLWSECK_TEST-fake";
mutableConfig.flutterwaveWebhookHash = "test-webhook-hash";
mutableConfig.billingCheckoutEnabled = true;
mutableConfig.purchasableSkus = ["prep:monthly", "prep:annual", "pro:monthly", "pro:annual"];
mutableConfig.proPlanCurrency = "USD";
mutableConfig.nodeEnv = "test";

function recorder() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(field: string, value: string) { this.headers[field] = value; return this; },
    json(body: any) { this.body = body; return this; },
  };
  return res as ExpressResponse & { statusCode: number; body: any };
}
const asUser = (id: number, body: Row = {}) => ({ user: { id }, body } as unknown as Request);
const withQuery = (query: Row) => ({ query } as unknown as Request);
const webhook = (payload: Row) =>
  ({ headers: { "verif-hash": "test-webhook-hash" }, body: Buffer.from(JSON.stringify(payload)) } as unknown as Request);
const rateRow = (currency: string) => db.billing_fx_rates.find((row) => row.currency === currency)!;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-20T12:00:00Z");

try {
  const proMonthly = resolvePlanPrice("pro", "monthly");
  const pro = (list: { catalog: any[] }) => list.catalog.find((item) => item.plan === "pro" && item.term === "monthly");

  // ── Dollars only until local currencies are switched on ───────────────────
  mutableConfig.billingLocalCurrencies = [];
  let list = await priceListIn("NGN", T0);
  assert.equal(list.currency, "USD");
  assert.deepEqual(list.currencies, ["USD"]);
  assert.equal(pro(list).amount, proMonthly.amount);
  assert.equal(await checkoutPrice("pro", "monthly", "NGN", T0), null);
  assert.equal(tablesRead.length + rateCalls.length, 0, "no database or Flutterwave call at all");

  // ── First request: rates fetched from Flutterwave and stored ──────────────
  mutableConfig.billingLocalCurrencies = ["NGN", "KES", "GHS", "ZAR", "EUR"];
  list = await priceListIn("ngn", T0);
  assert.equal(list.currency, "NGN");
  assert.deepEqual(list.currencies, ["USD", "NGN", "KES", "GHS", "ZAR"], "EUR has no rounding rule and is ignored");
  assert.deepEqual(
    { amount: pro(list).amount, currency: pro(list).currency, baseAmount: pro(list).baseAmount, baseCurrency: pro(list).baseCurrency },
    { amount: convertFromUsd(proMonthly.amount, 1450, "NGN"), currency: "NGN", baseAmount: proMonthly.amount, baseCurrency: "USD" },
  );
  assert.ok(list.catalog.every((item) => item.currency === "NGN" && item.purchasable === true));
  assert.deepEqual([...rateCalls].sort(), ["GHS", "KES", "NGN", "ZAR"]);
  assert.equal(rateRow("NGN").usd_rate, 1450);
  assert.equal(rateRow("KES").usd_rate, 129.4);

  // Within the day, the stored rate is used as it is.
  rateCalls.length = 0;
  list = await priceListIn("KES", T0 + 6 * HOUR);
  assert.equal(pro(list).amount, convertFromUsd(proMonthly.amount, 129.4, "KES"));
  assert.equal(rateCalls.length, 0, "a rate checked today is not asked for again");

  // ── A day later: small moves keep the price, big moves change it ──────────
  quotes.NGN = 1470; // +1.4%
  list = await priceListIn("NGN", T0 + 25 * HOUR);
  assert.equal(rateCalls.length, 4, "every day-old rate is re-checked");
  assert.equal(rateRow("NGN").usd_rate, 1450, "a move under 2% keeps the rate");
  assert.equal(rateRow("NGN").checked_at, new Date(T0 + 25 * HOUR).toISOString(), "and records the check");
  assert.equal(rateRow("NGN").updated_at, new Date(T0).toISOString());
  assert.equal(pro(list).amount, convertFromUsd(proMonthly.amount, 1450, "NGN"));

  quotes.NGN = 1500; // +3.4%
  const T2 = T0 + 50 * HOUR;
  list = await priceListIn("NGN", T2);
  assert.equal(rateRow("NGN").usd_rate, 1500, "a move of 2% or more replaces the rate");
  assert.equal(rateRow("NGN").updated_at, new Date(T2).toISOString());
  const proNaira = convertFromUsd(proMonthly.amount, 1500, "NGN");
  assert.equal(pro(list).amount, proNaira);
  assert.deepEqual(
    await checkoutPrice("pro", "monthly", "NGN", T2 + HOUR),
    { ...proMonthly, amount: proNaira, currency: "NGN" },
    "checkout charges what the price list shows",
  );

  // ── Flutterwave down: a recent rate still prices, an old one stops ────────
  ratesDown = true;
  rateCalls.length = 0;
  const T3 = T2 + 3 * DAY;
  list = await priceListIn("NGN", T3);
  assert.equal(list.currency, "NGN", "a rate a few days old prices while Flutterwave is down");
  assert.equal(rateCalls.length, 4);
  await priceListIn("NGN", T3 + 5 * 60_000);
  assert.equal(rateCalls.length, 4, "and Flutterwave is not asked again straight away");

  const T8 = T2 + 8 * DAY;
  list = await priceListIn("NGN", T8);
  assert.equal(list.currency, "USD", "a rate over 7 days old is never priced from");
  assert.deepEqual(list.currencies, ["USD"]);
  assert.equal(pro(list).amount, proMonthly.amount);
  assert.equal(await checkoutPrice("pro", "monthly", "NGN", T8), null);

  // ── A nonsense quote is refused; the rest recover ─────────────────────────
  ratesDown = false;
  quotes.GHS = 0.0893; // the inverse of a real rate
  list = await priceListIn("GHS", T8 + HOUR);
  assert.equal(list.currency, "USD", "an implausible quote is never priced from");
  assert.deepEqual(list.currencies, ["USD", "NGN", "KES", "ZAR"]);
  assert.equal(rateRow("GHS").usd_rate, 11.2, "nor stored");

  // ── Before migration 0035: dollars, no error ──────────────────────────────
  rateTableError = { code: "PGRST205", message: "Could not find the table 'public.billing_fx_rates'" };
  list = await priceListIn("NGN", T8 + 2 * HOUR);
  assert.equal(list.currency, "USD");
  assert.deepEqual(list.currencies, ["USD"]);
  rateTableError = null;

  // ── The public price endpoint ─────────────────────────────────────────────
  // Rates checked just now, so these requests (on the real clock) use them as they are.
  const nowIso = new Date().toISOString();
  db.billing_fx_rates = [
    { currency: "NGN", usd_rate: 1500, source: "flutterwave", checked_at: nowIso, updated_at: nowIso },
    { currency: "KES", usd_rate: 129.4, source: "flutterwave", checked_at: nowIso, updated_at: nowIso },
  ];
  mutableConfig.billingLocalCurrencies = ["NGN", "KES"];
  let res = recorder();
  await getPrice(withQuery({ currency: "NGN" }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.currency, "NGN");
  assert.deepEqual(res.body.currencies, ["USD", "NGN", "KES"]);
  assert.deepEqual(res.body.price, { amount: proNaira, currency: "NGN", days: proMonthly.days });
  assert.equal(pro(res.body).baseAmount, proMonthly.amount);
  res = recorder();
  await getPrice(withQuery({}), res);
  assert.equal(res.body.currency, "USD");
  assert.deepEqual(res.body.price, { amount: proMonthly.amount, currency: "USD", days: proMonthly.days });
  assert.equal("baseAmount" in pro(res.body), false, "dollar prices are listed exactly as before");
  res = recorder();
  await getPrice(withQuery({ currency: "GHS" }), res);
  assert.equal(res.body.currency, "USD", "a currency not on offer falls back to dollars");

  // The signed-in plan view prices the same way, and still says checkout is on.
  res = recorder();
  await getPlan({ user: { id: 12 }, body: {}, query: { currency: "NGN" } } as unknown as Request, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.billingEnabled, true);
  assert.equal(res.body.currency, "NGN");
  assert.deepEqual(res.body.price, { amount: proNaira, currency: "NGN", days: proMonthly.days });
  assert.ok(res.body.catalog.every((item: any) => item.purchasable === true));

  // ── Checkout in naira ─────────────────────────────────────────────────────
  calls.length = 0;
  res = recorder();
  await startCheckout(asUser(10, { plan: "pro", term: "monthly", currency: "ngn" }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const nairaPlan = calls.find((c) => c.path === "/payment-plans")!;
  assert.deepEqual(
    { name: nairaPlan.body.name, amount: nairaPlan.body.amount, currency: nairaPlan.body.currency, interval: nairaPlan.body.interval },
    { name: "PitchNest Pro Founder (monthly, NGN)", amount: proNaira, currency: "NGN", interval: "monthly" },
  );
  const nairaCheckout = calls.find((c) => c.path === "/payments")!;
  assert.deepEqual(
    { amount: nairaCheckout.body.amount, currency: nairaCheckout.body.currency, plan: nairaCheckout.body.payment_plan },
    { amount: proNaira, currency: "NGN", plan: 8000 },
    "the first charge and the renewals are the same naira amount",
  );
  const nairaPayment = db.payments.find((p) => p.user_id === 10)!;
  assert.deepEqual({ amount: nairaPayment.amount, currency: nairaPayment.currency }, { amount: proNaira, currency: "NGN" });

  calls.length = 0;
  res = recorder();
  await startCheckout(asUser(11, { plan: "pro", term: "monthly", currency: "NGN" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.filter((c) => c.path === "/payment-plans").length, 0, "the naira plan is reused");

  res = recorder();
  await startCheckout(asUser(13, { plan: "pro", term: "monthly" }), res);
  assert.equal(res.statusCode, 200);
  const dollarPlan = calls.find((c) => c.path === "/payment-plans")!;
  assert.deepEqual(
    { name: dollarPlan.body.name, amount: dollarPlan.body.amount, currency: dollarPlan.body.currency },
    { name: "PitchNest Pro Founder (monthly)", amount: proMonthly.amount, currency: "USD" },
    "no currency means dollars, on a plan of its own",
  );

  calls.length = 0;
  const paymentsBefore = db.payments.length;
  res = recorder();
  await startCheckout(asUser(12, { plan: "pro", term: "monthly", currency: "GHS" }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "currency_unavailable");
  for (const currency of [5, "naira", ""]) {
    res = recorder();
    await startCheckout(asUser(12, { plan: "pro", term: "monthly", currency }), res);
    assert.equal(res.statusCode, 400, `currency ${JSON.stringify(currency)} is refused`);
  }
  assert.equal(db.payments.length, paymentsBefore, "refused currencies record nothing");
  assert.equal(calls.length, 0, "and never reach Flutterwave");

  // ── Settling a naira payment ──────────────────────────────────────────────
  transactions.set(91, {
    id: 91, tx_ref: nairaPayment.tx_ref, amount: proNaira, currency: "NGN",
    status: "successful", payment_type: "card", customer: { email: "lagos@example.com" },
  });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 91 } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(nairaPayment.status, "successful");
  assert.equal(db.users.find((u) => u.id === 10)!.plan, "pro");
  const nairaSubscription = db.subscriptions.find((s) => s.user_id === 10)!;
  assert.deepEqual(
    { amount: nairaSubscription.amount, currency: nairaSubscription.currency },
    { amount: proNaira, currency: "NGN" },
    "renewals are checked against the naira amount",
  );

  const secondNaira = db.payments.find((p) => p.user_id === 11)!;
  transactions.set(92, {
    id: 92, tx_ref: secondNaira.tx_ref, amount: proMonthly.amount, currency: "USD",
    status: "successful", payment_type: "card", customer: { email: "abuja@example.com" },
  });
  res = recorder();
  await handleWebhook(webhook({ event: "charge.completed", data: { id: 92 } }), res);
  assert.equal(res.body.rejected, true, "dollars paid against a naira checkout grant nothing");
  assert.equal(db.users.find((u) => u.id === 11)!.plan, "free");

  // ── Migration ─────────────────────────────────────────────────────────────
  const migration = readFileSync(new URL("../../migrations/0035_billing_fx_rates.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS billing_fx_rates/);
  assert.match(migration, /usd_rate NUMERIC\(18, 6\) NOT NULL CHECK \(usd_rate > 0\)/);
  assert.match(migration, /ALTER TABLE billing_fx_rates ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FOR ALL TO anon, authenticated USING \(false\) WITH CHECK \(false\)/);
  assert.match(migration, /VALUES \('0035'/);

  console.log("Local price tests passed.");
} finally {
  mutableSupabase.from = originalFrom;
  mutableSupabase.rpc = originalRpc;
  globalThis.fetch = originalFetch;
  mutableConfig.flutterwaveSecretKey = originalConfig.key;
  mutableConfig.flutterwaveWebhookHash = originalConfig.hash;
  mutableConfig.billingCheckoutEnabled = originalConfig.checkoutEnabled;
  mutableConfig.purchasableSkus = originalConfig.purchasableSkus;
  mutableConfig.billingLocalCurrencies = originalConfig.localCurrencies;
  mutableConfig.proPlanCurrency = originalConfig.baseCurrency;
  mutableConfig.nodeEnv = originalConfig.nodeEnv;
}
