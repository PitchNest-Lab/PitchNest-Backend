import crypto from "crypto";
import {
  config,
  hasBillingConfig,
  isPurchasable,
  resolvePlanPrice,
  type PaidPlan,
  type BillingTerm,
} from "../config/env.ts";
import { supabase } from "../config/supabase.ts";

/**
 * Flutterwave v3 Standard (hosted checkout).
 *
 * FLOW. We create a payment server-side, redirect the user to Flutterwave's
 * hosted page, and they return to /billing/return. Card data never touches this
 * server — the hosted page is what keeps PCI scope out of the application.
 *
 * TRUST MODEL. The return redirect is NOT proof of payment: it is a browser
 * navigation the user can fabricate by typing the URL. Entitlement is granted
 * ONLY by a verified webhook, and only after re-querying Flutterwave for the
 * authoritative transaction. The return page merely refreshes and reports.
 */

const FLW_API = "https://api.flutterwave.com/v3";
const PROVIDER_TIMEOUT_MS = 15_000;

async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface CheckoutSession {
  txRef: string;
  paymentLink: string;
}

/**
 * A checkout failure with a machine-readable `code` and an operator-facing
 * `detail`. The controller maps `code` to an HTTP status and a safe client
 * `reason`; `detail` is logged server-side ONLY — it can carry a raw provider
 * message or DB error, neither of which should ever reach the browser.
 *
 * Distinguishing these is the whole point: a 502 previously collapsed "the
 * payments table isn't there" and "Flutterwave rejected our key" into one
 * opaque message, so neither could be fixed without shell access to prod.
 */
export class CheckoutError extends Error {
  constructor(
    public code:
      | "BILLING_NOT_CONFIGURED"
      | "PLAN_NOT_AVAILABLE"
      | "PAYMENT_RECORD_FAILED"
      | "CHECKOUT_INIT_FAILED",
    public detail?: string,
  ) {
    super(code);
    this.name = "CheckoutError";
  }
}

