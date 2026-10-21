-- Billing modes and durable renewal state.
-- Depends on 0031 (recurring subscriptions) and 0035 (shared FX rates).
--
-- Automatic renewal uses Flutterwave payment plans and is card-only. Manual
-- renewal is a normal one-time hosted checkout, so its subscription has no
-- provider plan and can use the payment methods enabled for its currency.

BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'auto_renew';

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_billing_mode_values;
ALTER TABLE payments ADD CONSTRAINT payments_billing_mode_values
  CHECK (billing_mode IN ('auto_renew', 'manual'));

ALTER TABLE subscriptions
  ALTER COLUMN provider_plan_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'auto_renew',
  ADD COLUMN IF NOT EXISTS next_charge_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_status TEXT,
  ADD COLUMN IF NOT EXISTS last_payment_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renewal_failure_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_billing_mode_values;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_mode_values
  CHECK (billing_mode IN ('auto_renew', 'manual'));
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_last_payment_status_values;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_last_payment_status_values
  CHECK (last_payment_status IS NULL OR last_payment_status IN ('pending', 'successful', 'failed'));
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_renewal_failure_count_range;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_renewal_failure_count_range
  CHECK (renewal_failure_count >= 0);

CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal_status
  ON subscriptions (status, billing_mode, next_charge_at);

-- Extend the automatic path with the persisted mode and renewal state.
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
     OR v_payment.provider_plan_id IS NULL
     OR v_payment.billing_mode <> 'auto_renew' THEN
    RETURN NULL;
  END IF;
  IF v_payment.subscription_id IS NOT NULL THEN
    RETURN v_payment.subscription_id;
  END IF;
  IF p_customer_email IS NULL OR LENGTH(TRIM(p_customer_email)) = 0 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_EMAIL_REQUIRED' USING ERRCODE = '22023';
  END IF;

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
    provider_plan_id, customer_email, initial_tx_ref,
    billing_mode, next_charge_at, last_payment_status, last_payment_attempt_at
  )
  VALUES (
    v_payment.user_id, v_payment.provider, v_payment.plan, v_payment.term,
    v_amount, UPPER(v_payment.currency), v_payment.provider_plan_id,
    LOWER(TRIM(p_customer_email)), v_payment.tx_ref,
    'auto_renew',
    CASE WHEN v_payment.term = 'annual' THEN NOW() + INTERVAL '1 year' ELSE NOW() + INTERVAL '1 month' END,
    'successful', NOW()
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

-- Manual checkout has no provider subscription to discover or cancel.
CREATE OR REPLACE FUNCTION start_manual_subscription_from_payment(
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
  v_id UUID;
  v_expires_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE tx_ref = p_tx_ref FOR UPDATE;
  IF NOT FOUND
     OR v_payment.status <> 'successful'
     OR v_payment.kind <> 'subscription_initial'
     OR v_payment.billing_mode <> 'manual' THEN
    RETURN NULL;
  END IF;
  IF v_payment.subscription_id IS NOT NULL THEN
    RETURN v_payment.subscription_id;
  END IF;
  IF p_customer_email IS NULL OR LENGTH(TRIM(p_customer_email)) = 0 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_EMAIL_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT plan_expires_at INTO v_expires_at FROM users WHERE id = v_payment.user_id;

  UPDATE subscriptions
     SET status = 'cancelled',
         cancelled_at = NOW(),
         provider_cancel_pending = (
           provider_plan_id IS NOT NULL
           AND billing_mode = 'auto_renew'
         ),
         updated_at = NOW()
   WHERE user_id = v_payment.user_id
     AND status = 'active';

  INSERT INTO subscriptions (
    user_id, provider, plan, term, amount, currency,
    provider_plan_id, customer_email, initial_tx_ref,
    billing_mode, next_charge_at, last_payment_status, last_payment_attempt_at
  )
  VALUES (
    v_payment.user_id, v_payment.provider, v_payment.plan, v_payment.term,
    v_payment.amount, UPPER(v_payment.currency), NULL,
    LOWER(TRIM(p_customer_email)), v_payment.tx_ref,
    'manual', v_expires_at, 'successful', NOW()
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

REVOKE ALL ON FUNCTION start_manual_subscription_from_payment(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION start_manual_subscription_from_payment(TEXT, TEXT) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0036', 'Billing modes and durable renewal state')
ON CONFLICT (version) DO NOTHING;

COMMIT;
