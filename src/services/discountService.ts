import type { BillingTerm, PaidPlan } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { checkoutPrice } from "./localPriceService.ts";
import { getActiveSubscription, hasSettledPayment } from "./subscriptionService.ts";

/**
 * Percentage discount codes (migration 0037).
 *
 * A code prices the FIRST period of a one-time (manual renewal) checkout, or
 * the first `periods` checkouts when an admin sets more. It is never applied to
 * an automatic-renewal checkout: a Flutterwave payment plan charges one amount
 * for ever, so a discounted plan would renew at the discounted price.
 *
 * Everything here is advisory display logic. The authoritative check runs in
 * reserve_discount_redemption, under a row lock, when checkout records the
 * pending payment; the discounted amount is the payment row's amount, so
 * grant_pro_access settles it like any other payment and a short payment is
 * still refused.
 */

export type DiscountRefusal =
  | "unknown"
  | "inactive"
  | "not_started"
  | "expired"
  | "not_applicable"
  | "manual_only"
  | "already_used"
  | "exhausted"
  | "new_customers_only"
  | "auto_renew_active"
  | "currency_unavailable"
  | "unavailable";

export const DISCOUNT_REFUSAL_MESSAGES: Record<DiscountRefusal, string> = {
  unknown: "That code isn't valid. Check the spelling and try again.",
  inactive: "That code isn't active right now.",
  not_started: "That code isn't active yet.",
  expired: "That code has expired.",
  not_applicable: "That code doesn't apply to this plan or billing period.",
  manual_only: "This code works with a one-time payment (manual renewal) only.",
  already_used: "You've already used this code.",
  exhausted: "This code has reached its usage limit.",
  new_customers_only: "This code is for first-time subscribers only.",
  auto_renew_active: "This code can't be used while your plan renews automatically. Your current plan already covers you.",
  currency_unavailable: "Paying in that currency isn't available right now. Please refresh the page, or pay in US dollars.",
  unavailable: "Discount codes aren't available right now. Please try again later.",
};

export interface DiscountCodeRow {
  id: string;
  code: string;
  description: string | null;
  percent_off: number;
  plans: string[];
  terms: string[];
  periods: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  new_customers_only: boolean;
  combine_with_offer: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export const DISCOUNT_COLUMNS =
  "id, code, description, percent_off, plans, terms, periods, starts_at, ends_at, max_redemptions, new_customers_only, combine_with_offer, active, created_at, updated_at";

/** "pchu01 " → "PCHU01"; null for anything that cannot be a code. */
export function normalizeDiscountCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : null;
}

/**
 * The discounted amount, computed in minor units so it matches the database's
 * ROUND(list * (100 - percent) / 100, 2) exactly (reserve_discount_redemption
 * refuses any other figure).
 */
export function discountedAmount(listAmount: number, percentOff: number): number {
  const listMinor = Math.round(listAmount * 100);
  return Math.round((listMinor * (100 - percentOff)) / 100) / 100;
}

/** The checks that need only the code itself and the SKU. */
export function staticRefusal(
  code: DiscountCodeRow,
  selection: { plan: PaidPlan; term: BillingTerm },
  now = new Date(),
): DiscountRefusal | null {
  if (!code.active) return "inactive";
  if (code.starts_at && now.getTime() < Date.parse(code.starts_at)) return "not_started";
  if (code.ends_at && now.getTime() >= Date.parse(code.ends_at)) return "expired";
  if (!code.plans.includes(selection.plan) || !code.terms.includes(selection.term)) return "not_applicable";
  return null;
}

/** null when the table is missing (migration 0037 not applied): codes are simply unavailable. */
export async function findDiscountCode(code: string): Promise<DiscountCodeRow | null | "unavailable"> {
  const { data, error } = await supabase
    .from("discount_codes")
    .select(DISCOUNT_COLUMNS)
    .eq("code", code)
    .maybeSingle();
  if (error) {
    if (error.code !== "42P01" && error.code !== "PGRST205") console.error("Discount code lookup failed:", error.message);
    return "unavailable";
  }
  return (data as DiscountCodeRow | null) ?? null;
}

