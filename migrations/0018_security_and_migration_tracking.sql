-- Phase 0 security baseline
--
-- Earlier PitchNest migrations predate the migration ledger. Do not mark them
-- as applied without checking the target environment. This migration starts the
-- authoritative ledger at 0018; every later migration must record itself.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "schema_migrations_deny_anon" ON schema_migrations;
CREATE POLICY "schema_migrations_deny_anon"
  ON schema_migrations
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Organization dashboards may only read sessions carrying both an explicit
-- organization id and organization visibility. This partial index supports the
-- fail-closed query without changing any legacy private session.
CREATE INDEX IF NOT EXISTS idx_sessions_org_visibility_created
  ON sessions (org_id, visibility, created_at DESC)
  WHERE org_id IS NOT NULL;

-- Existing values are left for a deliberate credential migration. NOT VALID
-- still protects every newly inserted or updated organization credential.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_password_must_be_bcrypt'
      AND conrelid = '"Organizations"'::regclass
  ) THEN
    ALTER TABLE "Organizations"
      ADD CONSTRAINT organizations_password_must_be_bcrypt
      CHECK (
        password IS NULL
        OR password ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'
      ) NOT VALID;
  END IF;
END
$$;

INSERT INTO schema_migrations (version, description)
VALUES ('0018', 'Security baseline and migration tracking')
ON CONFLICT (version) DO NOTHING;

COMMIT;
