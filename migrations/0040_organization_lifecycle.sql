-- Organization lifecycle: named staff identities, one-time cohort invitations,
-- password recovery, and durable report history.
BEGIN;

CREATE TABLE IF NOT EXISTS pitchnest_org_staff_accounts (
  id BIGSERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'facilitator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'revoked')),
  auth_version INTEGER NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until TIMESTAMPTZ,
  invite_token_hash TEXT UNIQUE,
  invite_expires_at TIMESTAMPTZ,
  invited_by BIGINT REFERENCES pitchnest_org_staff_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  CONSTRAINT pitchnest_org_staff_accounts_password_bcrypt
    CHECK (password_hash IS NULL OR password_hash ~ '^\$2[aby]\$[0-9]{2}\$.{53}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS pitchnest_org_staff_accounts_email_unique
  ON pitchnest_org_staff_accounts (lower(email));
CREATE INDEX IF NOT EXISTS pitchnest_org_staff_accounts_org_status
  ON pitchnest_org_staff_accounts (organization_id, status, role);

-- Convert each legacy organization login into a named owner record. Its old
-- shared password is intentionally invalidated; the owner sets a fresh private
-- password through the organization recovery flow after this migration.
INSERT INTO pitchnest_org_staff_accounts (organization_id, name, email, password_hash, role, status)
SELECT id, COALESCE(NULLIF(BTRIM(org_name), ''), 'Organization owner'), lower(BTRIM(email)),
       NULL, 'owner', 'active'
FROM "Organizations"
WHERE email IS NOT NULL AND BTRIM(email) <> ''
ON CONFLICT DO NOTHING;

UPDATE "Organizations"
SET password = NULL,
    auth_version = COALESCE(auth_version, 0) + 1;

CREATE TABLE IF NOT EXISTS pitchnest_org_cohort_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES pitchnest_org_staff_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pitchnest_org_cohort_invites_org_email
  ON pitchnest_org_cohort_invites (organization_id, lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS pitchnest_org_cohort_invites_active_expiry
  ON pitchnest_org_cohort_invites (expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_org_invite_hash TEXT;

CREATE TABLE IF NOT EXISTS pitchnest_org_password_resets (
  id BIGSERIAL PRIMARY KEY,
  member_id BIGINT NOT NULL REFERENCES pitchnest_org_staff_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pitchnest_org_password_resets_member
  ON pitchnest_org_password_resets (member_id);

CREATE TABLE IF NOT EXISTS pitchnest_org_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL CHECK (report_type IN ('weekly', 'monthly')),
  title TEXT NOT NULL,
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  generated_by BIGINT REFERENCES pitchnest_org_staff_accounts(id) ON DELETE SET NULL,
  report JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (range_end > range_start)
);
CREATE INDEX IF NOT EXISTS pitchnest_org_reports_history
  ON pitchnest_org_reports (organization_id, generated_at DESC);

ALTER TABLE pitchnest_org_staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_cohort_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pitchnest_org_staff_accounts_service_only ON pitchnest_org_staff_accounts;
CREATE POLICY pitchnest_org_staff_accounts_service_only ON pitchnest_org_staff_accounts FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_cohort_invites_service_only ON pitchnest_org_cohort_invites;
CREATE POLICY pitchnest_org_cohort_invites_service_only ON pitchnest_org_cohort_invites FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_password_resets_service_only ON pitchnest_org_password_resets;
CREATE POLICY pitchnest_org_password_resets_service_only ON pitchnest_org_password_resets FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_reports_service_only ON pitchnest_org_reports;
CREATE POLICY pitchnest_org_reports_service_only ON pitchnest_org_reports FOR ALL USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION accept_organization_invite(
  p_user_id INTEGER,
  p_token_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  invite pitchnest_org_cohort_invites;
  target_user users;
  target_org "Organizations";
  enrolled_count INTEGER;
BEGIN
  SELECT * INTO invite
    FROM pitchnest_org_cohort_invites
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > NOW()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO target_org FROM "Organizations" WHERE id = invite.organization_id FOR UPDATE;
  IF NOT FOUND OR target_org.org_code IS NULL OR (target_org.validity IS NOT NULL AND target_org.validity <= NOW()) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO target_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT target_user."isEmailVerified"
     OR lower(target_user.email) <> lower(invite.email) THEN
    RETURN NULL;
  END IF;
  IF target_user."orgCode" IS NOT NULL AND target_user."orgCode" <> ''
     AND target_user."orgCode" <> target_org.org_code::TEXT THEN
    RAISE EXCEPTION 'USER_ALREADY_IN_ORGANIZATION' USING ERRCODE = '23505';
  END IF;
  IF target_user."orgCode" IS NULL OR target_user."orgCode" = '' THEN
    SELECT COUNT(*) INTO enrolled_count FROM users WHERE "orgCode" = target_org.org_code::TEXT;
    IF enrolled_count >= GREATEST(COALESCE(target_org.org_users_capacity, 0), 0) THEN
      RETURN NULL;
    END IF;
  END IF;

  UPDATE users
     SET "orgCode" = target_org.org_code::TEXT,
         enrolled_at = NOW(),
         pending_org_invite_hash = NULL
   WHERE id = p_user_id;
  UPDATE pitchnest_org_cohort_invites SET accepted_by = p_user_id, accepted_at = NOW() WHERE id = invite.id;
  RETURN target_org.org_code::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION consume_organization_password_reset(
  p_reset_id BIGINT,
  p_member_id BIGINT,
  p_password_hash TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  deleted_id BIGINT;
  next_version INTEGER;
BEGIN
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;
  DELETE FROM pitchnest_org_password_resets
   WHERE id = p_reset_id AND member_id = p_member_id AND expires_at > NOW()
   RETURNING id INTO deleted_id;
  IF deleted_id IS NULL THEN RETURN NULL; END IF;
  DELETE FROM pitchnest_org_password_resets WHERE member_id = p_member_id;
  UPDATE pitchnest_org_staff_accounts
     SET password_hash = p_password_hash,
         status = 'active',
         accepted_at = COALESCE(accepted_at, NOW()),
         auth_version = auth_version + 1,
         failed_login_attempts = 0,
         locked_until = NULL
   WHERE id = p_member_id
   RETURNING auth_version INTO next_version;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION record_failed_organization_member_login(p_member_id BIGINT)
RETURNS TABLE(failed_attempts INTEGER, lock_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE pitchnest_org_staff_accounts
     SET failed_login_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW()
                                      THEN 1 ELSE failed_login_attempts + 1 END,
         locked_until = CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW()
                                        THEN 1 ELSE failed_login_attempts + 1 END) >= 5
                             THEN NOW() + INTERVAL '15 minutes' ELSE NULL END
   WHERE id = p_member_id
   RETURNING pitchnest_org_staff_accounts.failed_login_attempts, pitchnest_org_staff_accounts.locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_organization_member_sessions(p_member_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE next_version INTEGER;
BEGIN
  UPDATE pitchnest_org_staff_accounts SET auth_version = auth_version + 1
   WHERE id = p_member_id AND status = 'active'
   RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization member not found' USING ERRCODE = 'P0002'; END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_organization_member_access(p_member_id BIGINT, p_organization_id INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE changed_id BIGINT;
BEGIN
  UPDATE pitchnest_org_staff_accounts
     SET status = 'revoked',
         auth_version = auth_version + 1,
         invite_token_hash = NULL,
         invite_expires_at = NULL
   WHERE id = p_member_id AND organization_id = p_organization_id AND role <> 'owner'
   RETURNING id INTO changed_id;
  RETURN changed_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION accept_organization_invite(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_organization_invite(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION consume_organization_password_reset(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_organization_password_reset(BIGINT, BIGINT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION record_failed_organization_member_login(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_organization_member_login(BIGINT) TO service_role;
REVOKE ALL ON FUNCTION revoke_organization_member_sessions(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_member_sessions(BIGINT) TO service_role;
REVOKE ALL ON FUNCTION revoke_organization_member_access(BIGINT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_member_access(BIGINT, INTEGER) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0040', 'Organization staff accounts, cohort invitations, password recovery, and report history')
ON CONFLICT (version) DO NOTHING;
COMMIT;
