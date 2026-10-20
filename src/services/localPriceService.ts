import {
  config,
  isPurchasable,
  resolvePlanPrice,
  type BillingTerm,
  type PaidPlan,
  type ResolvedPrice,
} from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import { fetchUsdRate } from "./flutterwaveService.ts";

/**
 * Prices in local currencies, converted from the dollar price.
 *
 * Every price is set once, in US dollars (config). A buyer may instead see and
 * pay it in one of config.billingLocalCurrencies: the dollar amount times
 * Flutterwave's current rate, rounded up to a neat figure. The pricing page and
 * checkout both price from the same row in billing_fx_rates (migration 0035),
 * so every server instance quotes, and charges, the same amount.
 *
 * STABILITY. A rate is re-checked with Flutterwave once it is a day old and
 * replaced only when it has moved by 2% or more, so local prices (and the
 * Flutterwave payment plan made for each price) change rarely. A subscriber
 * keeps renewing at the amount they signed up at, whatever the rate does later.
 *
 * FAILING SAFE. A currency is offered only with a plausible rate confirmed in
 * the last 7 days. Without one (no migration 0035, a Flutterwave outage, a
 * nonsense quote) prices quietly fall back to dollars.
 */

interface LocalCurrencyRule {
  /** Converted prices are rounded up to a multiple of this (21,750 → 21,800). */
  step: number;
  /** Plausible units per dollar. A quote outside them is a provider error, never a price. */
  minRate: number;
  maxRate: number;
}

const RULES: Readonly<Record<string, LocalCurrencyRule>> = {
  NGN: { step: 100, minRate: 100, maxRate: 20_000 },
  KES: { step: 10, minRate: 20, maxRate: 2_000 },
  GHS: { step: 1, minRate: 1, maxRate: 500 },
  ZAR: { step: 1, minRate: 2, maxRate: 200 },
};

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const RECHECK_AFTER_MS = DAY_MS;
const USABLE_FOR_MS = 7 * DAY_MS;
// After a failed re-check, wait this long before asking Flutterwave again.
const RETRY_AFTER_MS = 15 * MINUTE_MS;
const MIN_MOVE = 0.02;

/** One catalog entry in the currency the buyer asked for. */
export type PricedSku = ResolvedPrice & {
  purchasable: boolean;
  /** On a converted price only: the dollar price it was converted from. */
  baseAmount?: number;
  baseCurrency?: string;
};

export interface PriceList {
  /** The currency every price in `catalog` is in. */
  currency: string;
  /** Currencies a buyer can choose right now, dollars first. */
  currencies: string[];
  catalog: PricedSku[];
}

interface Rate {
  usdRate: number;
  checkedAt: number;
}

const retryAt = new Map<string, number>();
let warnedMissingTable = false;

/** The configured local currencies this service can price. Dollar prices only. */
function localCurrencies(): string[] {
  if (config.proPlanCurrency !== "USD") return [];
  return config.billingLocalCurrencies.filter((code) => Object.hasOwn(RULES, code));
}

function plausible(currency: string, usdRate: number): boolean {
  const rule = RULES[currency];
  return Number.isFinite(usdRate) && usdRate >= rule.minRate && usdRate <= rule.maxRate;
}

/** The dollar amount in `currency` at `usdRate`, rounded up to the currency's step. */
export function convertFromUsd(usdAmount: number, usdRate: number, currency: string): number {
  const step = RULES[currency].step;
  // The epsilon stops float noise (2175.0000000000005 steps) adding a whole step.
  return Math.ceil((usdAmount * usdRate) / step - 1e-9) * step;
}

async function readRates(currencies: string[]): Promise<Map<string, Rate> | null> {
  const { data, error } = await supabase
    .from("billing_fx_rates")
    .select("currency, usd_rate, checked_at")
    .in("currency", currencies);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn("Prices stay in dollars: the database has no billing_fx_rates (migration 0035).");
      }
    } else {
      console.error("❌ Exchange rate lookup failed:", error.message);
    }
    return null;
  }
  const rates = new Map<string, Rate>();
  for (const row of (data as any[] | null) ?? []) {
    const usdRate = Number(row?.usd_rate);
    const checkedAt = new Date(row?.checked_at).getTime();
    if (usdRate > 0 && Number.isFinite(checkedAt)) rates.set(String(row.currency), { usdRate, checkedAt });
  }
  return rates;
}

