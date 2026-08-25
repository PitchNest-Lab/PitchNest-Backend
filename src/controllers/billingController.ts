import { Request, Response } from "express";
import {
  config,
  hasBillingConfig,
  resolvePlanPrice,
  listBillingCatalog,
  isPaidPlan,
  isBillingTerm,
  type PaidPlan,
  type BillingTerm,
} from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  createCheckout,
  verifyTransaction,
  verifyWebhookSignature,
  grantAccess,
  markPaymentFailed,
} from "../services/flutterwaveService.ts";

/**
 * The featured price (Pro, monthly) plus the full purchasable catalog.
 *
 * `price` is kept for backward-compatibility with surfaces that render a single
 * headline number; `catalog` lists every (plan, term) SKU the checkout will
 * honour. Both come from the same server-side resolver, so display can never
 * drift from what is charged.
 */
function pricingPayload() {
  const featured = resolvePlanPrice("pro", "monthly");
  return {
    price: {
      amount: featured.amount,
      currency: featured.currency,
      days: featured.days,
    },
    catalog: listBillingCatalog(),
  };
}

/**
 * Parses the requested SKU from a checkout request body, defaulting to the
 * headline Pro monthly. Anything unrecognised falls back rather than 400-ing, so
 * a stale client can still buy the default plan.
 */
function parseSelection(body: any): { plan: PaidPlan; term: BillingTerm } {
  const plan: PaidPlan = isPaidPlan(body?.plan) ? body.plan : "pro";
  const term: BillingTerm = isBillingTerm(body?.term) ? body.term : "monthly";
  return { plan, term };
}

/**
 * GET /api/billing/price — public price + purchasable catalog. No user data.
 */
export const getPrice = async (_req: Request, res: Response) => {
  try {
    res.json({
      billingEnabled: hasBillingConfig(),
      ...pricingPayload(),
    });
  } catch (err: any) {
    console.error("❌ getPrice:", err?.message || err);
    res.status(500).json({ error: "Failed to load price" });
  }
};

/**
 * GET /api/billing/plan — user plan status and location-aware pricing.
 */
import { isTrialActive } from "../services/entitlementService.ts";

export const getPlan = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    let { data: user } = await supabase
      .from("users")
      .select("plan, plan_expires_at, trial_started_at, trial_expires_at, trial_status")
      .eq("id", userId)
      .maybeSingle();

    let expiry = (user as any)?.plan_expires_at
      ? new Date((user as any).plan_expires_at)
      : null;
    // A paid level (prep or pro) counts as active until its period passes.
    // A null expiry means "never expires" (comped / grandfathered).
    const isPaidActive = (plan: unknown, e: Date | null) =>
      (plan === "prep" || plan === "pro" || plan === "founder") && (!e || e.getTime() > Date.now());
    let active = isPaidActive((user as any)?.plan, expiry);

    // In local development, webhooks from the internet cannot reach localhost.
    // Auto-verify recent pending transactions against Flutterwave so local test checkouts turn Pro instantly.
    if (!active && config.nodeEnv === "development") {
      try {
        const { data: pendingPayments } = await supabase
          .from("payments")
          .select("tx_ref")
          .eq("user_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(3);

        if (pendingPayments && pendingPayments.length > 0) {
          for (const pay of pendingPayments) {
            const verified = await verifyTransaction(pay.tx_ref);
            if (verified && (verified.status === "successful" || verified.status === "succeeded")) {
              await grantAccess(verified);
              console.log(`✅ [Dev Auto-Sync] Verified local test transaction ${pay.tx_ref} — granted Pro access!`);

              // Refresh user status
              const { data: updatedUser } = await supabase
                .from("users")
                .select("plan, plan_expires_at, trial_started_at, trial_expires_at, trial_status")
                .eq("id", userId)
                .maybeSingle();

              if (updatedUser) {
                user = updatedUser;
                expiry = (user as any)?.plan_expires_at ? new Date((user as any).plan_expires_at) : null;
                active = isPaidActive((user as any)?.plan, expiry);
              }
              break;
            }
          }
        }
      } catch (devErr: any) {
        console.warn("⚠️ Dev auto-sync check:", devErr?.message || devErr);
      }
    }

    const trial = isTrialActive((user as any)?.trial_expires_at, (user as any)?.trial_status);
    const effectivePlan = active ? ((user as any).plan as string) : (trial.active ? "pro" : "free");

    res.json({
      plan: effectivePlan,
      expiresAt: active && expiry ? expiry.toISOString() : null,
      isTrial: trial.active,
      trialDaysRemaining: trial.daysRemaining,
      trialExpiresAt: (user as any)?.trial_expires_at ? new Date((user as any).trial_expires_at).toISOString() : null,
      billingEnabled: hasBillingConfig(),
      ...pricingPayload(),
    });
  } catch (err: any) {
    console.error("❌ getPlan:", err?.message || err);
    res.status(500).json({ error: "Failed to load plan" });
  }
};

/**
 * POST /api/billing/checkout — start a purchase of a specific SKU.
 *
 * The body may name `plan` ("prep" | "pro") and `term` ("monthly" | "annual");
 * both default to the headline Pro monthly and unrecognised values fall back
 * rather than erroring, so a stale client still works. The PRICE for the SKU is
 * resolved server-side inside createCheckout — the body never carries an amount.
 */
