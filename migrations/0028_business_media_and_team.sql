-- Business logos, cover images, and consenting team members on public profiles.
-- Depends on 0019 (businesses, members, publications).
--
--   * logo_file / cover_file name an image the backend has already processed
--     (resized, re-encoded as WebP, all metadata stripped). Drafts live in the
--     private media bucket. When the business is published the backend copies
--     the approved files to public storage, and it removes them again when the
--     business is unpublished, archived or hidden by moderation.
--   * Changing either image bumps profile_version, so the publication preview
--     and the publishing consent always cover the images that go public.
--   * The publication snapshot records the approved file names.
--   * business_members.public_title is the member's own public job title. A
--     member appears on the public profile only while they personally consent
--     (public_display_consent) and the business is published.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS logo_file TEXT,
  ADD COLUMN IF NOT EXISTS cover_file TEXT;

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_logo_file_format;
ALTER TABLE businesses ADD CONSTRAINT businesses_logo_file_format
  CHECK (logo_file IS NULL OR logo_file ~ '^logo-[a-f0-9]{32}\.webp$');

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_cover_file_format;
ALTER TABLE businesses ADD CONSTRAINT businesses_cover_file_format
  CHECK (cover_file IS NULL OR cover_file ~ '^cover-[a-f0-9]{32}\.webp$');

ALTER TABLE business_members
  ADD COLUMN IF NOT EXISTS public_title TEXT;

ALTER TABLE business_members DROP CONSTRAINT IF EXISTS business_members_public_title_length;
ALTER TABLE business_members ADD CONSTRAINT business_members_public_title_length
  CHECK (public_title IS NULL OR char_length(public_title) <= 80);

CREATE INDEX IF NOT EXISTS idx_business_members_public_team
  ON business_members (business_id)
  WHERE status = 'active' AND public_display_consent = TRUE;

CREATE OR REPLACE FUNCTION touch_business_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  IF ROW(
    NEW.name, NEW.tagline, NEW.description, NEW.business_type, NEW.industry,
    NEW.stage, NEW.region, NEW.problem, NEW.solution, NEW.target_customer,
    NEW.website_url, NEW.logo_file, NEW.cover_file
  ) IS DISTINCT FROM ROW(
    OLD.name, OLD.tagline, OLD.description, OLD.business_type, OLD.industry,
    OLD.stage, OLD.region, OLD.problem, OLD.solution, OLD.target_customer,
    OLD.website_url, OLD.logo_file, OLD.cover_file
  ) THEN
    NEW.profile_version := OLD.profile_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Same signature and behaviour as 0019; the snapshot now also records the
-- approved image files. CREATE OR REPLACE keeps the existing grants.
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
    'logoFile', current_business.logo_file,
    'coverFile', current_business.cover_file,
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

INSERT INTO schema_migrations (version, description)
VALUES ('0028', 'Business logos, cover images and consenting public team members')
ON CONFLICT (version) DO NOTHING;

COMMIT;