/** Asks Flutterwave for today's rate and stores it, keeping the old rate through small moves. */
async function recheckRate(currency: string, stored: Rate | undefined, now: number): Promise<Rate | undefined> {
  let quoted: number;
  try {
    quoted = await fetchUsdRate(currency);
  } catch (err: any) {
    retryAt.set(currency, now + RETRY_AFTER_MS);
    console.warn(`⚠️ Could not refresh the ${currency} rate from Flutterwave:`, err?.detail || err?.message || err);
    return stored;
  }
  if (!plausible(currency, quoted)) {
    retryAt.set(currency, now + RETRY_AFTER_MS);
    console.error(`❌ Flutterwave quoted ${quoted} ${currency} per USD, which is implausible; not pricing from it.`);
    return stored;
  }

  // Rounded as the column stores it, so this instance prices exactly as the others will.
  const fresh = Math.round(quoted * 1e6) / 1e6;
  const keep = stored !== undefined && Math.abs(fresh - stored.usdRate) / stored.usdRate < MIN_MOVE;
  const usdRate = keep ? stored.usdRate : fresh;
  const checkedAt = new Date(now).toISOString();
  const { error } = await supabase.from("billing_fx_rates").upsert(
    {
      currency,
      usd_rate: usdRate,
      source: "flutterwave",
      checked_at: checkedAt,
      ...(keep ? {} : { updated_at: checkedAt }),
    },
    { onConflict: "currency" },
  );
  if (error) {
    retryAt.set(currency, now + RETRY_AFTER_MS);
    console.error(`❌ Could not store the ${currency} rate:`, error.message);
    return stored;
  }
  if (!keep) console.info(`ℹ️ ${currency} price rate set to ${usdRate} per USD.`);
  return { usdRate, checkedAt: now };
}

/** Rates for the local currencies offered right now, re-checking any that are a day old. */
async function usableRates(now: number): Promise<Map<string, number>> {
  const usable = new Map<string, number>();
  const currencies = localCurrencies();
  if (currencies.length === 0) return usable;
  const stored = await readRates(currencies);
  if (!stored) return usable;

  const current = await Promise.all(
    currencies.map(async (currency) => {
      const rate = stored.get(currency);
      const due = !rate || now - rate.checkedAt >= RECHECK_AFTER_MS;
      const waiting = now < (retryAt.get(currency) ?? 0);
      return [currency, due && !waiting ? await recheckRate(currency, rate, now) : rate] as const;
    }),
  );
  for (const [currency, rate] of current) {
    if (rate && now - rate.checkedAt < USABLE_FOR_MS && plausible(currency, rate.usdRate)) {
      usable.set(currency, rate.usdRate);
    }
  }
  return usable;
}

const PLANS: PaidPlan[] = ["prep", "pro"];
const TERMS: BillingTerm[] = ["monthly", "annual"];

/**
 * Every SKU priced in `requested`, or in dollars when that currency is not on
 * offer right now. `currency` in the result says which one the caller got.
 */
export async function priceListIn(requested: unknown, now = Date.now()): Promise<PriceList> {
  const base = config.proPlanCurrency;
  const wanted = typeof requested === "string" ? requested.trim().toUpperCase() : base;
  const rates = await usableRates(now);
  const usdRate = rates.get(wanted);
  const currency = usdRate === undefined ? base : wanted;
  return {
    currency,
    currencies: [base, ...rates.keys()],
    catalog: PLANS.flatMap((plan) =>
      TERMS.map((term): PricedSku => {
        const price = resolvePlanPrice(plan, term);
        if (usdRate === undefined) return { ...price, purchasable: isPurchasable(plan, term) };
        return {
          ...price,
          amount: convertFromUsd(price.amount, usdRate, currency),
          currency,
          purchasable: isPurchasable(plan, term),
          baseAmount: price.amount,
          baseCurrency: price.currency,
        };
      }),
    ),
  };
}

/**
 * What checkout charges for one SKU in `currency`, from the same rate the
 * pricing page shows. Null when that currency is not on offer right now.
 */
export async function checkoutPrice(
  plan: PaidPlan,
  term: BillingTerm,
  currency: string,
  now = Date.now(),
): Promise<ResolvedPrice | null> {
  const price = resolvePlanPrice(plan, term);
  if (currency === price.currency) return price;
  const usdRate = (await usableRates(now)).get(currency);
  if (usdRate === undefined) return null;
  return { ...price, amount: convertFromUsd(price.amount, usdRate, currency), currency };
}
