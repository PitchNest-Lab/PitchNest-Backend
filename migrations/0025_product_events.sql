-- Phase 4 (slice D): privacy-safe product analytics.
-- Depends on 0021 (users.is_staff) and 0019 (businesses).
--
-- Design notes
--   * Event names are a fixed allowlist enforced here and in the API.
--   * properties holds only small, allowlisted values (modes, booleans,
--     counts, public slugs). Never free text, search terms, transcripts,
--     deck content, report bodies or contact details. The API strips
--     anything else before insert; the size check is a last guard.
--   * Deleting an account keeps its events for aggregate counts but removes
--     the link to the person (ON DELETE SET NULL).
--   * Only staff can read, and only aggregates.

BEGIN;

CREATE TABLE IF NOT EXISTS product_events (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_events_name_values CHECK (name IN (
    'discover_viewed',
    'business_search_performed',
    'business_profile_opened',
    'business_draft_created',
    'business_published',
    'business_unpublished',
    'business_followed',
    'business_supported',
    'business_comment_posted',
    'business_update_posted',
    'practice_setup_opened',
    'practice_started_from_business',
    'question_sent_to_practice',
    'community_thread_started',
    'community_reply_posted',
    'opportunity_link_opened'
  )),
  CONSTRAINT product_events_properties_size CHECK (pg_column_size(properties) <= 1024)
);

CREATE INDEX IF NOT EXISTS idx_product_events_name_created
  ON product_events (name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_events_created
  ON product_events (created_at DESC);

-- Aggregates only: totals, distinct signed-in users, and the share of events
-- from signed-out visitors, per event name over the last p_days days.
CREATE OR REPLACE FUNCTION staff_event_summary(p_days INTEGER DEFAULT 30)
RETURNS TABLE (
  name TEXT,
  total BIGINT,
  unique_users BIGINT,
  anonymous BIGINT,
  last_seen TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    event.name,
    COUNT(*),
    COUNT(DISTINCT event.user_id),
    COUNT(*) FILTER (WHERE event.user_id IS NULL),
    MAX(event.created_at)
  FROM product_events AS event
  WHERE event.created_at >= NOW() - make_interval(days => LEAST(GREATEST(p_days, 1), 365))
  GROUP BY event.name
  ORDER BY COUNT(*) DESC;
$$;

REVOKE ALL ON FUNCTION staff_event_summary(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_event_summary(INTEGER) TO service_role;

ALTER TABLE product_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_events_deny_direct" ON product_events;
CREATE POLICY "product_events_deny_direct" ON product_events
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0025', 'Privacy-safe product analytics')
ON CONFLICT (version) DO NOTHING;

COMMIT;
