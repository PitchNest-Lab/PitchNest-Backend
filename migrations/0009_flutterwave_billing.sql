-- Migration 0009: Flutterwave billing — plan expiry + payments ledger.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- MODEL: one-off payments that GRANT A PERIOD, not auto-renewing subscriptions
-- ──────────────────────────────────────────────────────────────────────────────
-- Each successful payment extends users.plan_expires_at by PRO_PLAN_DAYS. When
-- the date passes, the user reads as free again and can pay for another period.
--
-- Why this shape rather than a subscriptions table with a status machine:
--   * No card is stored, so there is no renewal to attempt, no dunning ladder,
--     no involuntary-churn handling and no cancellation flow. The user simply
--     stops paying and access lapses.
--   * Expiry is one comparable column, so the entitlement check stays a single
--     indexed read (see entitlementService.getEntitlements).
--
-- NULL plan_expires_at means "never expires". That is deliberate: it is what the
-- users grandfathered in migration 0008 have, so their access does not silently
-- lapse 30 days after this migration is applied.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. USERS — when the current paid period ends
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;

COMMENT ON COLUMN users.plan_expires_at IS
  'End of the current paid period. NULL = never expires (grandfathered or comped).';

-- Finds users whose access has lapsed, for reporting and for an optional
-- downgrade sweep. Partial: unexpiring rows are the majority and never match.
CREATE INDEX IF NOT EXISTS idx_users_plan_expiry
  ON users (plan_expires_at)
  WHERE plan_expires_at IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. PAYMENTS — the audit trail, and the idempotency guard
-- ──────────────────────────────────────────────────────────────────────────────
-- tx_ref is OUR reference, minted at checkout, and is UNIQUE. That uniqueness is
-- the whole idempotency mechanism: Flutterwave retries a webhook up to 3 times
-- 30 minutes apart, and duplicates are explicitly expected. Recording the grant
-- and the payment in one INSERT means a replayed webhook hits the unique
-- constraint and cannot extend the user's period a second time.
CREATE TABLE IF NOT EXISTS payments (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Our reference, sent to Flutterwave as tx_ref and echoed back.
  tx_ref        text NOT NULL UNIQUE,
  -- Flutterwave's transaction id, known only after payment. Also unique so a
  -- second tx_ref can never claim the same underlying transaction.
  provider_ref  text UNIQUE,
  provider      text NOT NULL DEFAULT 'flutterwave',
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'successful', 'failed')),
  -- Amount in MAJOR units (10.00 = ten dollars), with the currency it was
  -- actually charged in — not converted, so the record matches the receipt.
  amount        numeric(12, 2) NOT NULL,
  currency      text NOT NULL,
  /** Days of access this payment granted. Recorded so changing the plan length
      later does not rewrite history. */
  granted_days  integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. grant_pro_access — the only multi-row invariant in billing
-- ──────────────────────────────────────────────────────────────────────────────
-- Marking the payment successful and extending the user's period must happen
-- together or not at all. Doing it as two statements from Node means a crash
-- between them either takes money without granting access, or grants access
-- without a payment record. supabase-js has no transaction primitive, so this
-- runs as one atomic function.
--
-- EXTENSION SEMANTICS: a payment made while still active EXTENDS from the
-- existing expiry, so a user who renews early does not lose the remaining days.
-- One made after lapsing starts from now().
--
-- Returns true when access was granted, false when the reference was already
-- processed — which is how the webhook stays idempotent under retries.
CREATE OR REPLACE FUNCTION grant_pro_access(
  p_tx_ref       text,
  p_provider_ref text,
  p_amount       numeric,
  p_currency     text,
  p_days         integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_payment payments;
  v_user_id integer;
BEGIN
  -- Lock the pending payment row so two concurrent webhook deliveries for the
  -- same reference serialise here rather than both granting.
  SELECT * INTO v_payment
    FROM payments
   WHERE tx_ref = p_tx_ref
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_TX_REF';
  END IF;

  -- Already settled: a retry or a duplicate. Not an error, just nothing to do.
  IF v_payment.status = 'successful' THEN
    RETURN false;
  END IF;

  v_user_id := v_payment.user_id;

  UPDATE payments
     SET status       = 'successful',
         provider_ref = p_provider_ref,
         amount       = p_amount,
         currency     = p_currency,
         granted_days = p_days,
         completed_at = now()
   WHERE id = v_payment.id;

  -- Extend from the later of now() and the current expiry, so early renewal
  -- keeps unused days. COALESCE handles a first-time upgrade (NULL expiry) —
  -- but note a grandfathered user also has NULL, and paying would REPLACE their
  -- unlimited access with a dated period. Guarded below.
  UPDATE users
     SET plan            = 'pro',
         plan_expires_at = CASE
           -- Never downgrade unlimited access to a fixed window.
           WHEN plan = 'pro' AND plan_expires_at IS NULL THEN NULL
           ELSE GREATEST(COALESCE(plan_expires_at, now()), now())
                  + (p_days || ' days')::interval
         END
   WHERE id = v_user_id;

  RETURN true;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. RLS — deny anon, mirroring 0004
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_deny_anon" ON payments;
CREATE POLICY "payments_deny_anon" ON payments
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- OPERATOR NOTES
-- ──────────────────────────────────────────────────────────────────────────────
-- Comp a user indefinitely (no expiry):
--     UPDATE users SET plan = 'pro', plan_expires_at = NULL WHERE email = '…';
--
-- Grant 30 days by hand (e.g. a bank transfer taken off-platform):
--     UPDATE users SET plan = 'pro',
--            plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now())
--                              + interval '30 days'
--      WHERE email = '…';
--
-- Who is actually paying, and when do they lapse:
--     SELECT email, plan, plan_expires_at FROM users
--      WHERE plan = 'pro' ORDER BY plan_expires_at NULLS FIRST;
--
-- Revenue to date:
--     SELECT currency, sum(amount), count(*) FROM payments
--      WHERE status = 'successful' GROUP BY currency;
--
-- Stuck checkouts (started, never completed) — expected, users abandon:
--     SELECT count(*) FROM payments WHERE status = 'pending'
--       AND created_at < now() - interval '1 day';
