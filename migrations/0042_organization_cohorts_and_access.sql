-- Let an invitation place a founder into a named cohort, and provide
-- organization-scoped membership revocation without deleting founder data.
BEGIN;

ALTER TABLE pitchnest_org_cohort_invites
  ADD COLUMN IF NOT EXISTS cohort TEXT;

CREATE INDEX IF NOT EXISTS pitchnest_org_founder_memberships_org_cohort
  ON pitchnest_org_founder_memberships (organization_id, cohort)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION apply_organization_invite_cohort()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE pitchnest_org_founder_memberships membership
     SET cohort = invite.cohort
    FROM pitchnest_org_cohort_invites invite
   WHERE membership.id = NEW.id
     AND invite.id = NEW.invite_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION apply_organization_invite_cohort() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_organization_invite_cohort() TO service_role;

DROP TRIGGER IF EXISTS trg_apply_organization_invite_cohort ON pitchnest_org_founder_memberships;
CREATE TRIGGER trg_apply_organization_invite_cohort
AFTER INSERT OR UPDATE OF invite_id ON pitchnest_org_founder_memberships
FOR EACH ROW EXECUTE FUNCTION apply_organization_invite_cohort();

CREATE OR REPLACE FUNCTION revoke_organization_founder_membership(
  p_organization_id INTEGER,
  p_user_id INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target_org_code TEXT;
  replacement_org_code TEXT;
  replacement_joined_at TIMESTAMPTZ;
BEGIN
  SELECT org_code::TEXT INTO target_org_code
    FROM "Organizations" WHERE id = p_organization_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE pitchnest_org_founder_memberships
     SET status = 'revoked', updated_at = NOW()
   WHERE organization_id = p_organization_id
     AND user_id = p_user_id
     AND status = 'active';
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT organization.org_code::TEXT, membership.joined_at
    INTO replacement_org_code, replacement_joined_at
    FROM pitchnest_org_founder_memberships membership
    JOIN "Organizations" organization ON organization.id = membership.organization_id
   WHERE membership.user_id = p_user_id
     AND membership.organization_id <> p_organization_id
     AND membership.status = 'active'
   ORDER BY membership.joined_at ASC, membership.organization_id ASC
   LIMIT 1;

  UPDATE users
     SET "orgCode" = replacement_org_code,
         enrolled_at = replacement_joined_at
   WHERE id = p_user_id AND "orgCode" = target_org_code;

  -- Revoking a program membership also removes that program's access to the
  -- founder's past recordings and analytics while preserving their sessions.
  UPDATE sessions
     SET org_id = NULL, visibility = 'private', organization_replay_shared = FALSE
   WHERE user_id = p_user_id AND org_id = target_org_code;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION revoke_organization_founder_membership(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_founder_membership(INTEGER, INTEGER) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0042', 'Organization cohorts on founder invitations and membership access revocation')
ON CONFLICT (version) DO NOTHING;
COMMIT;
