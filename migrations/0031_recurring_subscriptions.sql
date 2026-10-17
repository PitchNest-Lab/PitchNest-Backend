-- Auto-renewing subscriptions on Flutterwave payment plans.
-- Depends on 0030 (settlement invariants and the current grant_pro_access).
--
--   * billing_provider_plans caches the Flutterwave payment plan created for
--     each (plan, term, amount, currency). A price change makes a new row, so a
--     subscriber keeps renewing at the price they signed up for.
--   * subscriptions holds one row per subscription we started. At most one is
--     active per user. Starting a new one retires the old row and marks it
--     provider_cancel_pending until Flutterwave confirms the cancel, so a plan
--     switch can never leave two renewals charging the same card.
--   * payments.kind separates the first subscription charge from renewals and
--     from legacy one-off purchases. bonus_days records the free month given on
--     a first subscription; it is already included in granted_days.
--
-- Access is still granted only by grant_pro_access on a verified payment, and
-- entitlement still reads users.plan_expires_at. A subscription row never
-- grants anything by itself.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_provider_plans (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  plan TEXT NOT NULL CHECK (plan IN ('prep', 'pro')),
  term TEXT NOT NULL CHECK (term IN ('monthly', 'annual')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_plan_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_provider_plans_sku UNIQUE (provider, plan, term, amount, currency)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  plan TEXT NOT NULL CHECK (plan IN ('prep', 'pro')),
  term TEXT NOT NULL CHECK (term IN ('monthly', 'annual')),
  -- The recurring charge renewals are checked against.
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_plan_id BIGINT NOT NULL,
  -- Learned from Flutterwave after the first charge; needed to cancel.
  provider_subscription_id BIGINT,
  -- Flutterwave binds a subscription to the email used at checkout.
  customer_email TEXT NOT NULL,
  initial_tx_ref TEXT NOT NULL UNIQUE REFERENCES payments(tx_ref) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  provider_cancel_pending BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user
  ON subscriptions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_cancel_pending
  ON subscriptions (user_id) WHERE provider_cancel_pending;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'one_time',
  ADD COLUMN IF NOT EXISTS provider_plan_id BIGINT,
  ADD COLUMN IF NOT EXISTS bonus_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_values;
ALTER TABLE payments ADD CONSTRAINT payments_kind_values
  CHECK (kind IN ('one_time', 'subscription_initial', 'subscription_renewal'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bonus_days_range;
ALTER TABLE payments ADD CONSTRAINT payments_bonus_days_range
  CHECK (bonus_days BETWEEN 0 AND 400);

CREATE INDEX IF NOT EXISTS idx_payments_user_settled
  ON payments (user_id) WHERE status = 'successful';

-- Records the subscription a settled first charge started, retiring any
-- earlier one. Idempotent: a webhook replay returns the same subscription.
CREATE OR REPLACE FUNCTION start_subscription_from_payment(
  p_tx_ref TEXT,
  p_customer_email TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_amount NUMERIC(12, 2);
  v_id UUID;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE tx_ref = p_tx_ref FOR UPDATE;
  IF NOT FOUND
     OR v_payment.status <> 'successful'
     OR v_payment.kind <> 'subscription_initial'
     OR v_payment.provider_plan_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_payment.subscription_id IS NOT NULL THEN
    RETURN v_payment.subscription_id;
  END IF;
  IF p_customer_email IS NULL OR LENGTH(TRIM(p_customer_email)) = 0 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_EMAIL_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The plan's recurring price, not the first charge (which may differ).
  SELECT amount INTO v_amount
    FROM billing_provider_plans
   WHERE provider = v_payment.provider
     AND provider_plan_id = v_payment.provider_plan_id
   ORDER BY id DESC
   LIMIT 1;
  IF v_amount IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PROVIDER_PLAN' USING ERRCODE = '23503';
  END IF;

  UPDATE subscriptions
     SET status = 'cancelled',
         cancelled_at = NOW(),
         provider_cancel_pending = TRUE,
         updated_at = NOW()
   WHERE user_id = v_payment.user_id
     AND status = 'active';

  INSERT INTO subscriptions (
    user_id, provider, plan, term, amount, currency,
    provider_plan_id, customer_email, initial_tx_ref
  )
  VALUES (
    v_payment.user_id, v_payment.provider, v_payment.plan, v_payment.term,
    v_amount, UPPER(v_payment.currency), v_payment.provider_plan_id,
    LOWER(TRIM(p_customer_email)), v_payment.tx_ref
  )
  ON CONFLICT (initial_tx_ref) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM subscriptions WHERE initial_tx_ref = v_payment.tx_ref;
  END IF;

  UPDATE payments SET subscription_id = v_id WHERE id = v_payment.id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION start_subscription_from_payment(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION start_subscription_from_payment(TEXT, TEXT) TO service_role;

ALTER TABLE billing_provider_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_provider_plans_deny_direct" ON billing_provider_plans;
CREATE POLICY "billing_provider_plans_deny_direct" ON billing_provider_plans
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "subscriptions_deny_direct" ON subscriptions;
CREATE POLICY "subscriptions_deny_direct" ON subscriptions
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0031', 'Auto-renewing subscriptions on Flutterwave payment plans')
ON CONFLICT (version) DO NOTHING;

COMMIT;
