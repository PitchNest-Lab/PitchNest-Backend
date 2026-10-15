-- Phase 1: multi-business identity and private workspace foundation.
-- Depends on 0018 (schema_migrations).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  business_type TEXT NOT NULL,
  industry TEXT,
  stage TEXT,
  region TEXT,
  problem TEXT,
  solution TEXT,
  target_customer TEXT,
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  profile_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  unpublished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT businesses_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT businesses_name_length CHECK (char_length(name) BETWEEN 2 AND 120),
  CONSTRAINT businesses_type_values CHECK (
    business_type IN ('software', 'services', 'physical', 'traditional', 'other')
  ),
  CONSTRAINT businesses_status_values CHECK (
    status IN ('draft', 'submitted', 'published', 'hidden', 'removed')
  ),
  CONSTRAINT businesses_profile_version_positive CHECK (profile_version > 0)
);

CREATE TABLE IF NOT EXISTS business_members (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  public_display_consent BOOLEAN NOT NULL DEFAULT FALSE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, user_id),
  CONSTRAINT business_members_role_values CHECK (
    role IN ('owner', 'admin', 'editor', 'viewer')
  ),
  CONSTRAINT business_members_status_values CHECK (
    status IN ('invited', 'active', 'removed')
  )
);

CREATE TABLE IF NOT EXISTS business_slug_history (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL UNIQUE,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  public_snapshot JSONB NOT NULL,
  consent_version TEXT NOT NULL,
  approved_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ,
  UNIQUE (business_id, version),
  CONSTRAINT business_publications_status_values CHECK (
    status IN ('active', 'superseded', 'withdrawn')
  )
);

CREATE TABLE IF NOT EXISTS business_audit_log (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS practice_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  context_snapshot JSONB NOT NULL,
  source_question TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT practice_drafts_mode_values CHECK (mode IN ('solo', 'coach', 'panel'))
);

