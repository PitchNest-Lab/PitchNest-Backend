/**
 * Billing test environment. Values are dummies, never real Flutterwave keys.
 *
 * config/env.ts reads process.env once, when first imported, so the switch
 * state is chosen by WHICH helper a test file imports (right after
 * testEnv.ts and before anything that loads config/env.ts):
 *   - billingEnvKeysOnly.ts  → keys present, BILLING_CHECKOUT_ENABLED="false"
 *   - billingEnvEnabled.ts   → keys present, BILLING_CHECKOUT_ENABLED="true"
 */
export const DUMMY_FLW_SECRET = "FLWSECK_TEST-dummy-not-a-real-key-X";
export const DUMMY_FLW_HASH = "dummy-webhook-hash-for-tests";

export function applyBillingEnv(checkoutSwitch: string | undefined): void {
  process.env.FLW_SECRET_KEY = DUMMY_FLW_SECRET;
  process.env.FLW_WEBHOOK_HASH = DUMMY_FLW_HASH;
  process.env.PRO_PLAN_AMOUNT = "10";
  process.env.PRO_PLAN_CURRENCY = "USD";
  process.env.PRO_PLAN_DAYS = "30";
  // No first-subscription bonus here, so a checkout grants exactly one period.
  // The free-month offer has its own coverage in subscription_billing_test.ts.
  process.env.FIRST_SUBSCRIPTION_FREE_MONTHS = "0";
  if (checkoutSwitch === undefined) delete process.env.BILLING_CHECKOUT_ENABLED;
  else process.env.BILLING_CHECKOUT_ENABLED = checkoutSwitch;
}