/** A head:true count, or the row count where a client returns rows instead. */
export function countOf(result: { count?: number | null; data?: unknown }): number {
  if (typeof result.count === "number") return result.count;
  return Array.isArray(result.data) ? result.data.length : 0;
}

async function redemptionCounts(codeId: string, userId: number): Promise<{ mine: number; used: number } | null> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const [mine, redeemed, pending] = await Promise.all([
    supabase
      .from("discount_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", codeId)
      .eq("user_id", userId)
      .eq("status", "redeemed"),
    supabase
      .from("discount_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", codeId)
      .eq("status", "redeemed"),
    supabase
      .from("discount_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", codeId)
      .eq("status", "pending")
      .neq("user_id", userId)
      .gt("created_at", since),
  ]);
  if (mine.error || redeemed.error || pending.error) return null;
  return { mine: countOf(mine), used: countOf(redeemed) + countOf(pending) };
}

export interface DiscountQuote {
  codeId: string;
  code: string;
  percentOff: number;
  plan: PaidPlan;
  term: BillingTerm;
  currency: string;
  /** The normal price of the first period. */
  listAmount: number;
  /** What checkout will charge for it. */
  amount: number;
  /** How many checkouts the code discounts for one founder. */
  periods: number;
  /** Whether first-subscription free months still apply on top. */
  combineWithOffer: boolean;
  billingMode: "manual";
}

/**
 * Prices a checkout with a code for this founder, or says why the code does
 * not apply. Used by the preview and by checkout itself, so what the pricing
 * page shows is what checkout records.
 */
export async function quoteDiscount(input: {
  code: string;
  userId: number;
  plan: PaidPlan;
  term: BillingTerm;
  currency: string;
  now?: Date;
}): Promise<{ ok: true; quote: DiscountQuote } | { ok: false; reason: DiscountRefusal }> {
  const found = await findDiscountCode(input.code);
  if (found === "unavailable") return { ok: false, reason: "unavailable" };
  if (!found) return { ok: false, reason: "unknown" };
  const refusal = staticRefusal(found, input, input.now);
  if (refusal) return { ok: false, reason: refusal };

  try {
    const [counts, current] = await Promise.all([
      redemptionCounts(found.id, input.userId),
      getActiveSubscription(input.userId),
    ]);
    if (!counts) return { ok: false, reason: "unavailable" };
    if (counts.mine >= found.periods) return { ok: false, reason: "already_used" };
    if (found.max_redemptions !== null && counts.used >= found.max_redemptions) return { ok: false, reason: "exhausted" };
    // A code moves checkout to a one-time payment, which would retire an
    // automatic renewal the founder already has. Leave their plan alone.
    if (current && (current.billing_mode ?? "auto_renew") === "auto_renew") {
      return { ok: false, reason: "auto_renew_active" };
    }
    if (found.new_customers_only && (await hasSettledPayment(input.userId))) {
      return { ok: false, reason: "new_customers_only" };
    }
  } catch (error: any) {
    console.error("Discount eligibility check failed:", error?.message || error);
    return { ok: false, reason: "unavailable" };
  }

  const price = await checkoutPrice(input.plan, input.term, input.currency);
  if (!price) return { ok: false, reason: "currency_unavailable" };
  return {
    ok: true,
    quote: {
      codeId: found.id,
      code: found.code,
      percentOff: found.percent_off,
      plan: input.plan,
      term: input.term,
      currency: price.currency,
      listAmount: price.amount,
      amount: discountedAmount(price.amount, found.percent_off),
      periods: found.periods,
      combineWithOffer: found.combine_with_offer === true,
      billingMode: "manual",
    },
  };
}

// ─── Staff ───────────────────────────────────────────────────────────────────

export interface DiscountStats {
  redeemed: number;
  pending: number;
}

