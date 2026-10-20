import {
  config,
  type BillingTerm,
  type PaidPlan,
  type ResolvedPrice,
} from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  cancelProviderSubscription,
  CheckoutError,
  createProviderPaymentPlan,
  grantAccess,
  listProviderSubscriptions,
  type VerifiedTransactionDetails,
} from "./flutterwaveService.ts";

/**
 * Auto-renewing plans on Flutterwave payment plans.
 *
 * Flutterwave charges the card every period; each verified charge is settled
 * by grant_pro_access like any other payment, so entitlement keeps reading
 * users.plan_expires_at and nothing here grants access on its own.
 *
 * TIMING. Flutterwave renews on calendar months from the first charge, so
 * access is extended by calendar months too: the first charge covers
 * now + one term (+ free months) + RENEWAL_GRACE_DAYS, and each renewal adds
 * one term to the current expiry. The grace keeps a renewal that lands a few
 * hours late from dropping someone to Free in between.
 */

export const RENEWAL_GRACE_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export function termMonths(term: BillingTerm): number {
  return term === "annual" ? 12 : 1;
}

/** Adds calendar months in UTC, clamping to the last day (Jan 31 + 1 = Feb 28). */
export function addMonthsUtc(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

/** Days granted by the first charge: one term, any free months, and the grace. */
export function initialGrantDays(term: BillingTerm, freeMonths: number, now = new Date()): number {
  const end = addMonthsUtc(now, termMonths(term) + Math.max(0, freeMonths));
  return daysBetween(now, end) + RENEWAL_GRACE_DAYS;
}

/** Days a renewal adds: exactly one term on from the current expiry. */
export function renewalGrantDays(term: BillingTerm, currentExpiry: Date | null, now = new Date()): number {
  const base = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  return daysBetween(base, addMonthsUtc(base, termMonths(term)));
}

/** When Flutterwave should next charge: the first term anniversary after now. */
export function nextChargeDate(startedAt: Date, term: BillingTerm, now = new Date()): Date {
  const step = termMonths(term);
  let periods = 1;
  let next = addMonthsUtc(startedAt, step);
  while (next.getTime() <= now.getTime() && periods < 1200) {
    periods += 1;
    next = addMonthsUtc(startedAt, step * periods);
  }
  return next;
}

// ── Provider plans ───────────────────────────────────────────────────────────

const PLAN_NAMES: Record<PaidPlan, string> = { prep: "Founder", pro: "Pro Founder" };

/**
 * The Flutterwave payment plan for this SKU at this price, created on first
 * use. A price change, or the same SKU priced in another currency, yields a new
 * plan, so existing subscribers keep renewing at the amount they agreed to.
 */
export async function ensureProviderPlan(price: ResolvedPrice): Promise<number> {
  const { plan, term } = price;
  const lookup = async () => {
    const { data, error } = await supabase
      .from("billing_provider_plans")
      .select("provider_plan_id")
      .eq("provider", "flutterwave")
      .eq("plan", plan)
      .eq("term", term)
      .eq("amount", price.amount)
      .eq("currency", price.currency)
      .maybeSingle();
    if (error) throw new CheckoutError("PAYMENT_RECORD_FAILED", error.message);
    return data ? Number((data as any).provider_plan_id) : null;
  };

  const existing = await lookup();
  if (existing) return existing;

  let providerPlanId: number;
  try {
    // Dollar plans keep the names they already have at Flutterwave; a local
    // one names its currency so it stands out in the dashboard.
    const local = price.currency === config.proPlanCurrency ? "" : `, ${price.currency}`;
    providerPlanId = await createProviderPaymentPlan({
      name: `PitchNest ${PLAN_NAMES[plan]} (${term === "annual" ? "yearly" : "monthly"}${local})`,
      amount: price.amount,
      currency: price.currency,
      interval: term === "annual" ? "yearly" : "monthly",
    });
  } catch (err: any) {
    throw new CheckoutError("CHECKOUT_INIT_FAILED", `payment plan: ${err?.detail || err?.message || err}`);
  }

  const { error } = await supabase.from("billing_provider_plans").insert({
    provider: "flutterwave",
    plan,
    term,
    amount: price.amount,
    currency: price.currency,
    provider_plan_id: providerPlanId,
  });
  if (error) {
    // Another checkout created the same SKU first; use the stored one.
    if (error.code === "23505") {
      const raced = await lookup();
      if (raced) return raced;
    }
    throw new CheckoutError("PAYMENT_RECORD_FAILED", error.message);
  }
  return providerPlanId;
}

// ── Offer and state ──────────────────────────────────────────────────────────

/** True once the user has paid for anything, which ends the first-subscription offer. */
export async function hasSettledPayment(userId: number): Promise<boolean> {
  const { count, error } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "successful");
  if (error) throw error;
  return (count ?? 0) > 0;
}

