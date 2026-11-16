-- Multi-organization founder memberships and organization-defined program forms.
-- Existing users.orgCode is retained as a backwards-compatible primary org.
BEGIN;

CREATE TABLE IF NOT EXISTS pitchnest_org_founder_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  cohort TEXT,
  invite_id UUID REFERENCES pitchnest_org_cohort_invites(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS pitchnest_org_founder_memberships_user_status
  ON pitchnest_org_founder_memberships (user_id, status, joined_at DESC);
CREATE INDEX IF NOT EXISTS pitchnest_org_founder_memberships_org_status
  ON pitchnest_org_founder_memberships (organization_id, status, joined_at DESC);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS organization_replay_shared BOOLEAN NOT NULL DEFAULT FALSE;
-- Keep replays that were already organization-visible before this setting was
-- introduced. New sessions require the founder to opt in explicitly.
UPDATE sessions
   SET organization_replay_shared = TRUE
 WHERE visibility = 'organization' AND video_url IS NOT NULL;

-- Preserve every existing orgCode assignment as an active membership before
-- switching organization dashboards and seat counts to the membership table.
INSERT INTO pitchnest_org_founder_memberships
  (organization_id, user_id, status, cohort, joined_at, created_at, updated_at)
SELECT organization.id, users.id, 'active', NULL::TEXT,
       COALESCE(users.enrolled_at, users.created_at, NOW()), NOW(), NOW()
  FROM users
  JOIN "Organizations" organization ON organization.org_code::TEXT = users."orgCode"
 WHERE NULLIF(BTRIM(users."orgCode"), '') IS NOT NULL
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- The old trigger counted only the scalar users.orgCode, which would undo the
-- membership-based seat count. Enrollment counts now follow active memberships.
DROP TRIGGER IF EXISTS trg_sync_organization_enrollment_count ON users;

CREATE OR REPLACE FUNCTION sync_org_founder_membership_count()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (
         SELECT COUNT(*) FROM pitchnest_org_founder_memberships
          WHERE organization_id = OLD.organization_id AND status = 'active'
       )
     WHERE id = OLD.organization_id;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.organization_id <> NEW.organization_id THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (
         SELECT COUNT(*) FROM pitchnest_org_founder_memberships
          WHERE organization_id = OLD.organization_id AND status = 'active'
       )
     WHERE id = OLD.organization_id;
  END IF;

  UPDATE "Organizations"
     SET org_users_enrolled = (
       SELECT COUNT(*) FROM pitchnest_org_founder_memberships
        WHERE organization_id = NEW.organization_id AND status = 'active'
     )
   WHERE id = NEW.organization_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_founder_membership_count ON pitchnest_org_founder_memberships;
CREATE TRIGGER trg_sync_org_founder_membership_count
AFTER INSERT OR UPDATE OR DELETE
ON pitchnest_org_founder_memberships
FOR EACH ROW EXECUTE FUNCTION sync_org_founder_membership_count();

UPDATE "Organizations" organization
   SET org_users_enrolled = (
     SELECT COUNT(*) FROM pitchnest_org_founder_memberships membership
      WHERE membership.organization_id = organization.id AND membership.status = 'active'
   );

CREATE TABLE IF NOT EXISTS pitchnest_org_submission_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(BTRIM(title)) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(fields) = 'array'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  due_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES pitchnest_org_staff_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pitchnest_org_submission_forms_org_status
  ON pitchnest_org_submission_forms (organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS pitchnest_org_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES pitchnest_org_submission_forms(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES pitchnest_org_founder_memberships(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  form_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(form_snapshot) = 'object'),
  answers JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(answers) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'reviewed')),
  submitted_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES pitchnest_org_staff_accounts(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  reviewer_feedback TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pitchnest_org_submissions_org_form_status
  ON pitchnest_org_submissions (organization_id, form_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS pitchnest_org_submissions_membership
  ON pitchnest_org_submissions (membership_id, form_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pitchnest_org_submission_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id INTEGER NOT NULL REFERENCES "Organizations"(id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES pitchnest_org_submissions(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  object_path TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pitchnest_org_submission_files_submission
  ON pitchnest_org_submission_files (organization_id, submission_id);

ALTER TABLE pitchnest_org_founder_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_submission_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pitchnest_org_submission_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pitchnest_org_founder_memberships_service_only ON pitchnest_org_founder_memberships;
CREATE POLICY pitchnest_org_founder_memberships_service_only ON pitchnest_org_founder_memberships FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_submission_forms_service_only ON pitchnest_org_submission_forms;
CREATE POLICY pitchnest_org_submission_forms_service_only ON pitchnest_org_submission_forms FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_submissions_service_only ON pitchnest_org_submissions;
CREATE POLICY pitchnest_org_submissions_service_only ON pitchnest_org_submissions FOR ALL USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS pitchnest_org_submission_files_service_only ON pitchnest_org_submission_files;
CREATE POLICY pitchnest_org_submission_files_service_only ON pitchnest_org_submission_files FOR ALL USING (false) WITH CHECK (false);

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
  already_active BOOLEAN;
  existing_org_code TEXT;
BEGIN
  SELECT * INTO invite
    FROM pitchnest_org_cohort_invites
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > NOW()
   FOR UPDATE;
  IF NOT FOUND THEN
    -- A founder may retry after a network interruption. A consumed invitation
    -- is idempotent for the same account, but remains unusable by anyone else.
    SELECT organization.org_code::TEXT INTO existing_org_code
      FROM pitchnest_org_cohort_invites accepted_invite
      JOIN "Organizations" organization ON organization.id = accepted_invite.organization_id
      JOIN pitchnest_org_founder_memberships membership
        ON membership.organization_id = accepted_invite.organization_id
       AND membership.user_id = p_user_id AND membership.status = 'active'
     WHERE accepted_invite.token_hash = p_token_hash
       AND accepted_invite.accepted_by = p_user_id
       AND accepted_invite.accepted_at IS NOT NULL
       AND accepted_invite.revoked_at IS NULL;
    RETURN existing_org_code;
  END IF;

  SELECT * INTO target_org FROM "Organizations" WHERE id = invite.organization_id FOR UPDATE;
  IF NOT FOUND OR target_org.org_code IS NULL OR (target_org.validity IS NOT NULL AND target_org.validity <= NOW()) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO target_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND OR NOT target_user."isEmailVerified"
     OR lower(target_user.email) <> lower(invite.email) THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pitchnest_org_founder_memberships
     WHERE organization_id = target_org.id AND user_id = p_user_id AND status = 'active'
  ) INTO already_active;
  IF NOT already_active THEN
    SELECT COUNT(*) INTO enrolled_count FROM pitchnest_org_founder_memberships
     WHERE organization_id = target_org.id AND status = 'active';
    IF enrolled_count >= GREATEST(COALESCE(target_org.org_users_capacity, 0), 0) THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO pitchnest_org_founder_memberships
    (organization_id, user_id, status, invite_id, joined_at, updated_at)
  VALUES (target_org.id, p_user_id, 'active', invite.id, NOW(), NOW())
  ON CONFLICT (organization_id, user_id) DO UPDATE
    SET status = 'active', invite_id = EXCLUDED.invite_id,
        joined_at = CASE WHEN pitchnest_org_founder_memberships.status = 'active'
                         THEN pitchnest_org_founder_memberships.joined_at ELSE NOW() END,
        updated_at = NOW();

  -- Keep the legacy field as the founder's first-program default. It must not
  -- overwrite another membership when a founder accepts another invitation.
  UPDATE users
     SET "orgCode" = COALESCE(NULLIF("orgCode", ''), target_org.org_code::TEXT),
         enrolled_at = CASE WHEN NULLIF("orgCode", '') IS NULL THEN NOW() ELSE enrolled_at END,
         pending_org_invite_hash = NULL
   WHERE id = p_user_id;
  UPDATE pitchnest_org_cohort_invites SET accepted_by = p_user_id, accepted_at = NOW() WHERE id = invite.id;
  RETURN target_org.org_code::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION accept_organization_invite(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accept_organization_invite(INTEGER, TEXT) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0041', 'Multi-organization founder memberships and configurable program forms')
ON CONFLICT (version) DO NOTHING;
COMMIT;