export function toStaffDiscount(row: DiscountCodeRow, stats?: DiscountStats) {
  return {
    id: row.id,
    code: row.code,
    description: row.description ?? "",
    percentOff: Number(row.percent_off),
    plans: Array.isArray(row.plans) ? row.plans : [],
    terms: Array.isArray(row.terms) ? row.terms : [],
    periods: Number(row.periods) || 1,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    maxRedemptions: row.max_redemptions ?? null,
    newCustomersOnly: row.new_customers_only === true,
    combineWithOffer: row.combine_with_offer === true,
    active: row.active === true,
    redeemed: stats?.redeemed ?? 0,
    pending: stats?.pending ?? 0,
    updatedAt: row.updated_at ?? null,
  };
}

/** Public facts about a challenge's code; nothing about who used it. */
export function toPublicDiscount(row: DiscountCodeRow, now = new Date()) {
  const usable =
    row.active === true &&
    (!row.starts_at || now.getTime() >= Date.parse(row.starts_at)) &&
    (!row.ends_at || now.getTime() < Date.parse(row.ends_at));
  return {
    code: row.code,
    percentOff: Number(row.percent_off),
    plans: Array.isArray(row.plans) ? row.plans : [],
    terms: Array.isArray(row.terms) ? row.terms : [],
    periods: Number(row.periods) || 1,
    endsAt: row.ends_at ?? null,
    active: usable,
  };
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

export function validateDiscountInput(
  input: unknown,
  options: { partial?: boolean } = {},
): { values: Record<string, unknown>; errors: string[] } {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const has = (key: string) => key in body || !options.partial;

  if (has("code")) {
    const code = normalizeDiscountCode(body.code);
    if (code) values.code = code;
    else errors.push("code must be 4-32 letters or digits.");
  }
  if ("description" in body) {
    const text = typeof body.description === "string" ? body.description.trim() : "";
    if (text.length > 300) errors.push("description can be up to 300 characters.");
    else values.description = text || null;
  }
  if (has("percentOff")) {
    const pct = Number(body.percentOff);
    if (Number.isInteger(pct) && pct >= 1 && pct <= 90) values.percent_off = pct;
    else errors.push("percentOff must be a whole number from 1 to 90.");
  }
  if ("plans" in body || !options.partial) {
    const plans = Array.isArray(body.plans) ? [...new Set(body.plans)] : options.partial ? null : ["pro"];
    if (plans && plans.length > 0 && plans.every((p) => p === "prep" || p === "pro")) values.plans = plans;
    else errors.push("plans must list prep and/or pro.");
  }
  if ("terms" in body || !options.partial) {
    const terms = Array.isArray(body.terms) ? [...new Set(body.terms)] : options.partial ? null : ["monthly"];
    if (terms && terms.length > 0 && terms.every((t) => t === "monthly" || t === "annual")) values.terms = terms;
    else errors.push("terms must list monthly and/or annual.");
  }
  if ("periods" in body) {
    const periods = Number(body.periods);
    if (Number.isInteger(periods) && periods >= 1 && periods <= 12) values.periods = periods;
    else errors.push("periods must be a whole number from 1 to 12.");
  }
  for (const [field, column] of [["startsAt", "starts_at"], ["endsAt", "ends_at"]] as const) {
    if (!(field in body)) continue;
    const value = isoOrNull(body[field]);
    if (value === undefined) errors.push(`${field} must be a date and time.`);
    else values[column] = value;
  }
  if (typeof values.starts_at === "string" && typeof values.ends_at === "string" && values.starts_at >= values.ends_at) {
    errors.push("startsAt must be before endsAt.");
  }
  if ("maxRedemptions" in body) {
    const raw = body.maxRedemptions;
    if (raw === null || raw === "") values.max_redemptions = null;
    else if (Number.isInteger(Number(raw)) && Number(raw) > 0) values.max_redemptions = Number(raw);
    else errors.push("maxRedemptions must be a positive whole number, or empty for no limit.");
  }
  for (const [field, column] of [["newCustomersOnly", "new_customers_only"], ["combineWithOffer", "combine_with_offer"], ["active", "active"]] as const) {
    if (!(field in body)) continue;
    if (typeof body[field] === "boolean") values[column] = body[field];
    else errors.push(`${field} must be true or false.`);
  }
  return { values, errors: [...new Set(errors)] };
}
