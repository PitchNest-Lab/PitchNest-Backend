import { Request, Response } from "express";
import { config, hasBillingConfig } from "../config/env.ts";
import { supabase } from "../config/supabase.ts";
import {
  createCheckout,
  verifyTransaction,
  verifyWebhookSignature,
  grantAccess,
  markPaymentFailed,
} from "../services/flutterwaveService.ts";

/**
 * GET /api/billing/price — public Pro price.
 *
 * The landing page and /pricing are public, so the price cannot live behind
 * authMiddleware. This endpoint returns the config price and nothing else —
 * no plan, no user data.
 */
export const getPrice = async (_req: Request, res: Response) => {
  try {
    res.json({
      billingEnabled: hasBillingConfig(),
      price: {
        amount: config.proPlanAmount,
        currency: config.proPlanCurrency,
        days: config.proPlanDays,
      },
    });
  } catch (err: any) {
    console.error("❌ getPrice:", err?.message || err);
    res.status(500).json({ error: "Failed to load price" });
  }
};

/**
 * GET /api/billing/plan — what this user is on, and what Pro costs.
 *
 * The price lives in config, so the pricing UI never hardcodes an amount that
 * could drift from what the checkout actually charges.
 */
export const getPlan = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const { data: user } = await supabase
      .from("users")
      .select("plan, plan_expires_at")
      .eq("id", userId)
      .maybeSingle();

    const expiry = (user as any)?.plan_expires_at
      ? new Date((user as any).plan_expires_at)
      : null;
    const active =
      (user as any)?.plan === "pro" && (!expiry || expiry.getTime() > Date.now());

    res.json({
      plan: active ? "pro" : "free",
      expiresAt: active && expiry ? expiry.toISOString() : null,
      billingEnabled: hasBillingConfig(),
      price: {
        amount: config.proPlanAmount,
        currency: config.proPlanCurrency,
        days: config.proPlanDays,
      },
    });
  } catch (err: any) {
    console.error("❌ getPlan:", err?.message || err);
    res.status(500).json({ error: "Failed to load plan" });
  }
};

/**
 * POST /api/billing/checkout — start a Pro purchase.
 *
 * Returns a hosted Flutterwave link for the client to redirect to. Grants
 * nothing: entitlement comes only from the webhook.
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

    // Someone on unlimited comped access has nothing to buy, and charging them
    // would replace that with a 30-day window (see grant_pro_access).
    if ((user as any).plan === "pro" && !(user as any).plan_expires_at) {
      return res.status(409).json({
        error: "already_pro",
        message: "Your account already has full access.",
      });
    }

    const session = await createCheckout({
      id: (user as any).id,
      email: (user as any).email,
      name: (user as any).name,
    });

    res.json({ paymentLink: session.paymentLink, txRef: session.txRef });
  } catch (err: any) {
    const code = err?.message === "BILLING_NOT_CONFIGURED" ? 503 : 502;
    console.error("❌ startCheckout:", err?.message || err);
    res.status(code).json({
      error: "checkout_failed",
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