export interface OfferView {
  /** Free months added to a first subscription; 0 when the offer is off. */
  freeMonths: number;
  /** Whether this user would get them on their next checkout. */
  eligible: boolean;
}

export async function offerFor(userId: number, hasUnlimitedAccess: boolean): Promise<OfferView> {
  const freeMonths = config.firstSubscriptionFreeMonths;
  if (freeMonths === 0 || hasUnlimitedAccess) return { freeMonths, eligible: false };
  return { freeMonths, eligible: !(await hasSettledPayment(userId)) };
}

export interface SubscriptionRow {
  id: string;
  user_id: number;
  plan: PaidPlan;
  term: BillingTerm;
  amount: number;
  currency: string;
  provider_plan_id: number;
  provider_subscription_id: number | null;
  customer_email: string;
  status: "active" | "cancelled";
  provider_cancel_pending: boolean;
  cancelled_at: string | null;
  created_at: string;
}

const SUBSCRIPTION_COLUMNS =
  "id, user_id, plan, term, amount, currency, provider_plan_id, provider_subscription_id, customer_email, status, provider_cancel_pending, cancelled_at, created_at";

export async function getActiveSubscription(userId: number): Promise<SubscriptionRow | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return (data as SubscriptionRow | null) ?? null;
}

async function getLatestSubscription(userId: number): Promise<SubscriptionRow | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as SubscriptionRow | null) ?? null;
}

export interface SubscriptionView {
  plan: PaidPlan;
  term: BillingTerm;
  amount: number;
  currency: string;
  /** True while Flutterwave will keep charging. */
  autoRenew: boolean;
  /** Next expected charge while auto-renewing; null once cancelled. */
  nextChargeAt: string | null;
  cancelledAt: string | null;
}

export function toSubscriptionView(row: SubscriptionRow, now = new Date()): SubscriptionView {
  const active = row.status === "active";
  return {
    plan: row.plan,
    term: row.term,
    amount: Number(row.amount),
    currency: row.currency,
    autoRenew: active,
    nextChargeAt: active ? nextChargeDate(new Date(row.created_at), row.term, now).toISOString() : null,
    cancelledAt: row.cancelled_at,
  };
}

/** The subscription to show in Billing: the active one, else the latest. */
export async function subscriptionViewFor(userId: number): Promise<SubscriptionView | null> {
  const row = (await getActiveSubscription(userId)) ?? (await getLatestSubscription(userId));
  return row ? toSubscriptionView(row) : null;
}

// ── Provider bookkeeping ─────────────────────────────────────────────────────