/** Our own reference. Unique per attempt, and unguessable so it cannot be forged. */
function mintTxRef(userId: number): string {
  return `pn-${userId}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

/**
 * Creates a pending payment row and returns the hosted checkout link.
 *
 * The row is written BEFORE calling Flutterwave so the webhook always has a
 * reference to resolve. Price, level and day-count are computed SERVER-SIDE from
 * the (plan, term) catalog and recorded onto the row — the webhook grants from
 * those recorded values, never from client input, so a founder receives exactly
 * the SKU that was priced here.
 *
 * The checkout subscribes the card to `paymentPlanId`, so Flutterwave renews it
 * every period until it is cancelled. `grantedDays` covers the first period
 * (plus any free months, recorded separately as `bonusDays`).
 */
export async function createCheckout(
  user: {
    id: number;
    email: string;
    name?: string | null;
  },
  selection: {
    plan: PaidPlan;
    term: BillingTerm;
  },
  subscription: {
    paymentPlanId: number;
    grantedDays: number;
    bonusDays: number;
  },
): Promise<CheckoutSession> {
  // Same gates as the controller, enforced again here so no other caller can
  // create a charge: the kill switch + keys, and the single purchasable SKU.
  if (!hasBillingConfig()) {
    throw new CheckoutError("BILLING_NOT_CONFIGURED");
  }
  if (!isPurchasable(selection.plan, selection.term)) {
    throw new CheckoutError("PLAN_NOT_AVAILABLE");
  }

  const txRef = mintTxRef(user.id);
  const price = resolvePlanPrice(selection.plan, selection.term);
  const { amount, currency } = price;

  const planLabel = selection.plan === "pro" ? "Pro Founder" : "Founder";
  const termLabel = selection.term === "annual" ? "year" : "month";

  const { error: insertErr } = await supabase.from("payments").insert([
    {
      user_id: user.id,
      tx_ref: txRef,
      provider: "flutterwave",
      status: "pending",
      amount,
      currency,
      // The intended grant, read back by grant_pro_access under a row lock.
      plan: selection.plan,
      term: selection.term,
      granted_days: subscription.grantedDays,
      kind: "subscription_initial",
      provider_plan_id: subscription.paymentPlanId,
      bonus_days: subscription.bonusDays,
    },
  ]);
  if (insertErr) {
    console.error("❌ createCheckout: failed to record pending payment:", insertErr.message);
    throw new CheckoutError("PAYMENT_RECORD_FAILED", insertErr.message);
  }

  let res: Response;
  try {
    res = await providerFetch(`${FLW_API}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.flutterwaveSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        // Subscribes this card to the plan. Flutterwave fixes the payment
        // method to card and charges again every period until cancelled.
        payment_plan: subscription.paymentPlanId,
        redirect_url: `${config.appBaseUrl}/billing/return`,
        customer: {
          email: user.email,
          name: user.name || undefined,
        },
        customizations: {
          title: `PitchNest ${planLabel}`,
          description:
            `PitchNest ${planLabel}, renews every ${termLabel} until you cancel` +
            (subscription.bonusDays > 0 ? ". Your free month is added on top." : "."),
        },
        meta: { user_id: user.id, plan: selection.plan, term: selection.term },
      }),
    });
  } catch (err: any) {
    // A thrown fetch is a transport failure (DNS, TLS, blocked egress), NOT a
    // provider rejection — distinct from the !res.ok branch below, which means
    // Flutterwave answered but refused. The pending row is left as-is: harmless,
    // and the webhook can still resolve it if the user somehow paid.
    console.error("❌ Flutterwave payment init unreachable:", err?.message || err);
    throw new CheckoutError("CHECKOUT_INIT_FAILED", `unreachable: ${err?.message || err}`);
  }

  const body: any = await res.json().catch(() => null);

  if (!res.ok || body?.status !== "success" || !body?.data?.link) {
    // Flutterwave answered but refused — the message names why (invalid key,
    // currency not enabled on the account, live/test mismatch, ...).
    const providerMsg = String(body?.message || `HTTP ${res.status}`)
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 300);
    // Gateway errors may echo customer or checkout fields. Keep logs useful
    // without copying the complete provider payload into the log stream.
    console.error("❌ Flutterwave payment init failed:", res.status, providerMsg);
    await markPaymentFailed(txRef).catch((error: any) => {
      console.error("❌ Could not finalize rejected checkout:", error?.message || error);
      throw new CheckoutError("PAYMENT_RECORD_FAILED", "could not mark rejected checkout failed");
    });
    throw new CheckoutError("CHECKOUT_INIT_FAILED", providerMsg);
  }

  let paymentUrl: URL;
  try {
    paymentUrl = new URL(String(body.data.link));
  } catch {
    await markPaymentFailed(txRef).catch((error: any) => {
      console.error("❌ Could not finalize invalid checkout response:", error?.message || error);
      throw new CheckoutError("PAYMENT_RECORD_FAILED", "could not mark invalid checkout failed");
    });
    throw new CheckoutError("CHECKOUT_INIT_FAILED", "provider returned an invalid payment link");
  }
  // Live checkout always runs on checkout.flutterwave.com. Test mode hosts its
  // page elsewhere; the link still comes straight from the authenticated API,
  // so a test key accepts any https host (logged below).
  const testMode = config.flutterwaveSecretKey.startsWith("FLWSECK_TEST-");
  const trustedHost = paymentUrl.hostname === "checkout.flutterwave.com" || testMode;
  if (
    paymentUrl.protocol !== "https:" ||
    !trustedHost ||
    paymentUrl.username ||
    paymentUrl.password ||
    paymentUrl.toString().length > 2_048
  ) {
    await markPaymentFailed(txRef).catch((error: any) => {
      console.error("❌ Could not finalize unsafe checkout response:", error?.message || error);
      throw new CheckoutError("PAYMENT_RECORD_FAILED", "could not mark unsafe checkout failed");
    });
    throw new CheckoutError(
      "CHECKOUT_INIT_FAILED",
      `provider returned an unsafe payment link (host ${paymentUrl.hostname})`,
    );
  }
  if (paymentUrl.hostname !== "checkout.flutterwave.com") {
    console.info(`ℹ️ Flutterwave test checkout on ${paymentUrl.hostname}`);
  }

  return { txRef, paymentLink: paymentUrl.toString() };
}

export interface VerifiedTransaction {
  status: string;
  txRef: string;
  amount: number;
  currency: string;
  providerRef: string;
}

