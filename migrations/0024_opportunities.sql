-- Phase 4 (slice C): curated opportunities (accelerators, grants, competitions,
-- events, fellowships). Staff-entered only; no public writes.
-- Depends on 0021 (users.is_staff).
--
-- Design notes
--   * Every record names its organizer and links to the official source, and
--     carries last_checked_at so visitors can see how fresh it is.
--   * Open / closing soon / closed is computed at read time from the dates, so
--     a listing can never show a stale status and no expiry job is needed.
--     Listings closed for more than 60 days drop out of the public feed.
--   * The public function returns published rows only.

BEGIN;

CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  organizer TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  eligibility TEXT,
  region TEXT,
  sector TEXT,
  source_url TEXT NOT NULL,
  opens_on DATE,
  closes_on DATE,
  status TEXT NOT NULL DEFAULT 'draft',
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT opportunities_title_length CHECK (char_length(title) BETWEEN 5 AND 140),
  CONSTRAINT opportunities_organizer_length CHECK (char_length(organizer) BETWEEN 2 AND 120),
  CONSTRAINT opportunities_kind_values CHECK (
    kind IN ('accelerator', 'grant', 'competition', 'event', 'fellowship', 'program', 'other')
  ),
  CONSTRAINT opportunities_summary_length CHECK (char_length(summary) BETWEEN 10 AND 1500),
  CONSTRAINT opportunities_eligibility_length CHECK (eligibility IS NULL OR char_length(eligibility) <= 1000),
  CONSTRAINT opportunities_region_length CHECK (region IS NULL OR char_length(region) <= 120),
  CONSTRAINT opportunities_sector_length CHECK (sector IS NULL OR char_length(sector) <= 100),
  CONSTRAINT opportunities_source_url_format CHECK (source_url ~* '^https?://[^\s]+$' AND char_length(source_url) <= 500),
  CONSTRAINT opportunities_dates_order CHECK (opens_on IS NULL OR closes_on IS NULL OR opens_on <= closes_on),
  CONSTRAINT opportunities_status_values CHECK (status IN ('draft', 'published', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_opportunities_public
  ON opportunities (closes_on, created_at DESC)
  WHERE status = 'published';

CREATE OR REPLACE FUNCTION list_public_opportunities(
  p_kind TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_include_closed BOOLEAN DEFAULT FALSE,
  p_limit INTEGER DEFAULT 60
)
RETURNS TABLE (
  opportunity_id UUID,
  title TEXT,
  organizer TEXT,
  kind TEXT,
  summary TEXT,
  eligibility TEXT,
  region TEXT,
  sector TEXT,
  source_url TEXT,
  opens_on DATE,
  closes_on DATE,
  last_checked_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    opportunity.id,
    opportunity.title,
    opportunity.organizer,
    opportunity.kind,
    opportunity.summary,
    opportunity.eligibility,
    opportunity.region,
    opportunity.sector,
    opportunity.source_url,
    opportunity.opens_on,
    opportunity.closes_on,
    opportunity.last_checked_at
  FROM opportunities AS opportunity
  WHERE opportunity.status = 'published'
    AND (opportunity.closes_on IS NULL OR opportunity.closes_on >= CURRENT_DATE - 60)
    AND (p_include_closed OR opportunity.closes_on IS NULL OR opportunity.closes_on >= CURRENT_DATE)
    AND (NULLIF(BTRIM(p_kind), '') IS NULL OR opportunity.kind = BTRIM(p_kind))
    AND (
      NULLIF(BTRIM(p_region), '') IS NULL
      OR opportunity.region ILIKE '%' || BTRIM(p_region) || '%'
    )
    AND (
      NULLIF(BTRIM(p_query), '') IS NULL
      OR opportunity.title ILIKE '%' || BTRIM(p_query) || '%'
      OR opportunity.organizer ILIKE '%' || BTRIM(p_query) || '%'
      OR opportunity.summary ILIKE '%' || BTRIM(p_query) || '%'
      OR opportunity.sector ILIKE '%' || BTRIM(p_query) || '%'
    )
  ORDER BY
    (opportunity.closes_on IS NOT NULL AND opportunity.closes_on < CURRENT_DATE),
    opportunity.closes_on ASC NULLS LAST,
    opportunity.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

REVOKE ALL ON FUNCTION list_public_opportunities(TEXT, TEXT, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_opportunities(TEXT, TEXT, TEXT, BOOLEAN, INTEGER) TO service_role;

ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "opportunities_deny_direct" ON opportunities;
CREATE POLICY "opportunities_deny_direct" ON opportunities
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0024', 'Curated opportunities')
ON CONFLICT (version) DO NOTHING;

COMMIT;
