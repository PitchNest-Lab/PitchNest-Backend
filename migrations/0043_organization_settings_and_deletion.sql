-- Keep organization profile changes scoped to the authenticated organization;
-- allow its owner to close the workspace while preserving founder accounts.
BEGIN;

CREATE OR REPLACE FUNCTION delete_organization_account(
  p_organization_id INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target_org_code TEXT;
BEGIN
  SELECT org_code::TEXT INTO target_org_code
    FROM "Organizations" WHERE id = p_organization_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  UPDATE users user_row
     SET "orgCode" = (
           SELECT organization.org_code::TEXT
             FROM pitchnest_org_founder_memberships membership
             JOIN "Organizations" organization ON organization.id = membership.organization_id
            WHERE membership.user_id = user_row.id
              AND membership.organization_id <> p_organization_id
              AND membership.status = 'active'
            ORDER BY membership.joined_at ASC, membership.organization_id ASC LIMIT 1
         ),
         enrolled_at = (
           SELECT membership.joined_at
             FROM pitchnest_org_founder_memberships membership
            WHERE membership.user_id = user_row.id
              AND membership.organization_id <> p_organization_id
              AND membership.status = 'active'
            ORDER BY membership.joined_at ASC, membership.organization_id ASC LIMIT 1
         )
   WHERE user_row."orgCode" = target_org_code;

  -- Users whose legacy primary organization was deleted and who have no other
  -- active program remain normal PitchNest founders with no org assignment.
  UPDATE users SET "orgCode" = NULL, enrolled_at = NULL
   WHERE "orgCode" = target_org_code;

  UPDATE sessions
     SET org_id = NULL, visibility = 'private', organization_replay_shared = FALSE
   WHERE org_id = target_org_code;

  UPDATE users
     SET pending_org_invite_hash = NULL
   WHERE pending_org_invite_hash IN (
     SELECT token_hash FROM pitchnest_org_cohort_invites
      WHERE organization_id = p_organization_id
   );

  -- Delete membership rows first so their count trigger can update the still
  -- existing organization row. The organization's own dependent records then
  -- cascade, while founder users and private pitch history remain intact.
  DELETE FROM pitchnest_org_founder_memberships
   WHERE organization_id = p_organization_id;
  DELETE FROM "Organizations" WHERE id = p_organization_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION delete_organization_account(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_organization_account(INTEGER) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0043', 'Organization profile settings and owner-controlled workspace deletion')
ON CONFLICT (version) DO NOTHING;
COMMIT;