/**
 * Re-queries Flutterwave for the truth about a transaction.
 *
 * The webhook payload tells us something happened; this tells us what. Flutterwave's
 * own guidance is to never grant value on the payload alone, because the endpoint
 * is public and a forged body with a stolen-looking reference is trivial to send.
 */
/**
 * Re-queries Flutterwave for the truth about a transaction.
 * Supports verification by numeric transaction ID OR by string tx_ref.
 */
export async function verifyTransaction(
  transactionIdOrRef: string | number,
): Promise<VerifiedTransaction | null> {
  const details = await verifyTransactionDetails(transactionIdOrRef);
  if (!details) return null;
  if (!isCheckoutTxRef(details.txRef)) {
    console.error("Flutterwave verification returned an invalid transaction shape.");
    return null;
  }
  const { status, txRef, amount, currency, providerRef } = details;
  return { status, txRef, amount, currency, providerRef };
}

/** References minted by createCheckout. Renewal charges carry Flutterwave's own. */
export function isCheckoutTxRef(txRef: string): boolean {
  return /^pn-\d+-\d{10,16}-[a-f0-9]{16}$/.test(txRef);
}

export interface VerifiedTransactionDetails extends VerifiedTransaction {
  /** The payer's email as Flutterwave holds it, lowercased. */
  customerEmail: string | null;
  /** The payment plan the charge belongs to, when Flutterwave reports one. */
  planId: number | null;
  paymentType: string | null;
}

/**
 * The verified transaction with the fields renewals need. Unlike
 * verifyTransaction it accepts any reference format, because a renewal charge is
 * raised by Flutterwave rather than by our checkout.
 */
export async function verifyTransactionDetails(
  transactionIdOrRef: string | number,
): Promise<VerifiedTransactionDetails | null> {
  if (!config.flutterwaveSecretKey) return null;

  try {
    const isNumericId =
      typeof transactionIdOrRef === "number" ||
      /^\d+$/.test(String(transactionIdOrRef));

    const url = isNumericId
      ? `${FLW_API}/transactions/${transactionIdOrRef}/verify`
      : `${FLW_API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(String(transactionIdOrRef))}`;

    const res = await providerFetch(url, {
      headers: { Authorization: `Bearer ${config.flutterwaveSecretKey}` },
    });
    const body: any = await res.json().catch(() => null);

    if (!res.ok || body?.status !== "success" || !body?.data) {
      return null;
    }

    const data = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!data) return null;

    const txRef = typeof data.tx_ref === "string" ? data.tx_ref.trim() : "";
    const amount = Number(data.amount);
    const currency = String(data.currency || "").trim().toUpperCase();
    const providerRef = String(data.id ?? "").trim();
    if (
      !txRef ||
      txRef.length > 200 ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !/^[A-Z]{3}$/.test(currency) ||
      !/^\d{1,20}$/.test(providerRef)
    ) {
      console.error("Flutterwave verification returned an invalid transaction shape.");
      return null;
    }
    const email = typeof data.customer?.email === "string" ? data.customer.email.trim().toLowerCase() : "";
    const rawPlan = data.plan ?? data.payment_plan;
    const planId = Number(typeof rawPlan === "object" && rawPlan !== null ? rawPlan.id : rawPlan);
    return {
      status: String(data.status || "").toLowerCase(),
      txRef,
      amount,
      currency,
      providerRef,
      customerEmail: email && email.length <= 320 ? email : null,
      planId: Number.isSafeInteger(planId) && planId > 0 ? planId : null,
      paymentType: typeof data.payment_type === "string" ? data.payment_type.toLowerCase() : null,
    };
  } catch (err: any) {
    console.error("❌ verifyTransaction threw:", err?.message || err);
    return null;
  }
}

// ── Payment plans and subscriptions ─────────────────────────────────────────

export class ProviderError extends Error {
  constructor(public detail: string) {
    super("PROVIDER_ERROR");
    this.name = "ProviderError";
  }
}

