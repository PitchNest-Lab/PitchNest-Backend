-- Migration 0010: Paid tiers (prep + pro) and billing terms (monthly / annual).
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS, AND THE ONE RULE IT PROTECTS
-- ──────────────────────────────────────────────────────────────────────────────
-- Billing grew from a single paid level ("pro", flat 30 days) to TWO purchasable
-- levels (prep, pro) each sold on TWO terms (monthly, annual). The amount and the
-- number of days differ per SKU, so the grant can no longer assume "30 days of
-- pro".
--
-- THE RULE: what a user receives is decided at CHECKOUT and written onto the
-- payment row (plan + term + granted_days). The webhook grants strictly from
-- THOSE columns — never from the client, never from the webhook payload. A
-- forged or replayed webhook therefore cannot change which tier or how many days
-- are granted; it can at most re-trigger a grant that the unique tx_ref + row
-- lock already makes idempotent.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. USERS — allow 'prep' as a third plan level
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'prep', 'pro'));

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. PAYMENTS — record the INTENDED grant at checkout
-- ──────────────────────────────────────────────────────────────────────────────
-- granted_days already exists (0009). Add the target level and the term. These
-- are the source of truth the grant reads back.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS term text;

-- Backfill rows written before this migration: the only SKU that existed was
-- Pro, monthly, 30 days.
UPDATE payments SET plan = 'pro'     WHERE plan IS NULL;
UPDATE payments SET term = 'monthly' WHERE term IS NULL;
UPDATE payments SET granted_days = 30 WHERE granted_days IS NULL;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_plan_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_plan_check CHECK (plan IN ('prep', 'pro'));

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. grant_pro_access — grant the recorded level for the recorded number of days
-- ──────────────────────────────────────────────────────────────────────────────
-- Replaces the 0009 five-argument version (which hardcoded plan='pro' and took
-- p_days as a parameter). The new form reads the target level and days from the
-- locked payment row, so the grant cannot drift from what was priced and sold.
--
-- The old overload is dropped explicitly: Postgres keys functions by signature,
-- so a bare CREATE OR REPLACE would leave the 5-arg version behind as a live,
-- callable duplicate.
DROP FUNCTION IF EXISTS grant_pro_access(text, text, numeric, text, integer);

CREATE OR REPLACE FUNCTION grant_pro_access(
  p_tx_ref       text,
  p_provider_ref text,
  p_amount       numeric,
  p_currency     text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_payment        payments;
  v_user           users;
  v_target         text;
  v_days           integer;
  v_rank_target    integer;
  v_rank_current   integer;
  v_new_plan       text;
BEGIN
  -- Lock the pending payment so two concurrent webhook deliveries for the same
  -- reference serialise here rather than both granting.
  SELECT * INTO v_payment
    FROM payments
   WHERE tx_ref = p_tx_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_TX_REF';
  END IF;

  -- Already settled: a retry or duplicate. Not an error — nothing to do.
  IF v_payment.status = 'successful' THEN
    RETURN false;
  END IF;

  -- What we sold, from our own row. COALESCE guards any pre-0010 pending row.
  v_target := COALESCE(v_payment.plan, 'pro');
  v_days   := COALESCE(v_payment.granted_days, 30);

  -- Record the verified payment (the amount/currency actually charged, passed
  -- in after the caller has already checked them against what we recorded).
  UPDATE payments
     SET status       = 'successful',
         provider_ref = p_provider_ref,
         amount       = p_amount,
         currency     = p_currency,
         completed_at = now()
   WHERE id = v_payment.id;

  SELECT * INTO v_user FROM users WHERE id = v_payment.user_id FOR UPDATE;

  -- Never downgrade unlimited (comped / grandfathered) access to a dated period.
  -- The checkout controller already blocks this case; this is defence in depth.
  IF v_user.plan = 'pro' AND v_user.plan_expires_at IS NULL THEN
    RETURN true;
  END IF;

  -- Never REDUCE an active level: if the user is on a higher tier that has not
  -- yet expired, buying a lower tier keeps the higher tier and simply adds days.
  -- Precedence: free(0) < prep(1) < pro(2). An expired period counts as free.
  v_rank_target := CASE v_target WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END;
  v_rank_current := CASE
    WHEN v_user.plan_expires_at IS NOT NULL AND v_user.plan_expires_at > now()
      THEN CASE v_user.plan WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END
    ELSE 0
  END;
  v_new_plan := CASE WHEN v_rank_current > v_rank_target THEN v_user.plan ELSE v_target END;

  -- Extend from the later of now() and the current expiry, so an early renewal
  -- keeps unused days.
  UPDATE users
     SET plan            = v_new_plan,
         plan_expires_at  = GREATEST(COALESCE(plan_expires_at, now()), now())
                              + (v_days || ' days')::interval
   WHERE id = v_user.id;

  RETURN true;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- OPERATOR NOTES
-- ──────────────────────────────────────────────────────────────────────────────
-- Comp a user indefinitely (no expiry):
--     UPDATE users SET plan = 'pro', plan_expires_at = NULL WHERE email = '…';
--
-- Grant a specific tier by hand (e.g. an off-platform bank transfer):
--     UPDATE users SET plan = 'prep',
--            plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now())
--                              + interval '30 days'
--      WHERE email = '…';
--
-- Revenue by tier and term:
--     SELECT plan, term, currency, count(*), sum(amount)
--       FROM payments WHERE status = 'successful'
--      GROUP BY plan, term, currency ORDER BY plan, term;