export const startCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    if (!hasBillingConfig()) {
      return res.status(503).json({
        error: "billing_unavailable",
        message: "Online payment isn't available right now. Please contact support.",
      });
    }

    const { data: user } = await supabase
      .from("users")
      .select("id, email, name, plan, plan_expires_at")
      .eq("id", userId)
      .maybeSingle();

    if (!user) return res.status(404).json({ error: "User not found" });

    // Unlimited (comped) access has nothing to buy, and paying would replace it
    // with a dated period (see grant_pro_access downgrade guard).
    if ((user as any).plan === "pro" && !(user as any).plan_expires_at) {
      return res.status(409).json({
        error: "already_pro",
        message: "Your account already has full access.",
      });
    }

    const selection = parseSelection(req.body);

    const session = await createCheckout(
      {
        id: (user as any).id,
        email: (user as any).email,
        name: (user as any).name,
      },
      selection,
    );

    res.json({ paymentLink: session.paymentLink, txRef: session.txRef });
  } catch (err: any) {
    // createCheckout throws a CheckoutError carrying a machine `code` and a
    // log-only `detail`. Map the code to a status and a client-safe `reason` so
    // the operator can tell WHICH failure this is from logs alone, without ever
    // leaking a raw provider/DB message to the browser.
    const code: string = err?.code ?? "UNKNOWN";
    const status =
      code === "BILLING_NOT_CONFIGURED" ? 503 :
      code === "PAYMENT_RECORD_FAILED" ? 500 :
      502; // CHECKOUT_INIT_FAILED and anything unexpected: upstream/transient.

    // `reason` is a stable machine tag the client MAY branch on; `message` stays
    // the same friendly text. Neither carries `err.detail`, which is log-only.
    const reason =
      code === "BILLING_NOT_CONFIGURED" ? "billing_unavailable" :
      code === "PAYMENT_RECORD_FAILED" ? "record_failed" :
      code === "CHECKOUT_INIT_FAILED" ? "provider_rejected" :
      "unknown";

    console.error(
      `❌ startCheckout: ${code}${err?.detail ? ` — ${err.detail}` : ""}`,
    );
    res.status(status).json({
      error: "checkout_failed",
      reason,
      message: "Couldn't start checkout. Please try again.",
    });
  }
};

/**
 * POST /api/billing/webhook — the ONLY path that grants paid access.
 *
 * Mounted with express.raw ABOVE the global express.json in app.ts. Two rules
 * this handler must never break:
 *
 *  1. Verify the `verif-hash` header before doing anything else. The URL is
 *     public; without this, anyone who finds it can grant themselves Pro.
 *  2. Re-query Flutterwave rather than trusting the posted body. A verified
 *     header proves the sender, not the contents.
 *
 * Always answers 200 once authenticated, even on internal failure: a non-2xx
 * makes Flutterwave retry, and retrying will not fix a bug on our side. Real
 * problems are logged loudly instead.
 */
export const handleWebhook = async (req: Request, res: Response) => {
  if (!verifyWebhookSignature(req.headers["verif-hash"])) {
    console.warn("🚫 Rejected billing webhook: bad or missing verif-hash");
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload: any;
  try {
    // req.body is a Buffer here (express.raw), deliberately: parsing before
    // verification would mean acting on unauthenticated input.
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    console.warn("🚫 Billing webhook: unparseable body");
    return res.status(400).json({ error: "invalid payload" });
  }

  // Acknowledge immediately — Flutterwave times out at 60s, and settling can
  // involve two network round trips.
  res.status(200).json({ received: true });

  try {
    const data = payload?.data ?? {};
    const claimedTxRef: string | undefined = data.tx_ref;
    const transactionId = data.id;

    if (!transactionId) {
      console.warn("⚠️ Billing webhook carried no transaction id; ignoring.");
      return;
    }

    // The authoritative check. Everything below acts on `verified`, never on the
    // posted body — a valid header proves who sent the request, not that its
    // contents are true. In particular the earlier version marked payments
    // failed straight from the payload, which let anyone holding the shared hash
    // (e.g. another integration on the same Flutterwave account) flip arbitrary
    // pending rows to failed by naming their tx_ref.
    const verified = await verifyTransaction(transactionId);
    if (!verified) {
      console.error(
        `❌ Could not verify transaction ${transactionId} (claimed ref ${claimedTxRef ?? "none"}); NOT granting.`,
      );
      return;
    }

    if (verified.status !== "successful" && verified.status !== "succeeded") {
      console.log(`ℹ️ Transaction ${verified.txRef} verified as '${verified.status}'; not granting.`);
      await markPaymentFailed(verified.txRef);
      return;
    }

    // Guard against a mismatched or short payment: a webhook could reference a
    // real but cheaper transaction. Compare against what we recorded at
    // checkout, not against the payload.
    const { data: expected } = await supabase
      .from("payments")
      .select("amount, currency")
      .eq("tx_ref", verified.txRef)
      .maybeSingle();

    if (expected) {
      const shortPaid = Number(verified.amount) < Number((expected as any).amount);
      const wrongCurrency =
        String((expected as any).currency).toUpperCase() !== verified.currency.toUpperCase();
      if (shortPaid || wrongCurrency) {
        console.error(
          `❌ Payment mismatch for ${verified.txRef}: expected ${(expected as any).amount} ${(expected as any).currency}, got ${verified.amount} ${verified.currency}. NOT granting.`,
        );
        return;
      }
    }

    const granted = await grantAccess(verified);
    console.log(
      granted
        ? `✅ Pro granted for ${verified.txRef} (${verified.amount} ${verified.currency})`
        : `↩️ Webhook replay for ${verified.txRef} — already settled, no change.`,
    );
  } catch (err: any) {
    console.error("❌ Billing webhook processing failed:", err?.message || err);
  }
};
