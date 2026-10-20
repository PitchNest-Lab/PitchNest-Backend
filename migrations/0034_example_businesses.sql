-- Example businesses: published profiles that show what a complete business
-- page looks like. A business is an example while its active publication
-- snapshot carries "isExample": true. Founders cannot set it; whoever loads
-- the examples does.
-- Depends on 0020 (discovery reads), 0026 (public pitches) and 0033.
--
--   * discover_public_businesses_ranked lists real businesses before
--     examples, then by support count (p_by_support) or newest first, with the
--     same filters as 0020 and 0033 and a cursor that carries every sort key.
--     0020's and 0033's functions are unchanged for backends deployed before
--     this one.
--   * The sitemap leaves examples out, so search engines are not sent to them.
--   * list_public_pitches also says whether a pitch's business is an example.
--     It is recreated because its result gains a column; older backends
--     ignore the extra column.

BEGIN;

CREATE OR REPLACE FUNCTION discover_public_businesses_ranked(
  p_query TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_business_type TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_by_support BOOLEAN DEFAULT TRUE,
  p_cursor_is_example BOOLEAN DEFAULT NULL,
  p_cursor_support_count BIGINT DEFAULT NULL,
  p_cursor_published_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_publication_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 13
)
RETURNS TABLE (
  publication_id UUID,
  published_at TIMESTAMPTZ,
  public_snapshot JSONB,
  -- 0 on every row when p_by_support is false.
  support_count BIGINT,
  is_example BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT listed.publication_id, listed.published_at, listed.public_snapshot, listed.support_count, listed.is_example
  FROM (
    SELECT
      publication.id AS publication_id,
      publication.approved_at AS published_at,
      publication.public_snapshot,
      CASE WHEN p_by_support THEN
        (SELECT COUNT(*) FROM business_supports AS support
          WHERE support.business_id = business.id)
      ELSE 0 END AS support_count,
      COALESCE(publication.public_snapshot ->> 'isExample', 'false') = 'true' AS is_example
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
  -- Real businesses (NOT is_example) come first, so every key sorts
  -- descending and the cursor compares as one row.
  WHERE p_cursor_is_example IS NULL
    OR p_cursor_support_count IS NULL
    OR p_cursor_published_at IS NULL
    OR p_cursor_publication_id IS NULL
    OR (NOT listed.is_example, listed.support_count, listed.published_at, listed.publication_id)
      < (NOT p_cursor_is_example, p_cursor_support_count, p_cursor_published_at, p_cursor_publication_id)
  ORDER BY (NOT listed.is_example) DESC, listed.support_count DESC, listed.published_at DESC, listed.publication_id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 25);
$$;

REVOKE ALL ON FUNCTION discover_public_businesses_ranked(
  TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_public_businesses_ranked(
  TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BIGINT, TIMESTAMPTZ, UUID, INTEGER
) TO service_role;

-- Same as 0020, without examples. CREATE OR REPLACE keeps the grants.
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
    AND COALESCE(publication.public_snapshot ->> 'isExample', 'false') <> 'true'
  GROUP BY business.id, business.slug
  ORDER BY MAX(publication.approved_at) DESC
  LIMIT 49998;
$$;

-- Same as 0026, plus business_is_example.
DROP FUNCTION IF EXISTS list_public_pitches(TIMESTAMPTZ, UUID, INTEGER);
CREATE FUNCTION list_public_pitches(
  p_cursor_approved_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_pitch_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 13
)
RETURNS TABLE (
  pitch_id UUID,
  headline TEXT,
  excerpt TEXT,
  feedback_ask TEXT,
  approved_at TIMESTAMPTZ,
  feedback_count BIGINT,
  business_slug TEXT,
  business_name TEXT,
  business_tagline TEXT,
  business_industry TEXT,
  business_region TEXT,
  business_is_example BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pitch.id,
    pitch.headline,
    LEFT(pitch.body, 280),
    pitch.feedback_ask,
    pitch.approved_at,
    (SELECT COUNT(*) FROM business_comments AS comment
      WHERE comment.pitch_id = pitch.id AND comment.status = 'visible'),
    publication.public_snapshot ->> 'slug',
    publication.public_snapshot ->> 'name',
    publication.public_snapshot ->> 'tagline',
    publication.public_snapshot ->> 'industry',
    publication.public_snapshot ->> 'region',
    COALESCE(publication.public_snapshot ->> 'isExample', 'false') = 'true'
  FROM public_pitches AS pitch
  INNER JOIN businesses AS business ON business.id = pitch.business_id
  INNER JOIN business_publications AS publication
    ON publication.business_id = business.id AND publication.status = 'active'
  WHERE pitch.status = 'published'
    AND business.status = 'published'
    AND publication.public_snapshot ->> 'slug' = business.slug
    AND (
      p_cursor_approved_at IS NULL
      OR p_cursor_pitch_id IS NULL
      OR (pitch.approved_at, pitch.id) < (p_cursor_approved_at, p_cursor_pitch_id)
    )
  ORDER BY pitch.approved_at DESC, pitch.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 25);
$$;

REVOKE ALL ON FUNCTION list_public_pitches(TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_pitches(TIMESTAMPTZ, UUID, INTEGER) TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0034', 'Example businesses: real ones listed first, examples out of the sitemap')
ON CONFLICT (version) DO NOTHING;

COMMIT;
