-- Authentication revocation and account-erasure hardening.
-- Depends on 0029.

BEGIN;

-- Incremented after a password reset or explicit logout. JWTs carry the value
-- they were issued with, so old tokens stop working immediately instead of
-- remaining valid for up to 30 days.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

-- Every pre-Google account was created with a password. Backfill those legacy
-- rows once, then make the authentication method explicit and immutable at the
-- application boundary. Leaving NULL claimable by the first OAuth login would
-- let someone with a same-address provider account change a password account's
-- sign-in method.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_provider TEXT;
UPDATE users SET auth_provider = 'form' WHERE auth_provider IS NULL;
ALTER TABLE users
  ALTER COLUMN auth_provider SET DEFAULT 'form',
  ALTER COLUMN auth_provider SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
ALTER TABLE users ADD CONSTRAINT users_auth_provider_check
  CHECK (auth_provider IN ('form', 'google'));

-- An organization invite is not membership until the address is verified.
-- Keeping it separate prevents an unverified signup from consuming a seat or
-- exposing its email/session activity to an organization dashboard.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_org_code TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pending_org_code_format;
ALTER TABLE users ADD CONSTRAINT users_pending_org_code_format
  CHECK (pending_org_code IS NULL OR pending_org_code ~ '^[0-9]{1,18}$');

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