CREATE INDEX IF NOT EXISTS idx_business_members_user_active
  ON business_members (user_id, business_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_business_members_business_active
  ON business_members (business_id, role)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_businesses_status_updated
  ON businesses (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_publications_active
  ON business_publications (business_id, approved_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_business_audit_business_created
  ON business_audit_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_practice_drafts_owner_expiry
  ON practice_drafts (user_id, expires_at DESC);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;
ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_business_created
  ON sessions (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decks_business_created
  ON decks (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;

CREATE OR REPLACE FUNCTION touch_business_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  IF ROW(
    NEW.name, NEW.tagline, NEW.description, NEW.business_type, NEW.industry,
    NEW.stage, NEW.region, NEW.problem, NEW.solution, NEW.target_customer,
    NEW.website_url
  ) IS DISTINCT FROM ROW(
    OLD.name, OLD.tagline, OLD.description, OLD.business_type, OLD.industry,
    OLD.stage, OLD.region, OLD.problem, OLD.solution, OLD.target_customer,
    OLD.website_url
  ) THEN
    NEW.profile_version := OLD.profile_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_touch_row ON businesses;
CREATE TRIGGER businesses_touch_row
  BEFORE UPDATE ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION touch_business_row();

CREATE OR REPLACE FUNCTION create_business_with_owner(
  p_owner_id INTEGER,
  p_slug TEXT,
  p_name TEXT,
  p_tagline TEXT,
  p_description TEXT,
  p_business_type TEXT,
  p_industry TEXT,
  p_stage TEXT,
  p_region TEXT,
  p_problem TEXT,
  p_solution TEXT,
  p_target_customer TEXT,
  p_website_url TEXT
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created businesses;
BEGIN
  INSERT INTO businesses (
    slug, name, tagline, description, business_type, industry, stage, region,
    problem, solution, target_customer, website_url, created_by
  ) VALUES (
    p_slug, p_name, p_tagline, p_description, p_business_type, p_industry,
    p_stage, p_region, p_problem, p_solution, p_target_customer, p_website_url,
    p_owner_id
  )
  RETURNING * INTO created;

  INSERT INTO business_members (
    business_id, user_id, role, status, public_display_consent, joined_at
  ) VALUES (
    created.id, p_owner_id, 'owner', 'active', FALSE, NOW()
  );

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (created.id, p_owner_id, 'business.created');

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION publish_business(
  p_business_id UUID,
  p_actor_id INTEGER,
  p_expected_profile_version INTEGER,
  p_consent_version TEXT
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
  next_publication_version INTEGER;
  snapshot JSONB;
BEGIN
  SELECT * INTO current_business
  FROM businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  IF current_business.status IN ('hidden', 'removed') THEN
    RAISE EXCEPTION 'Business cannot be published in its current state'
      USING ERRCODE = '23514';
  END IF;

  IF current_business.profile_version <> p_expected_profile_version THEN
    RAISE EXCEPTION 'Business changed after preview; review it again'
      USING ERRCODE = '40001';
  END IF;

  IF NULLIF(BTRIM(current_business.tagline), '') IS NULL
    OR NULLIF(BTRIM(current_business.description), '') IS NULL
    OR NULLIF(BTRIM(current_business.industry), '') IS NULL
    OR NULLIF(BTRIM(current_business.stage), '') IS NULL
    OR NULLIF(BTRIM(current_business.region), '') IS NULL THEN
    RAISE EXCEPTION 'Business profile is incomplete'
      USING ERRCODE = '23514';
  END IF;

  UPDATE business_publications
  SET status = 'superseded', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  UPDATE businesses
  SET status = 'published', published_at = NOW(), unpublished_at = NULL
  WHERE id = p_business_id
  RETURNING * INTO current_business;

  SELECT COALESCE(MAX(version), 0) + 1
  INTO next_publication_version
  FROM business_publications
  WHERE business_id = p_business_id;

  snapshot := jsonb_build_object(
    'id', current_business.id,
    'slug', current_business.slug,
    'name', current_business.name,
    'tagline', current_business.tagline,
    'description', current_business.description,
    'businessType', current_business.business_type,
    'industry', current_business.industry,
    'stage', current_business.stage,
    'region', current_business.region,
    'problem', current_business.problem,
    'solution', current_business.solution,
    'targetCustomer', current_business.target_customer,
    'websiteUrl', current_business.website_url,
    'publishedAt', current_business.published_at
  );

  INSERT INTO business_publications (
    business_id, version, profile_version, public_snapshot, consent_version,
    approved_by, status
  ) VALUES (
    p_business_id, next_publication_version, current_business.profile_version,
    snapshot, p_consent_version, p_actor_id, 'active'
  );

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (
    p_business_id,
    p_actor_id,
    'business.published',
    jsonb_build_object(
      'publicationVersion', next_publication_version,
      'profileVersion', current_business.profile_version,
      'consentVersion', p_consent_version
    )
  );

  RETURN current_business;
END;
$$;

CREATE OR REPLACE FUNCTION unpublish_business(
  p_business_id UUID,
  p_actor_id INTEGER
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
BEGIN
  UPDATE businesses
  SET status = 'draft', published_at = NULL, unpublished_at = NOW()
  WHERE id = p_business_id AND status = 'published'
  RETURNING * INTO current_business;

  IF NOT FOUND THEN
    SELECT * INTO current_business FROM businesses WHERE id = p_business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN current_business;
  END IF;

  UPDATE business_publications
  SET status = 'withdrawn', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (p_business_id, p_actor_id, 'business.unpublished');

  RETURN current_business;
END;
$$;

CREATE OR REPLACE FUNCTION archive_business(
  p_business_id UUID,
  p_actor_id INTEGER
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
BEGIN
  UPDATE businesses
  SET status = 'removed', published_at = NULL, unpublished_at = NOW()
  WHERE id = p_business_id AND status <> 'removed'
  RETURNING * INTO current_business;

  IF NOT FOUND THEN
    SELECT * INTO current_business FROM businesses WHERE id = p_business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN current_business;
  END IF;

  UPDATE business_publications
  SET status = 'withdrawn', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (p_business_id, p_actor_id, 'business.archived');

  UPDATE business_members
  SET status = 'removed', updated_at = NOW()
  WHERE business_id = p_business_id;

  RETURN current_business;
END;
$$;

REVOKE ALL ON FUNCTION create_business_with_owner(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_business_with_owner(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION unpublish_business(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unpublish_business(UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION archive_business(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION archive_business(UUID, INTEGER)
  TO service_role;

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_slug_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "businesses_deny_direct" ON businesses;
CREATE POLICY "businesses_deny_direct" ON businesses
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_members_deny_direct" ON business_members;
CREATE POLICY "business_members_deny_direct" ON business_members
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_slug_history_deny_direct" ON business_slug_history;
CREATE POLICY "business_slug_history_deny_direct" ON business_slug_history
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_publications_deny_direct" ON business_publications;
CREATE POLICY "business_publications_deny_direct" ON business_publications
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_audit_log_deny_direct" ON business_audit_log;
CREATE POLICY "business_audit_log_deny_direct" ON business_audit_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "practice_drafts_deny_direct" ON practice_drafts;
CREATE POLICY "practice_drafts_deny_direct" ON practice_drafts
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0019', 'Business identity and private workspace foundation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
