import { Request, Response } from "express";
import {
  config,
  hasBillingConfig,
  resolvePlanPrice,
  listBillingCatalog,
  isPaidPlan,
  isBillingTerm,
  isPurchasable,
  type PaidPlan,
  type BillingTerm,
} from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  createCheckout,
  isCheckoutTxRef,
  verifyTransaction,
  verifyTransactionDetails,
  verifyWebhookSignature,
  grantAccess,
  markPaymentFailed,
} from "../services/flutterwaveService.ts";
import {
  cancelUserSubscription,
  ensureProviderPlan,
  getActiveSubscription,
  handleProviderCancellation,
  initialGrantDays,
  offerFor,
  retryPendingProviderCancels,
  settleRenewal,
  startSubscriptionAfterPayment,
  subscriptionViewFor,
  SubscriptionError,
} from "../services/subscriptionService.ts";

/**
 * The featured price (Pro, monthly) plus the full purchasable catalog.
 *
 * `price` is kept for backward-compatibility with surfaces that render a single
 * headline number; `catalog` lists every (plan, term) SKU the checkout will
 * honour. Both come from the same server-side resolver, so display can never
 * drift from what is charged. `offer.freeMonths` is what a first subscription
 * adds on top, so the pricing page can only promise what checkout records.
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
    offer: { freeMonths: config.firstSubscriptionFreeMonths },
  };
}

const PLAN_RANK: Record<string, number> = { prep: 1, pro: 2, founder: 3, enterprise: 4 };

/**
 * Parses the requested SKU from a checkout request body. Omitted fields default
 * to Pro monthly; explicit unknown values are rejected rather than silently
 * charging the caller for a different product.
 */
function parseSelection(body: any): { plan: PaidPlan; term: BillingTerm } | null {
  const rawPlan = body?.plan;
  const rawTerm = body?.term;
  if (rawPlan !== undefined && !isPaidPlan(rawPlan)) return null;
  if (rawTerm !== undefined && !isBillingTerm(rawTerm)) return null;
  return { plan: rawPlan ?? "pro", term: rawTerm ?? "monthly" };
}

/**
 * GET /api/billing/price — public price + purchasable catalog. No user data.
 */