async function providerJson(path: string, init: RequestInit = {}): Promise<any> {
  if (!config.flutterwaveSecretKey) throw new ProviderError("billing not configured");
  let res: Response;
  try {
    res = await providerFetch(`${FLW_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.flutterwaveSecretKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch (err: any) {
    throw new ProviderError(`unreachable: ${err?.message || err}`);
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.status !== "success") {
    const message = String(body?.message || `HTTP ${res.status}`).replace(/[\r\n\t]+/g, " ").slice(0, 300);
    throw new ProviderError(message);
  }
  return body;
}

/** Creates a Flutterwave payment plan and returns its id. */
export async function createProviderPaymentPlan(input: {
  name: string;
  amount: number;
  currency: string;
  interval: "monthly" | "yearly";
}): Promise<number> {
  const body = await providerJson("/payment-plans", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const id = Number(body?.data?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ProviderError("payment plan response had no id");
  return id;
}

export interface ProviderSubscription {
  id: number;
  planId: number | null;
  status: string;
  email: string | null;
}

/** Subscriptions Flutterwave holds for this email, optionally for one plan. */
export async function listProviderSubscriptions(filter: {
  email: string;
  planId?: number;
}): Promise<ProviderSubscription[]> {
  const params = new URLSearchParams({ email: filter.email });
  if (filter.planId) params.set("plan", String(filter.planId));
  const body = await providerJson(`/subscriptions?${params.toString()}`);
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => ({
      id: Number(row?.id),
      planId: Number.isSafeInteger(Number(row?.plan)) ? Number(row.plan) : null,
      status: String(row?.status || "").toLowerCase(),
      email:
        typeof row?.customer?.customer_email === "string"
          ? row.customer.customer_email.trim().toLowerCase()
          : null,
    }))
    .filter((row) => Number.isSafeInteger(row.id) && row.id > 0)
    // The filter is ours to enforce too, not only the provider's.
    .filter((row) => !filter.planId || row.planId === filter.planId)
    .filter((row) => !row.email || row.email === filter.email.trim().toLowerCase());
}

/** Stops future renewals. Access already paid for is untouched. */
export async function cancelProviderSubscription(subscriptionId: number): Promise<void> {
  await providerJson(`/subscriptions/${subscriptionId}/cancel`, { method: "PUT" });
}

/**
 * Constant-time check of the `verif-hash` webhook header.
 *
 * v3 sends the dashboard secret hash verbatim rather than an HMAC over the body,
 * so this is an equality check — but it must still be timing-safe, because a
 * naive `!==` leaks the secret one byte at a time to anyone who can measure
 * response latency across many attempts.
 *
 * Returns false when no hash is configured: an unverifiable webhook must never
 * be treated as authentic.
 */
export function verifyWebhookSignature(headerValue: unknown): boolean {
  const expected = config.flutterwaveWebhookHash;
  if (!expected) return false;
  if (typeof headerValue !== "string" || !headerValue) return false;

  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, which itself leaks length — so
  // compare lengths first and always run the digest comparison on equal-size
  // buffers.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Settles a verified payment: marks it successful and extends the user's paid
 * period, atomically. The tier and day-count come from the payment row itself
 * (recorded at checkout), so this call only needs to pass the VERIFIED amount
 * and currency that were actually charged.
 *
 * Returns true when access was granted, false when the reference was already
 * settled (a webhook retry — Flutterwave sends up to 3, 30 minutes apart).
 */
export async function grantAccess(tx: VerifiedTransaction): Promise<boolean> {
  const { data, error } = await supabase.rpc("grant_pro_access", {
    p_tx_ref: tx.txRef,
    p_provider_ref: tx.providerRef,
    p_amount: tx.amount,
    p_currency: tx.currency,
  });

  if (error) {
    // UNKNOWN_TX_REF means a webhook arrived for a reference we never minted —
    // either a forged request that got past the hash, or another integration
    // sharing this Flutterwave account. Loud, because both matter.
    console.error(`❌ grant_pro_access failed for ${tx.txRef}:`, error.message);
    throw error;
  }

  return data === true;
}

/** Marks a checkout attempt failed so webhook acknowledgement is durable. */
export async function markPaymentFailed(txRef: string): Promise<void> {
  const { error } = await supabase
    .from("payments")
    .update({ status: "failed", completed_at: new Date().toISOString() })
    .eq("tx_ref", txRef)
    .eq("status", "pending");
  if (error) throw error;
}
