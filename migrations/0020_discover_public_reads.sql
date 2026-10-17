-- Phase 2: snapshot-only public discovery reads.
-- Depends on 0019 (business identity and publication snapshots).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_business_publications_discover_cursor
  ON business_publications (approved_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_business_publications_discover_filters
  ON business_publications (
    (LOWER(public_snapshot ->> 'businessType')),
    (LOWER(public_snapshot ->> 'industry')),
    (LOWER(public_snapshot ->> 'stage')),
    (LOWER(public_snapshot ->> 'region'))
  )
  WHERE status = 'active';

-- The application service role is the only caller. Returning the approved JSON
-- snapshot prevents a future private column on businesses from silently becoming
-- public through SELECT * or an expanding join.
CREATE OR REPLACE FUNCTION discover_public_businesses(
  p_query TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_business_type TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_cursor_published_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_publication_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 13
)
RETURNS TABLE (
  publication_id UUID,
  published_at TIMESTAMPTZ,
  public_snapshot JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    publication.id AS publication_id,
    publication.approved_at AS published_at,
    publication.public_snapshot
  FROM business_publications AS publication
  INNER JOIN businesses AS business
    ON business.id = publication.business_id
  WHERE publication.status = 'active'
    AND business.status = 'published'
    AND business.slug = publication.public_snapshot ->> 'slug'
    AND (
      NULLIF(BTRIM(p_query), '') IS NULL
      OR publication.public_snapshot ->> 'name' ILIKE '%' || BTRIM(p_query) || '%'
      OR publication.public_snapshot ->> 'tagline' ILIKE '%' || BTRIM(p_query) || '%'
      OR publication.public_snapshot ->> 'industry' ILIKE '%' || BTRIM(p_query) || '%'
      OR publication.public_snapshot ->> 'businessType' ILIKE '%' || BTRIM(p_query) || '%'
      OR publication.public_snapshot ->> 'region' ILIKE '%' || BTRIM(p_query) || '%'
    )
    AND (
      NULLIF(BTRIM(p_industry), '') IS NULL
      OR LOWER(publication.public_snapshot ->> 'industry') = LOWER(BTRIM(p_industry))
    )
    AND (
      NULLIF(BTRIM(p_business_type), '') IS NULL
      OR LOWER(publication.public_snapshot ->> 'businessType') = LOWER(BTRIM(p_business_type))
    )
    AND (
      NULLIF(BTRIM(p_stage), '') IS NULL
      OR LOWER(publication.public_snapshot ->> 'stage') = LOWER(BTRIM(p_stage))
    )
    AND (
      NULLIF(BTRIM(p_region), '') IS NULL
      OR LOWER(publication.public_snapshot ->> 'region') = LOWER(BTRIM(p_region))
    )
    AND (
      p_cursor_published_at IS NULL
      OR p_cursor_publication_id IS NULL
      OR (publication.approved_at, publication.id)
        < (p_cursor_published_at, p_cursor_publication_id)
    )
  ORDER BY publication.approved_at DESC, publication.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 25);
$$;

CREATE OR REPLACE FUNCTION get_public_business_by_slug(p_slug TEXT)
RETURNS TABLE (
  published_at TIMESTAMPTZ,
  public_snapshot JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT publication.approved_at, publication.public_snapshot
  FROM business_publications AS publication
  INNER JOIN businesses AS business
    ON business.id = publication.business_id
  WHERE publication.status = 'active'
    AND business.status = 'published'
    AND business.slug = BTRIM(p_slug)
    AND business.slug = publication.public_snapshot ->> 'slug'
  ORDER BY publication.approved_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION list_public_business_sitemap()
RETURNS TABLE (
  slug TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    business.slug,
    MAX(publication.approved_at) AS updated_at
  FROM business_publications AS publication
  INNER JOIN businesses AS business
    ON business.id = publication.business_id
  WHERE publication.status = 'active'
    AND business.status = 'published'
    AND business.slug = publication.public_snapshot ->> 'slug'
  GROUP BY business.id, business.slug
  ORDER BY MAX(publication.approved_at) DESC
  LIMIT 49998;
$$;

REVOKE ALL ON FUNCTION discover_public_businesses(
  TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_public_businesses(
  TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION get_public_business_by_slug(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_public_business_by_slug(TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION list_public_business_sitemap()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_business_sitemap()
  TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0020', 'Snapshot-only public business discovery reads')
ON CONFLICT (version) DO NOTHING;

COMMIT;