export const getPrice = async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
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

    let { data: user, error: userError } = await supabase
      .from("users")
      .select("plan, plan_expires_at, trial_started_at, trial_expires_at, trial_status")
      .eq("id", userId)
      .maybeSingle();
    if (userError) {
      console.error("Plan lookup failed:", userError.message);
      return res.status(503).json({ error: "Plan status is temporarily unavailable." });
    }
    if (!user) return res.status(404).json({ error: "User not found" });

    let expiry = (user as any)?.plan_expires_at
      ? new Date((user as any).plan_expires_at)
      : null;
    // A paid level (prep or pro) counts as active until its period passes.
    // A null expiry means "never expires" (comped / grandfathered).
    const isPaidActive = (plan: unknown, e: Date | null) =>
      (plan === "prep" || plan === "pro" || plan === "founder" || plan === "enterprise") &&
      (!e || e.getTime() > Date.now());
    let active = isPaidActive((user as any)?.plan, expiry);

    // In local development, webhooks from the internet cannot reach localhost.
    // Auto-verify recent pending transactions against Flutterwave so local test checkouts turn Pro instantly.
    if (!active && config.nodeEnv === "development") {
      try {
        const { data: pendingPayments } = await supabase
          .from("payments")
          .select("tx_ref, kind")
          .eq("user_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(3);

        if (pendingPayments && pendingPayments.length > 0) {
          for (const pay of pendingPayments) {
            const verified = await verifyTransaction(pay.tx_ref);
            if (verified && (verified.status === "successful" || verified.status === "succeeded")) {
              await grantAccess(verified);
              if ((pay as any).kind === "subscription_initial") {
                await startSubscriptionAfterPayment(pay.tx_ref, userId, null);
              }
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

    const trial = isTrialActive((user as any)?.trial_expires_at, (user as any)?.trial_status, (user as any)?.trial_started_at);
    const effectivePlan = active ? ((user as any).plan as string) : (trial.active ? "pro" : "free");
    const unlimited = active && !expiry;

    // A plan switch or an earlier failed cancel can leave a retired renewal
    // still live at Flutterwave; every plan read is a chance to finish it.
    if (hasBillingConfig()) await retryPendingProviderCancels(userId);

    let subscription = null;
    let offer = { freeMonths: config.firstSubscriptionFreeMonths, eligible: false };
    try {
      [subscription, offer] = await Promise.all([subscriptionViewFor(userId), offerFor(userId, unlimited)]);
    } catch (lookupError: any) {
      // Plan status still answers; the extras are simply not offered.
      console.error("Subscription lookup failed:", lookupError?.message || lookupError);
    }

    res.json({
      plan: effectivePlan,
      expiresAt: active && expiry ? expiry.toISOString() : null,
      isTrial: trial.active,
      trialDaysRemaining: trial.daysRemaining,
      trialExpiresAt: (user as any)?.trial_expires_at ? new Date((user as any).trial_expires_at).toISOString() : null,
      billingEnabled: hasBillingConfig(),
      subscription,
      ...pricingPayload(),
      offer,
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
 * both default to the headline Pro monthly when omitted. The PRICE for the SKU is
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

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, name, plan, plan_expires_at")
      .eq("id", userId)
      .maybeSingle();

    if (userError) {
      console.error("Checkout user lookup failed:", userError.message);
      return res.status(503).json({ error: "Checkout is temporarily unavailable." });
    }
    if (!user) return res.status(404).json({ error: "User not found" });

    // Unlimited (comped) access has nothing to buy, and paying would replace it
    // with a dated period (see grant_pro_access downgrade guard).
    if (
      ["prep", "pro", "founder", "enterprise"].includes(String((user as any).plan)) &&
      !(user as any).plan_expires_at
    ) {
      return res.status(409).json({
        error: "already_pro",
        message: "Your account already has full access.",
      });
    }

    const selection = parseSelection(req.body);
    if (!selection) {
      return res.status(400).json({ error: "Please choose a valid plan and billing term." });
    }
    if (!isPurchasable(selection.plan, selection.term)) {
      return res.status(400).json({
        error: "plan_not_available",
        message: "That plan isn't available to buy yet.",
      });
    }

    let current: Awaited<ReturnType<typeof getActiveSubscription>>;
    let offer: Awaited<ReturnType<typeof offerFor>>;
    try {
      [current, offer] = await Promise.all([getActiveSubscription(userId), offerFor(userId, false)]);
    } catch (lookupError: any) {
      console.error("Checkout subscription lookup failed:", lookupError?.message || lookupError);
      return res.status(503).json({ error: "Checkout is temporarily unavailable." });
    }

    if (current && current.plan === selection.plan && current.term === selection.term) {
      return res.status(409).json({
        error: "already_subscribed",
        message: "You're already subscribed to this plan.",
      });
    }

    // Paid access stacks by rank (grant_pro_access keeps the higher plan), so a
    // cheaper plan bought now would renew at the lower price while the higher
    // one keeps applying. Moving down waits until the current period ends.
    const expiry = (user as any).plan_expires_at ? new Date((user as any).plan_expires_at) : null;
    const currentRank = expiry && expiry.getTime() > Date.now() ? PLAN_RANK[String((user as any).plan)] ?? 0 : 0;
    if (currentRank > (PLAN_RANK[selection.plan] ?? 0)) {
      return res.status(409).json({
        error: "downgrade_unavailable",
        message: "Cancel your current plan first. You can switch once its paid period ends.",
      });
    }

    const paymentPlanId = await ensureProviderPlan(selection.plan, selection.term);
    const freeMonths = offer.eligible ? offer.freeMonths : 0;
    const now = new Date();
    const grantedDays = initialGrantDays(selection.term, freeMonths, now);
    const bonusDays = grantedDays - initialGrantDays(selection.term, 0, now);

    const session = await createCheckout(
      {
        id: (user as any).id,
        email: (user as any).email,
        name: (user as any).name,
      },
      selection,
      { paymentPlanId, grantedDays, bonusDays },
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
      code === "PLAN_NOT_AVAILABLE" ? 400 :
      code === "PAYMENT_RECORD_FAILED" ? 500 :
      502; // CHECKOUT_INIT_FAILED and anything unexpected: upstream/transient.

    // `reason` is a stable machine tag the client MAY branch on; `message` stays
    // the same friendly text. Neither carries `err.detail`, which is log-only.
    const reason =
      code === "BILLING_NOT_CONFIGURED" ? "billing_unavailable" :
      code === "PLAN_NOT_AVAILABLE" ? "plan_not_available" :
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
 * The provider is acknowledged only after durable settlement. Transient
 * provider/database failures return 503 so Flutterwave retries instead of a
 * paid entitlement being lost after an early 200 response.
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

  try {
    const event = String(payload?.event ?? payload?.["event.type"] ?? "").toLowerCase();
    const data = payload?.data ?? {};

    // Flutterwave stopped renewals (cancelled from its reminder email, or after
    // failed charges). Re-checked against the API before anything changes.
    if (event === "subscription.cancelled") {
      const outcome = await handleProviderCancellation(data);
      return res.status(200).json({ received: true, outcome });
    }

    const claimedTxRef: string | undefined = data.tx_ref;
    const transactionId = Number(data.id);

    if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
      console.warn("⚠️ Billing webhook carried no transaction id; ignoring.");
      return res.status(200).json({ received: true, ignored: true });
    }

    // The authoritative check. Everything below acts on `verified`, never on the
    // posted body — a valid header proves who sent the request, not that its
    // contents are true. In particular the earlier version marked payments
    // failed straight from the payload, which let anyone holding the shared hash
    // (e.g. another integration on the same Flutterwave account) flip arbitrary
    // pending rows to failed by naming their tx_ref.
    const verified = await verifyTransactionDetails(transactionId);
    if (!verified) {
      console.error(
        `❌ Could not verify transaction ${transactionId} (claimed ref ${claimedTxRef ?? "none"}); NOT granting.`,
      );
      return res.status(503).json({ error: "verification unavailable" });
    }

    const ours = isCheckoutTxRef(verified.txRef);
    if (verified.status !== "successful" && verified.status !== "succeeded") {
      console.log(`ℹ️ Transaction ${verified.txRef} verified as '${verified.status}'; not granting.`);
      if (ours) await markPaymentFailed(verified.txRef);
      return res.status(200).json({ received: true });
    }

    // Guard against a mismatched or short payment: a webhook could reference a
    // real but cheaper transaction. Compare against what we recorded at
    // checkout, not against the payload.
    const { data: expected, error: expectedError } = ours
      ? await supabase
          .from("payments")
          .select("user_id, amount, currency, status, provider_ref, kind")
          .eq("tx_ref", verified.txRef)
          .maybeSingle()
      : { data: null, error: null };

    if (expectedError) {
      console.error(`❌ Payment lookup failed for ${verified.txRef}:`, expectedError.message);
      return res.status(503).json({ error: "settlement unavailable" });
    }

    // Not a checkout we started, or a second charge on one we already settled:
    // a renewal Flutterwave raised for a subscription.
    const settledEarlier =
      expected && (expected as any).status === "successful" &&
      String((expected as any).provider_ref ?? "") !== verified.providerRef;
    if (!expected || settledEarlier) {
      const outcome = await settleRenewal(verified, expected ? Number((expected as any).user_id) : null);
      console.log(`↻ Renewal ${verified.providerRef}: ${outcome}`);
      return res.status(200).json({ received: true, outcome });
    }

    const shortPaid = Number(verified.amount) < Number((expected as any).amount);
    const wrongCurrency =
      String((expected as any).currency).toUpperCase() !== verified.currency.toUpperCase();
    if (shortPaid || wrongCurrency) {
      console.error(
        `❌ Payment mismatch for ${verified.txRef}: expected ${(expected as any).amount} ${(expected as any).currency}, got ${verified.amount} ${verified.currency}. NOT granting.`,
      );
      await markPaymentFailed(verified.txRef);
      return res.status(200).json({ received: true, rejected: true });
    }

    const granted = await grantAccess(verified);
    // Also on a replay: recording the subscription is idempotent, and this
    // finishes the job if the first delivery failed after granting.
    if ((expected as any).kind === "subscription_initial") {
      await startSubscriptionAfterPayment(verified.txRef, Number((expected as any).user_id), verified.customerEmail);
    }
    console.log(
      granted
        ? `✅ Pro granted for ${verified.txRef} (${verified.amount} ${verified.currency})`
        : `↩️ Webhook replay for ${verified.txRef} — already settled, no change.`,
    );
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error("❌ Billing webhook processing failed:", err?.message || err);
    return res.status(503).json({ error: "settlement unavailable" });
  }
};

/**
 * POST /api/billing/subscription/cancel — turn off auto-renew.
 *
 * Only future charges stop. What the user has already paid for runs to the end
 * of its period, so this never touches users.plan_expires_at.
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Authentication required" });
  if (!hasBillingConfig()) {
    return res.status(503).json({ error: "Billing is unavailable right now. Please contact support." });
  }

  try {
    const subscription = await cancelUserSubscription(userId);
    return res.json({ subscription });
  } catch (err: any) {
    if (err instanceof SubscriptionError && err.code === "NO_SUBSCRIPTION") {
      return res.status(404).json({ error: "You don't have a plan that renews." });
    }
    if (err instanceof SubscriptionError) {
      return res.status(502).json({ error: "Couldn't reach the payment provider. Please try again in a moment." });
    }
    console.error("❌ cancelSubscription:", err?.message || err);
    return res.status(500).json({ error: "Couldn't cancel right now. Please try again." });
  }
};
