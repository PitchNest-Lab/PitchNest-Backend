import crypto from "crypto";
import { config } from "../config/env.ts";
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

interface FxCacheItem {
  rate: number;
  expiresAt: number;
}
const fxRateCache: Record<string, FxCacheItem> = {};

/**
 * Fetches live FX exchange rate from Flutterwave or returns a fallback rate.
 * Caches exchange rates in memory for 15 minutes.
 */
export async function getFxRate(
  sourceCurrency: string,
  destinationCurrency: string,
  baseAmount: number = 1,
): Promise<number> {
  const source = sourceCurrency.trim().toUpperCase();
  const dest = destinationCurrency.trim().toUpperCase();

  if (source === dest) return 1;

  const cacheKey = `${source}_${dest}`;
  const now = Date.now();
  if (fxRateCache[cacheKey] && fxRateCache[cacheKey].expiresAt > now) {
    return fxRateCache[cacheKey].rate;
  }

  if (config.flutterwaveSecretKey) {
    try {
      const url = `${FLW_API}/transfers/rates?amount=${baseAmount}&source_currency=${source}&destination_currency=${dest}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.flutterwaveSecretKey}` },
      });
      const body: any = await res.json().catch(() => null);
      if (res.ok && body?.status === "success" && body?.data?.rate) {
        const rate = Number(body.data.rate);
        if (rate > 0) {
          fxRateCache[cacheKey] = {
            rate,
            expiresAt: now + 15 * 60 * 1000, // 15 min cache
          };
          return rate;
        }
      }
    } catch (err: any) {
      console.warn("⚠️ Live FX rate fetch failed, falling back to default:", err?.message || err);
    }
  }

  // Fallback static conversion rates if FX endpoint is unreachable or in dev without key
  const fallbackRates: Record<string, number> = {
    USD_NGN: 1500,
    USD_GHS: 15.5,
    USD_KES: 130,
    USD_UGX: 3700,
    USD_ZAR: 18.5,
    USD_EUR: 0.92,
    USD_GBP: 0.79,
  };

  const fallback = fallbackRates[cacheKey] || 1;
  fxRateCache[cacheKey] = { rate: fallback, expiresAt: now + 5 * 60 * 1000 };
  return fallback;
}

export interface RegionPricing {
  currency: string;
  amount: number;
  paymentOptions: string;
  baseAmountUsd: number;
  exchangeRate: number;
}

/**
 * Server-side region pricing resolution based on user location or currency preference.
 * Amount is ALWAYS computed server-side to prevent client-side price tampering.
 */
export async function getRegionPricing(
  countryCode?: string,
  requestedCurrency?: string,
): Promise<RegionPricing> {
  const baseUsd = config.proPlanAmount; // Default $10 USD
  const country = (countryCode || "").trim().toUpperCase();
  let currency = (requestedCurrency || "").trim().toUpperCase();

  if (!currency) {
    switch (country) {
      case "NG":
        currency = "NGN";
        break;
      case "GH":
        currency = "GHS";
        break;
      case "KE":
        currency = "KES";
        break;
      case "UG":
        currency = "UGX";
        break;
      case "ZA":
        currency = "ZAR";
        break;
      default:
        currency = config.proPlanCurrency || "USD";
        break;
    }
  }

  const rate = await getFxRate("USD", currency, baseUsd);
  let amount = baseUsd * rate;

  // Rounding rules: NGN, KES, UGX rounded to neat integer; GHS, USD, EUR, ZAR to 2 decimal places.
  if (["NGN", "KES", "UGX"].includes(currency)) {
    amount = Math.round(amount);
  } else {
    amount = Math.round(amount * 100) / 100;
  }

  const paymentOptions = getPaymentOptionsForCurrency(currency);

  return {
    currency,
    amount,
    paymentOptions,
    baseAmountUsd: baseUsd,
    exchangeRate: rate,
  };
}

/**
 * Maps a currency code to its supported Flutterwave payment options string.
 */
