-- Authentication revocation and account-erasure hardening.
-- Depends on 0029.

BEGIN;

-- Incremented after a password reset or explicit logout. JWTs carry the value
-- they were issued with, so old tokens stop working immediately instead of
-- remaining valid for up to 30 days.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_version_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_auth_version_nonnegative
  CHECK (auth_version >= 0);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_failed_login_attempts_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_failed_login_attempts_nonnegative
  CHECK (failed_login_attempts >= 0);

ALTER TABLE "Organizations"
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE "Organizations" DROP CONSTRAINT IF EXISTS organizations_auth_version_nonnegative;
ALTER TABLE "Organizations" ADD CONSTRAINT organizations_auth_version_nonnegative
  CHECK (auth_version >= 0);
ALTER TABLE "Organizations" DROP CONSTRAINT IF EXISTS organizations_failed_login_attempts_nonnegative;
ALTER TABLE "Organizations" ADD CONSTRAINT organizations_failed_login_attempts_nonnegative
  CHECK (failed_login_attempts >= 0);

CREATE OR REPLACE FUNCTION revoke_user_sessions(p_user_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  UPDATE users
  SET auth_version = auth_version + 1
  WHERE id = p_user_id
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION rotate_user_password(p_user_id INTEGER, p_password_hash TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;
  UPDATE users
  SET password = p_password_hash,
      auth_version = auth_version + 1,
      failed_login_attempts = 0,
      locked_until = NULL
  WHERE id = p_user_id AND auth_provider IS DISTINCT FROM 'google'
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION record_failed_login(p_user_id INTEGER)
RETURNS TABLE(failed_attempts INTEGER, lock_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE users
  SET failed_login_attempts = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
        ELSE failed_login_attempts + 1
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
          ELSE failed_login_attempts + 1
        END) >= 5 THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END
  WHERE id = p_user_id
  RETURNING users.failed_login_attempts, users.locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION record_failed_org_login(p_org_id INTEGER)
RETURNS TABLE(failed_attempts INTEGER, lock_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE "Organizations"
  SET failed_login_attempts = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
        ELSE failed_login_attempts + 1
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
          ELSE failed_login_attempts + 1
        END) >= 5 THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END
  WHERE id = p_org_id
  RETURNING "Organizations".failed_login_attempts, "Organizations".locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_organization_sessions(p_org_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  UPDATE "Organizations"
  SET auth_version = auth_version + 1
  WHERE id = p_org_id
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

REVOKE ALL ON FUNCTION revoke_user_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION rotate_user_password(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rotate_user_password(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION record_failed_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION record_failed_org_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_org_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION revoke_organization_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_sessions(INTEGER) TO service_role;

-- A person may erase their account without deleting a shared business. These
-- provenance fields are intentionally nullable and become anonymous when the
-- referenced user is deleted; memberships and genuinely personal records
-- continue to cascade as defined by their own foreign keys.
ALTER TABLE businesses
  ALTER COLUMN created_by DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS businesses_created_by_fkey;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE business_publications
  ALTER COLUMN approved_by DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS business_publications_approved_by_fkey;
ALTER TABLE business_publications
  ADD CONSTRAINT business_publications_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- Enforce the payment invariant in the database too. Settlement may only move
-- a pending row to successful when the verified provider amount covers the
-- checkout amount and the currency is identical. This protects the grant RPC
-- even if a future caller forgets the controller-side comparison.
CREATE OR REPLACE FUNCTION enforce_payment_settlement()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'successful' AND NEW.status = 'successful' THEN
    IF NEW.amount < OLD.amount THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF UPPER(NEW.currency) <> UPPER(OLD.currency) THEN
      RAISE EXCEPTION 'PAYMENT_CURRENCY_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.term IS DISTINCT FROM OLD.term
      OR NEW.granted_days IS DISTINCT FROM OLD.granted_days THEN
      RAISE EXCEPTION 'PAYMENT_GRANT_CHANGED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_settlement ON payments;
CREATE TRIGGER trg_enforce_payment_settlement
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION enforce_payment_settlement();

-- Keep the invariant inside the settlement function as well as in the trigger:
-- amount/currency are checked against the locked checkout row before any grant.
CREATE OR REPLACE FUNCTION grant_pro_access(
  p_tx_ref TEXT,
  p_provider_ref TEXT,
  p_amount NUMERIC,
  p_currency TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_user users;
  v_target TEXT;
  v_days INTEGER;
  v_rank_target INTEGER;
  v_rank_current INTEGER;
  v_new_plan TEXT;
BEGIN
  SELECT * INTO v_payment
    FROM payments
   WHERE tx_ref = p_tx_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_TX_REF';
  END IF;
  IF v_payment.status = 'successful' THEN
    RETURN FALSE;
  END IF;
  IF p_amount IS NULL OR p_amount < v_payment.amount THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF p_currency IS NULL OR UPPER(TRIM(p_currency)) <> UPPER(TRIM(v_payment.currency)) THEN
    RAISE EXCEPTION 'PAYMENT_CURRENCY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF p_provider_ref IS NULL OR LENGTH(TRIM(p_provider_ref)) = 0 OR LENGTH(p_provider_ref) > 255 THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_REFERENCE' USING ERRCODE = '22023';
  END IF;

  v_target := COALESCE(v_payment.plan, 'pro');
  v_days := COALESCE(v_payment.granted_days, 30);
  IF v_target NOT IN ('prep', 'pro') OR v_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_GRANT' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_user FROM users WHERE id = v_payment.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE payments
     SET status = 'successful',
         provider_ref = TRIM(p_provider_ref),
         amount = p_amount,
         currency = UPPER(TRIM(p_currency)),
         completed_at = NOW()
   WHERE id = v_payment.id;

  -- Do not replace any unlimited paid/grandfathered access with a dated plan.
  IF v_user.plan IN ('prep', 'pro', 'founder', 'enterprise')
     AND v_user.plan_expires_at IS NULL THEN
    RETURN TRUE;
  END IF;

  v_rank_target := CASE v_target WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END;
  v_rank_current := CASE
    WHEN v_user.plan_expires_at IS NOT NULL AND v_user.plan_expires_at > NOW()
      THEN CASE v_user.plan
        WHEN 'enterprise' THEN 4 WHEN 'founder' THEN 3
        WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END
    ELSE 0
  END;
  v_new_plan := CASE WHEN v_rank_current > v_rank_target THEN v_user.plan ELSE v_target END;

  UPDATE users
     SET plan = v_new_plan,
         plan_expires_at = GREATEST(COALESCE(plan_expires_at, NOW()), NOW())
                           + (v_days || ' days')::INTERVAL
   WHERE id = v_user.id;

  RETURN TRUE;
END;
$$;

-- 0028 replaces this SECURITY DEFINER function. Reassert the least-privilege
-- grant explicitly rather than relying on CREATE OR REPLACE preserving ACLs.
REVOKE ALL ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0030', 'JWT revocation and account-erasure foreign-key hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
