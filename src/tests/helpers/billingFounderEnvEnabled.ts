import { applyBillingEnv } from "./billingEnv.ts";

applyBillingEnv("true");
process.env.BILLING_PURCHASABLE_SKUS = "pro:monthly,prep:monthly";