function getPaymentOptionsForCurrency(currency: string): string {
  const curr = (currency || "").trim().toUpperCase();
  switch (curr) {
    case "NGN":
      return "card,ussd,banktransfer,account,nqr,opay";
    case "GHS":
      return "card,ghanamobilemoney";
    case "KES":
      return "card,mpesa";
    case "UGX":
      return "card,mobilemoneyuganda";
    case "ZAR":
      return "card,eft";
    case "USD":
    case "EUR":
    case "GBP":
    default:
      return "card,account";
  }
}

/**
 * Creates a pending payment row and returns the hosted checkout link.
 *
 * The row is written BEFORE calling Flutterwave so the webhook always has a
 * reference to resolve. Amount and currency are computed SERVER-SIDE to prevent
 * client-side price tampering.
 */
export async function createCheckout(
  user: {
    id: number;
    email: string;
    name?: string | null;
  },
  preferences?: {
    countryCode?: string;
    currency?: string;
  },
): Promise<CheckoutSession> {
  if (!config.flutterwaveSecretKey) {
    throw new CheckoutError("BILLING_NOT_CONFIGURED");
  }

  const txRef = mintTxRef(user.id);
  const pricing = await getRegionPricing(preferences?.countryCode, preferences?.currency);
  const { amount, currency, paymentOptions } = pricing;

  const { error: insertErr } = await supabase.from("payments").insert([
    {
      user_id: user.id,
      tx_ref: txRef,
      provider: "flutterwave",
      status: "pending",
      amount,
      currency,
    },
  ]);
  if (insertErr) {
    console.error("❌ createCheckout: failed to record pending payment:", insertErr.message);
    throw new CheckoutError("PAYMENT_RECORD_FAILED", insertErr.message);
  }

  let res: Response;
  try {
    res = await fetch(`${FLW_API}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.flutterwaveSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: `${config.appBaseUrl}/billing/return`,
        customer: {
          email: user.email,
          name: user.name || undefined,
        },
        payment_options: paymentOptions,
        customizations: {
          title: "PitchNest Pro",
          description: `${config.proPlanDays} days of unlimited pitch sessions`,
        },
        meta: { user_id: user.id },
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
    const providerMsg = body?.message || `HTTP ${res.status}`;
    console.error("❌ Flutterwave payment init failed:", res.status, body);
    throw new CheckoutError("CHECKOUT_INIT_FAILED", providerMsg);
  }

  return { txRef, paymentLink: body.data.link };
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
  if (!config.flutterwaveSecretKey) return null;

  try {
    const isNumericId =
      typeof transactionIdOrRef === "number" ||
      (/^\d+$/.test(String(transactionIdOrRef)) && Number(transactionIdOrRef) < 2000000000);

    const url = isNumericId
      ? `${FLW_API}/transactions/${transactionIdOrRef}/verify`
      : `${FLW_API}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(String(transactionIdOrRef))}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.flutterwaveSecretKey}` },
    });
    const body: any = await res.json().catch(() => null);

    if (!res.ok || body?.status !== "success" || !body?.data) {
      return null;
    }

    const data = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!data) return null;

    return {
      status: String(data.status || "").toLowerCase(),
      txRef: data.tx_ref,
      amount: Number(data.amount),
      currency: String(data.currency || ""),
      providerRef: String(data.id),
    };
  } catch (err: any) {
    console.error("❌ verifyTransaction threw:", err?.message || err);
    return null;
  }
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
 * Settles a verified payment: marks it successful and extends the user's Pro
 * period, atomically.
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
    p_days: config.proPlanDays,
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

/** Marks a checkout attempt failed. Best-effort — never throws. */
export async function markPaymentFailed(txRef: string): Promise<void> {
  try {
    await supabase
      .from("payments")
      .update({ status: "failed", completed_at: new Date().toISOString() })
      .eq("tx_ref", txRef)
      .eq("status", "pending");
  } catch (err: any) {
    console.warn("⚠️ markPaymentFailed:", err?.message || err);
  }
}