/** Finds and stores the provider's id for this subscription; null when it has none active. */
async function resolveProviderSubscriptionId(row: SubscriptionRow): Promise<number | null> {
  if (row.provider_subscription_id) return Number(row.provider_subscription_id);
  const matches = await listProviderSubscriptions({
    email: row.customer_email,
    planId: Number(row.provider_plan_id),
  });
  const active = matches.find((match) => match.status === "active");
  if (!active) return null;
  await supabase
    .from("subscriptions")
    .update({ provider_subscription_id: active.id, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  return active.id;
}

/**
 * Cancels, at Flutterwave, subscriptions we have already retired (a plan
 * switch, or a cancel that failed earlier). Safe to call often: it does nothing
 * when nothing is pending, and leaves the flag set to retry if Flutterwave fails.
 */
export async function retryPendingProviderCancels(userId: number): Promise<void> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("user_id", userId)
    .eq("provider_cancel_pending", true);
  if (error || !Array.isArray(data)) return;
  for (const row of data as SubscriptionRow[]) {
    try {
      const providerId = await resolveProviderSubscriptionId(row);
      if (providerId) await cancelProviderSubscription(providerId);
      await supabase
        .from("subscriptions")
        .update({ provider_cancel_pending: false, updated_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch (err: any) {
      console.error(
        `❌ Could not cancel retired subscription ${row.id} at Flutterwave; will retry:`,
        err?.detail || err?.message || err,
      );
    }
  }
}

/**
 * Records the subscription a settled first charge started and retires any
 * earlier one. Idempotent, so webhook replays and the dev auto-sync can call it.
 */
export async function startSubscriptionAfterPayment(txRef: string, userId: number, email: string | null): Promise<void> {
  let customerEmail = email;
  if (!customerEmail) {
    const { data } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
    customerEmail = (data as any)?.email ?? null;
  }
  const { error } = await supabase.rpc("start_subscription_from_payment", {
    p_tx_ref: txRef,
    p_customer_email: customerEmail,
  });
  if (error) throw error;
  await retryPendingProviderCancels(userId);
}

export class SubscriptionError extends Error {
  constructor(public code: "NO_SUBSCRIPTION" | "PROVIDER_UNAVAILABLE") {
    super(code);
    this.name = "SubscriptionError";
  }
}

/**
 * Turns off auto-renew. The user keeps what they have paid for until
 * users.plan_expires_at; only future charges stop.
 */
export async function cancelUserSubscription(userId: number): Promise<SubscriptionView> {
  const row = await getActiveSubscription(userId);
  if (!row) throw new SubscriptionError("NO_SUBSCRIPTION");

  try {
    const providerId = await resolveProviderSubscriptionId(row);
    // None active at Flutterwave means it is already stopped there.
    if (providerId) await cancelProviderSubscription(providerId);
  } catch (err: any) {
    console.error(`❌ Subscription cancel failed for user ${userId}:`, err?.detail || err?.message || err);
    throw new SubscriptionError("PROVIDER_UNAVAILABLE");
  }

  const cancelledAt = new Date().toISOString();
  const { error } = await supabase
    .from("subscriptions")
    .update({ status: "cancelled", cancelled_at: cancelledAt, provider_cancel_pending: false, updated_at: cancelledAt })
    .eq("id", row.id)
    .eq("status", "active");
  if (error) throw error;
  return toSubscriptionView({ ...row, status: "cancelled", cancelled_at: cancelledAt });
}

/**
 * Account deletion: cancel the live renewal and any retired one still pending
 * at Flutterwave. Throws if any cannot be stopped, so deletion halts while the
 * user can still retry rather than leaving a card charged for a deleted account.
 */
export async function stopRenewalsForDeletion(userId: number): Promise<void> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("user_id", userId);
  if (error) {
    // Before 0031 there is nothing to cancel.
    if (error.code === "42P01" || error.code === "PGRST205") return;
    throw error;
  }
  const owed = ((data as SubscriptionRow[] | null) ?? []).filter(
    (row) => row.status === "active" || row.provider_cancel_pending,
  );
  for (const row of owed) {
    try {
      const providerId = await resolveProviderSubscriptionId(row);
      if (providerId) await cancelProviderSubscription(providerId);
    } catch (err: any) {
      throw new Error(`ACCOUNT_DELETE_SUBSCRIPTION_CANCEL_FAILED:${err?.detail || err?.message || err}`);
    }
  }
}

// ── Webhook paths ────────────────────────────────────────────────────────────

export type RenewalOutcome = "granted" | "replay" | "ignored";

/**
 * Settles a charge Flutterwave raised on its own: a renewal. It counts only
 * when it matches a subscription we started, at that subscription's price, and
 * Flutterwave confirms the subscription is still active for that email.
 * Anything else is logged and left for a human, never granted.
 */
export async function settleRenewal(
  tx: VerifiedTransactionDetails,
  knownUserId: number | null,
): Promise<RenewalOutcome> {
  if (tx.paymentType && tx.paymentType !== "card") {
    console.warn(`⚠️ Unmatched ${tx.paymentType} transaction ${tx.providerRef}; not a renewal.`);
    return "ignored";
  }

  let userId = knownUserId;
  if (!userId) {
    if (!tx.customerEmail) {
      console.warn(`⚠️ Transaction ${tx.providerRef} has no customer email; cannot match a renewal.`);
      return "ignored";
    }
    const { data: user, error } = await supabase
      .from("users")
      .select("id")
      .eq("email", tx.customerEmail)
      .maybeSingle();
    if (error) throw error;
    if (!user) {
      console.warn(`⚠️ Transaction ${tx.providerRef} matches no user; not granting.`);
      return "ignored";
    }
    userId = Number((user as any).id);
  }

  const subscription = await getActiveSubscription(userId);
  if (!subscription) {
    console.warn(`⚠️ Charge ${tx.providerRef} for user ${userId} has no active subscription; needs review.`);
    return "ignored";
  }
  if (tx.planId && tx.planId !== Number(subscription.provider_plan_id)) {
    console.warn(`⚠️ Charge ${tx.providerRef} is for plan ${tx.planId}, not ${subscription.provider_plan_id}.`);
    return "ignored";
  }
  if (
    tx.amount < Number(subscription.amount) ||
    tx.currency !== String(subscription.currency).toUpperCase()
  ) {
    console.error(
      `❌ Renewal ${tx.providerRef} paid ${tx.amount} ${tx.currency}, expected ${subscription.amount} ${subscription.currency}. Not granting.`,
    );
    return "ignored";
  }

  const providerSubscriptions = await listProviderSubscriptions({
    email: subscription.customer_email,
    planId: Number(subscription.provider_plan_id),
  });
  const live = providerSubscriptions.find((row) => row.status === "active");
  if (!live) {
    console.warn(`⚠️ Flutterwave has no active subscription behind charge ${tx.providerRef}; not granting.`);
    return "ignored";
  }
  if (!subscription.provider_subscription_id) {
    await supabase
      .from("subscriptions")
      .update({ provider_subscription_id: live.id, updated_at: new Date().toISOString() })
      .eq("id", subscription.id);
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("plan_expires_at")
    .eq("id", userId)
    .maybeSingle();
  if (userError) throw userError;
  const expiresAt = (user as any)?.plan_expires_at ? new Date((user as any).plan_expires_at) : null;

  // One row per Flutterwave transaction: a replayed webhook hits the unique
  // tx_ref and grant_pro_access then reports it as already settled.
  const txRef = `pn-renew-${tx.providerRef}`;
  const { error: insertError } = await supabase.from("payments").insert({
    user_id: userId,
    tx_ref: txRef,
    provider: "flutterwave",
    status: "pending",
    amount: Number(subscription.amount),
    currency: String(subscription.currency).toUpperCase(),
    plan: subscription.plan,
    term: subscription.term,
    granted_days: renewalGrantDays(subscription.term, expiresAt),
    kind: "subscription_renewal",
    provider_plan_id: Number(subscription.provider_plan_id),
    subscription_id: subscription.id,
  });
  if (insertError && insertError.code !== "23505") throw insertError;

  const granted = await grantAccess({ ...tx, txRef });
  return granted ? "granted" : "replay";
}

/**
 * Flutterwave stopped a subscription (cancelled from its reminder email, or
 * after failed renewals). The event is re-checked against the API before our
 * row changes; the user keeps access already paid for.
 */
export async function handleProviderCancellation(data: any): Promise<"cancelled" | "ignored"> {
  const email =
    typeof data?.customer?.email === "string"
      ? data.customer.email.trim().toLowerCase()
      : typeof data?.customer?.customer_email === "string"
        ? data.customer.customer_email.trim().toLowerCase()
        : "";
  const rawPlan = data?.plan?.id ?? data?.plan;
  const planId = Number(rawPlan);
  if (!email || !Number.isSafeInteger(planId) || planId <= 0) return "ignored";

  const { data: rows, error } = await supabase
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("customer_email", email)
    .eq("provider_plan_id", planId)
    .eq("status", "active");
  if (error) throw error;
  const matches = (rows as SubscriptionRow[] | null) ?? [];
  if (matches.length === 0) return "ignored";

  const stillActive = (await listProviderSubscriptions({ email, planId })).some((row) => row.status === "active");
  if (stillActive) return "ignored";

  const cancelledAt = new Date().toISOString();
  for (const row of matches) {
    const { error: updateError } = await supabase
      .from("subscriptions")
      .update({ status: "cancelled", cancelled_at: cancelledAt, provider_cancel_pending: false, updated_at: cancelledAt })
      .eq("id", row.id)
      .eq("status", "active");
    if (updateError) throw updateError;
  }
  return "cancelled";
}
