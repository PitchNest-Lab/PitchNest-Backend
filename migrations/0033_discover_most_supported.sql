-- Discover lists the most-supported businesses first.
-- Depends on 0020 (snapshot-only discovery reads) and 0021 (business_supports).
--
-- discover_public_businesses_by_support takes the same filters as
-- discover_public_businesses (0020) and orders by support count, then newest.
-- The cursor carries all three sort keys. 0020's function is unchanged: it
-- still serves newest-first lists and any backend deployed before this one.

BEGIN;

CREATE OR REPLACE FUNCTION discover_public_businesses_by_support(
  p_query TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_business_type TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_cursor_support_count BIGINT DEFAULT NULL,
  p_cursor_published_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_publication_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 13
)
RETURNS TABLE (
  publication_id UUID,
  published_at TIMESTAMPTZ,
  public_snapshot JSONB,
  support_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT listed.publication_id, listed.published_at, listed.public_snapshot, listed.support_count
  FROM (
    SELECT
      publication.id AS publication_id,
      publication.approved_at AS published_at,
      publication.public_snapshot,
      (SELECT COUNT(*) FROM business_supports AS support
        WHERE support.business_id = business.id) AS support_count
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
  ) AS listed
  WHERE p_cursor_support_count IS NULL
    OR p_cursor_published_at IS NULL
    OR p_cursor_publication_id IS NULL
    OR (listed.support_count, listed.published_at, listed.publication_id)
      < (p_cursor_support_count, p_cursor_published_at, p_cursor_publication_id)
  ORDER BY listed.support_count DESC, listed.published_at DESC, listed.publication_id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 25);
$$;

REVOKE ALL ON FUNCTION discover_public_businesses_by_support(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_public_businesses_by_support(
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TIMESTAMPTZ, UUID, INTEGER
) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0033', 'Discover lists the most-supported businesses first')
ON CONFLICT (version) DO NOTHING;

COMMIT;