-- Consume the one-time verification row and flip the account state in one
-- transaction. Application-side delete-then-update can strand an account with
-- no usable token if the second network call fails.
CREATE OR REPLACE FUNCTION consume_email_verification(
  p_token_id INTEGER,
  p_user_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed_id INTEGER;
BEGIN
  DELETE FROM email_verification_tokens
   WHERE id = p_token_id
     AND user_id = p_user_id
     AND expires_at > NOW()
   RETURNING id INTO consumed_id;
  IF consumed_id IS NULL THEN
    RETURN FALSE;
  END IF;

  DELETE FROM email_verification_tokens WHERE user_id = p_user_id;

  UPDATE users SET "isEmailVerified" = TRUE WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN TRUE;
END;
$$;

-- Mark a reset token used, rotate the hash, clear lockout state, and revoke all
-- old sessions atomically. Any failure rolls the entire operation back.
CREATE OR REPLACE FUNCTION consume_password_reset(
  p_reset_id INTEGER,
  p_user_id INTEGER,
  p_password_hash TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed_id INTEGER;
  next_version INTEGER;
BEGIN
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;

  DELETE FROM password_resets
   WHERE id = p_reset_id
     AND user_id = p_user_id
     AND used = FALSE
     AND expires_at > NOW()
   RETURNING id INTO consumed_id;
  IF consumed_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Concurrent reset requests can create more than one valid row. Once any
  -- token succeeds, revoke every sibling token in the same transaction so an
  -- older email cannot change the password again afterward.
  DELETE FROM password_resets WHERE user_id = p_user_id;

  UPDATE users
     SET password = p_password_hash,
         auth_version = auth_version + 1,
         failed_login_attempts = 0,
         locked_until = NULL
   WHERE id = p_user_id AND auth_provider IS DISTINCT FROM 'google'
   RETURNING auth_version INTO next_version;
  IF next_version IS NULL THEN
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

CREATE OR REPLACE FUNCTION enroll_user_in_organization(
  p_user_id INTEGER,
  p_org_code TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_user users%ROWTYPE;
  target_org "Organizations"%ROWTYPE;
  requested_code TEXT;
  enrolled_count INTEGER;
BEGIN
  SELECT * INTO target_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  IF target_user."orgCode" IS NOT NULL THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN target_user."orgCode";
  END IF;

  requested_code := COALESCE(NULLIF(TRIM(p_org_code), ''), target_user.pending_org_code);
  IF requested_code IS NULL OR requested_code !~ '^[0-9]{1,18}$' THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  SELECT * INTO target_org
    FROM "Organizations"
   WHERE org_code::TEXT = requested_code
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;
  IF target_org.validity IS NOT NULL AND target_org.validity <= NOW() THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER INTO enrolled_count
    FROM users
   WHERE "orgCode" = requested_code;
  IF enrolled_count >= GREATEST(COALESCE(target_org.org_users_capacity, 0), 0) THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  UPDATE users
     SET "orgCode" = requested_code,
         pending_org_code = NULL,
         enrolled_at = NOW()
   WHERE id = p_user_id AND "isEmailVerified" = TRUE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- The orgCode trigger below recounts the organization atomically after this
  -- row update; do not increment the denormalized count a second time here.
  RETURN requested_code;
END;
$$;

CREATE OR REPLACE FUNCTION sync_organization_enrollment_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_code TEXT;
  new_code TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_code := OLD."orgCode";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_code := NEW."orgCode";
  END IF;
  IF old_code IS NOT NULL THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (SELECT COUNT(*) FROM users WHERE "orgCode" = old_code)
     WHERE org_code::TEXT = old_code;
  END IF;
  IF new_code IS NOT NULL AND new_code IS DISTINCT FROM old_code THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (SELECT COUNT(*) FROM users WHERE "orgCode" = new_code)
     WHERE org_code::TEXT = new_code;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_organization_enrollment_count ON users;
CREATE TRIGGER trg_sync_organization_enrollment_count
AFTER INSERT OR UPDATE OF "orgCode" OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION sync_organization_enrollment_count();

UPDATE "Organizations" AS organization
SET org_users_enrolled = (
  SELECT COUNT(*) FROM users WHERE "orgCode" = organization.org_code::TEXT
);

-- A business with another active member is shared workspace data and survives
-- its creator's departure. A business with no other active member would become
-- an ownerless public profile, so delete it (and all DB children) as part of the
-- same user-delete transaction. Object storage is removed by the application
-- before issuing the user delete.
CREATE OR REPLACE FUNCTION delete_orphaned_user_businesses()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM businesses AS business
   WHERE (
     business.created_by = OLD.id
     OR EXISTS (
       SELECT 1 FROM business_members mine
        WHERE mine.business_id = business.id AND mine.user_id = OLD.id
     )
   )
   AND NOT EXISTS (
     SELECT 1 FROM business_members other_member
      WHERE other_member.business_id = business.id
        AND other_member.user_id <> OLD.id
        AND other_member.status = 'active'
   );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_orphaned_user_businesses ON users;
CREATE TRIGGER trg_delete_orphaned_user_businesses
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION delete_orphaned_user_businesses();

-- Archive/dashboard reads must not pull every full transcript and recording key
-- through the API just to discard them in Node. This service-role-only view is
-- a database-level projection, so those private fields never leave Postgres.
CREATE OR REPLACE VIEW session_list_safe
WITH (security_invoker = true)
AS
SELECT
  id,
  user_id,
  "timestamp",
  summary,
  COALESCE(evaluation_report, '{}'::jsonb) - 'transcript' AS evaluation_report,
  business_name,
  share_id,
  created_at,
  mode,
  parent_session_id,
  pitch_config,
  org_id,
  visibility,
  pitch_root_id,
  attempt_number,
  business_id,
  share_enabled,
  (video_url IS NOT NULL AND BTRIM(video_url) <> '') AS has_recording
FROM sessions;

REVOKE ALL ON session_list_safe FROM PUBLIC, anon, authenticated;
GRANT SELECT ON session_list_safe TO service_role;

CREATE INDEX IF NOT EXISTS idx_sessions_user_timestamp
  ON sessions (user_id, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_users_active_trial_expiry
  ON users (trial_expires_at, id)
  WHERE trial_status = 'active' AND "isEmailVerified" = TRUE;

-- Human access to confidential founder transcripts must leave a durable audit
-- trail outside ephemeral application logs. The endpoint writes one summary row
-- per paginated read and refuses to disclose data if that write fails.
CREATE TABLE IF NOT EXISTS staff_data_access_log (
  id BIGSERIAL PRIMARY KEY,
  staff_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('transcript_review')),
  result_count INTEGER NOT NULL CHECK (result_count >= 0),
  query_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_data_access_time
  ON staff_data_access_log (accessed_at DESC);
ALTER TABLE staff_data_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_data_access_deny_direct" ON staff_data_access_log;
CREATE POLICY "staff_data_access_deny_direct" ON staff_data_access_log
  FOR ALL USING (FALSE) WITH CHECK (FALSE);
REVOKE ALL ON staff_data_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON staff_data_access_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE staff_data_access_log_id_seq TO service_role;

-- A reminder claim is a lease, not a permanent marker, until the provider has
-- accepted the message. This closes the process-crash gap in the original
-- insert-before-send design: an unfinished lease can be reclaimed after 30
-- minutes, while a delivered row remains final. `sent_at` is retained for
-- compatibility with the original table and records the first claim time;
-- `delivered_at` is now the authoritative delivery timestamp.
ALTER TABLE trial_email_log
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_id UUID;

-- Rows created by migration 0016 represented successfully completed sends.
-- Backfill them before the application starts using lease semantics.
UPDATE trial_email_log
   SET claimed_at = COALESCE(claimed_at, sent_at),
       delivered_at = COALESCE(delivered_at, sent_at)
 WHERE delivered_at IS NULL AND lease_id IS NULL;

CREATE OR REPLACE FUNCTION claim_trial_email(
  p_user_id INTEGER,
  p_milestone TEXT,
  p_lease_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed BOOLEAN := FALSE;
BEGIN
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'A lease id is required' USING ERRCODE = '22023';
  END IF;
  IF p_milestone NOT IN ('t7', 't3', 't1', 'expired') THEN
    RAISE EXCEPTION 'Invalid trial milestone' USING ERRCODE = '22023';
  END IF;

  INSERT INTO trial_email_log (
    user_id, milestone, sent_at, claimed_at, delivered_at, lease_id
  ) VALUES (
    p_user_id, p_milestone, NOW(), NOW(), NULL, p_lease_id
  )
  ON CONFLICT (user_id, milestone) DO UPDATE
     SET claimed_at = EXCLUDED.claimed_at,
         lease_id = EXCLUDED.lease_id
   WHERE trial_email_log.delivered_at IS NULL
     AND trial_email_log.claimed_at < NOW() - INTERVAL '30 minutes'
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

-- Serialize limited-plan quota claims on the owning user row. The former
-- insert-then-count sequence could admit two requests on separate application
-- instances because each transaction need not see the other's uncommitted row.
-- This function checks and records under one row lock and therefore remains
-- authoritative when the backend scales horizontally.
CREATE OR REPLACE FUNCTION claim_weekly_session_slot(
  p_user_id INTEGER,
  p_limit INTEGER
)
RETURNS TABLE(
  allowed BOOLEAN,
  used INTEGER,
  remaining INTEGER,
  resets_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_used INTEGER;
  oldest_start TIMESTAMPTZ;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Invalid session limit' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COUNT(*)::INTEGER, MIN(started_at)
    INTO current_used, oldest_start
    FROM session_starts
   WHERE user_id = p_user_id
     AND started_at > NOW() - INTERVAL '7 days';

  IF current_used >= p_limit THEN
    RETURN QUERY SELECT
      FALSE,
      current_used,
      0,
      oldest_start + INTERVAL '7 days';
    RETURN;
  END IF;

  INSERT INTO session_starts (user_id) VALUES (p_user_id);
  current_used := current_used + 1;
  IF oldest_start IS NULL THEN
    oldest_start := NOW();
  END IF;

  RETURN QUERY SELECT
    TRUE,
    current_used,
    GREATEST(0, p_limit - current_used),
    oldest_start + INTERVAL '7 days';
END;
$$;

REVOKE ALL ON FUNCTION revoke_user_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION rotate_user_password(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rotate_user_password(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION consume_email_verification(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_email_verification(INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION consume_password_reset(INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_password_reset(INTEGER, INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION record_failed_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION record_failed_org_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_org_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION revoke_organization_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_sessions(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION enroll_user_in_organization(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION enroll_user_in_organization(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION sync_organization_enrollment_count() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION delete_orphaned_user_businesses() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_trial_email(INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_trial_email(INTEGER, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION claim_weekly_session_slot(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_weekly_session_slot(INTEGER, INTEGER) TO service_role;

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

-- CREATE OR REPLACE normally retains ACLs, but reassert this explicitly in the
-- same migration so a fresh, restored or partially migrated environment cannot
-- expose a subscription-granting SECURITY DEFINER function.
REVOKE ALL ON FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  TO service_role;
ALTER FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  SET search_path = public;

-- 0028 replaces this SECURITY DEFINER function. Reassert the least-privilege
-- grant explicitly rather than relying on CREATE OR REPLACE preserving ACLs.
REVOKE ALL ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0030', 'Authentication, organization enrollment, billing, email delivery, privacy and erasure hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
