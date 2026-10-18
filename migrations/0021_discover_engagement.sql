-- Phase 2: Discover engagement (supports, follows, comments, reports) and the
-- staff moderation queue.
-- Depends on 0020 (snapshot-only public reads) and 0019 (business identity).
--
-- Design notes
--   * Every public action resolves its target through
--     resolve_public_business_id(), so a draft, hidden, removed or unpublished
--     business can never be supported, followed, commented on or reported.
--   * Counts are computed on read from indexed tables instead of stored
--     counters, so a count can never drift from the rows it summarises.
--   * Members of a business cannot support or follow their own business.
--   * Public serializers never receive reporter identities, and the public
--     comment list never exposes author user ids (the controller uses them only
--     to compute viewer flags).
--   * All functions are SECURITY DEFINER, callable only by service_role, in the
--     same style as 0019 and 0020.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Staff flag for moderation. Granted manually:
--   UPDATE users SET is_staff = TRUE WHERE email = '<moderator email>';
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_supports (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS business_follows (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS business_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Account deletion removes the person's comments with them.
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  moderated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  moderated_at TIMESTAMPTZ,
  moderation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_comments_body_length CHECK (char_length(body) BETWEEN 2 AND 1000),
  CONSTRAINT business_comments_status_values CHECK (status IN ('visible', 'hidden', 'removed')),
  CONSTRAINT business_comments_reason_length CHECK (
    moderation_reason IS NULL OR char_length(moderation_reason) <= 500
  )
);

CREATE TABLE IF NOT EXISTS content_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_reports_entity_values CHECK (entity_type IN ('business', 'comment')),
  CONSTRAINT content_reports_reason_values CHECK (
    reason IN ('spam', 'harassment', 'misleading', 'inappropriate', 'intellectual_property', 'other')
  ),
  CONSTRAINT content_reports_status_values CHECK (status IN ('open', 'actioned', 'dismissed')),
  CONSTRAINT content_reports_details_length CHECK (details IS NULL OR char_length(details) <= 1000),
  CONSTRAINT content_reports_note_length CHECK (
    resolution_note IS NULL OR char_length(resolution_note) <= 500
  )
);

CREATE INDEX IF NOT EXISTS idx_business_supports_user
  ON business_supports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_follows_user
  ON business_follows (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_comments_public
  ON business_comments (business_id, created_at DESC, id DESC)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_business_comments_author
  ON business_comments (author_id, created_at DESC);
-- One open report per person per item; re-reporting is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_reports_open_per_reporter
  ON content_reports (reporter_id, entity_type, entity_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_content_reports_queue
  ON content_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_content_reports_entity_open
  ON content_reports (entity_type, entity_id)
  WHERE status = 'open';

-- ─────────────────────────────────────────────────────────────────────────────
-- Public resolution: the single gate every engagement action goes through.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resolve_public_business_id(p_slug TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business.id
  FROM businesses AS business
  INNER JOIN business_publications AS publication
    ON publication.business_id = business.id
  WHERE business.slug = BTRIM(p_slug)
    AND business.status = 'published'
    AND publication.status = 'active'
    AND publication.public_snapshot ->> 'slug' = business.slug
  LIMIT 1;
$$;

-- Counts plus the viewer's own support/follow state for a set of public
-- businesses. Unpublished ids are silently dropped.
CREATE OR REPLACE FUNCTION public_business_engagement(
  p_business_ids UUID[],
  p_viewer_id INTEGER DEFAULT NULL
)
RETURNS TABLE (
  engaged_business_id UUID,
  support_count BIGINT,
  follower_count BIGINT,
  comment_count BIGINT,
  viewer_supports BOOLEAN,
  viewer_follows BOOLEAN,
  viewer_is_member BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    business.id,
    (SELECT COUNT(*) FROM business_supports AS s WHERE s.business_id = business.id),
    (SELECT COUNT(*) FROM business_follows AS f WHERE f.business_id = business.id),
    (SELECT COUNT(*) FROM business_comments AS c
      WHERE c.business_id = business.id AND c.status = 'visible'),
    (p_viewer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM business_supports AS s
      WHERE s.business_id = business.id AND s.user_id = p_viewer_id)),
    (p_viewer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM business_follows AS f
      WHERE f.business_id = business.id AND f.user_id = p_viewer_id)),
    (p_viewer_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM business_members AS m
      WHERE m.business_id = business.id AND m.user_id = p_viewer_id AND m.status = 'active'))
  FROM businesses AS business
  WHERE business.id = ANY(p_business_ids)
    AND business.status = 'published'
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION public_business_engagement_by_slug(
  p_slug TEXT,
  p_viewer_id INTEGER DEFAULT NULL
)
RETURNS TABLE (
  engaged_business_id UUID,
  support_count BIGINT,
  follower_count BIGINT,
  comment_count BIGINT,
  viewer_supports BOOLEAN,
  viewer_follows BOOLEAN,
  viewer_is_member BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public_business_engagement(
    ARRAY(SELECT resolve_public_business_id(p_slug)),
    p_viewer_id
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Support / follow (idempotent; repeated calls converge on the same state)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_business_engagement(
  p_slug TEXT,
  p_user_id INTEGER,
  p_kind TEXT,
  p_active BOOLEAN
)
RETURNS TABLE (
  engaged_business_id UUID,
  is_active BOOLEAN,
  total_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  v_business_id := resolve_public_business_id(p_slug);
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_active AND EXISTS (
    SELECT 1 FROM business_members AS m
    WHERE m.business_id = v_business_id AND m.user_id = p_user_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Members cannot support or follow their own business'
      USING ERRCODE = '42501';
  END IF;

  IF p_kind = 'support' THEN
    IF p_active THEN
      INSERT INTO business_supports (business_id, user_id)
      VALUES (v_business_id, p_user_id)
      ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM business_supports AS s
      WHERE s.business_id = v_business_id AND s.user_id = p_user_id;
    END IF;
    RETURN QUERY
      SELECT v_business_id, p_active,
        (SELECT COUNT(*) FROM business_supports AS s WHERE s.business_id = v_business_id);
  ELSIF p_kind = 'follow' THEN
    IF p_active THEN
      INSERT INTO business_follows (business_id, user_id)
      VALUES (v_business_id, p_user_id)
      ON CONFLICT DO NOTHING;
    ELSE
      DELETE FROM business_follows AS f
      WHERE f.business_id = v_business_id AND f.user_id = p_user_id;
    END IF;
    RETURN QUERY
      SELECT v_business_id, p_active,
        (SELECT COUNT(*) FROM business_follows AS f WHERE f.business_id = v_business_id);
  ELSE
    RAISE EXCEPTION 'Invalid engagement kind' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_business_comment(
  p_slug TEXT,
  p_author_id INTEGER,
  p_body TEXT
)
RETURNS business_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  created business_comments;
BEGIN
  v_business_id := resolve_public_business_id(p_slug);
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  -- Identical text from the same person on the same business within ten
  -- minutes is a double-submit or a spam burst, never a new thought.
  IF EXISTS (
    SELECT 1 FROM business_comments AS c
    WHERE c.business_id = v_business_id
      AND c.author_id = p_author_id
      AND c.body = p_body
      AND c.created_at > NOW() - INTERVAL '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Duplicate comment' USING ERRCODE = '23505';
  END IF;

  INSERT INTO business_comments (business_id, author_id, body)
  VALUES (v_business_id, p_author_id, p_body)
  RETURNING * INTO created;

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION list_public_business_comments(
  p_slug TEXT,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_comment_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 21
)
RETURNS TABLE (
  comment_id UUID,
  comment_business_id UUID,
  body TEXT,
  created_at TIMESTAMPTZ,
  author_id INTEGER,
  author_name TEXT,
  author_avatar_url TEXT,
  author_is_member BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    comment.id,
    comment.business_id,
    comment.body,
    comment.created_at,
    comment.author_id,
    author.name,
    author.avatar_url,
    EXISTS (
      SELECT 1 FROM business_members AS m
      WHERE m.business_id = comment.business_id
        AND m.user_id = comment.author_id
        AND m.status = 'active'
    )
  FROM business_comments AS comment
  INNER JOIN users AS author ON author.id = comment.author_id
  WHERE comment.business_id = resolve_public_business_id(p_slug)
    AND comment.status = 'visible'
    AND (
      p_cursor_created_at IS NULL
      OR p_cursor_comment_id IS NULL
      OR (comment.created_at, comment.id) < (p_cursor_created_at, p_cursor_comment_id)
    )
  ORDER BY comment.created_at DESC, comment.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 51);
$$;

-- The author removes their own comment; an owner/admin of the business hides
-- a comment on their profile. Anyone else is refused.
CREATE OR REPLACE FUNCTION remove_business_comment(
  p_comment_id UUID,
  p_actor_id INTEGER
)
RETURNS business_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target business_comments;
  v_is_manager BOOLEAN;
BEGIN
  SELECT * INTO target FROM business_comments WHERE id = p_comment_id FOR UPDATE;
  IF NOT FOUND OR target.status = 'removed' THEN
    RAISE EXCEPTION 'Comment not found' USING ERRCODE = 'P0002';
  END IF;

  IF target.author_id = p_actor_id THEN
    UPDATE business_comments
    SET status = 'removed', updated_at = NOW()
    WHERE id = p_comment_id
    RETURNING * INTO target;
    RETURN target;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM business_members AS m
    WHERE m.business_id = target.business_id
      AND m.user_id = p_actor_id
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
  ) INTO v_is_manager;

  IF NOT v_is_manager THEN
    RAISE EXCEPTION 'Not allowed to remove this comment' USING ERRCODE = '42501';
  END IF;

  UPDATE business_comments
  SET status = 'hidden',
      moderated_by = p_actor_id,
      moderated_at = NOW(),
      moderation_reason = 'Hidden by business',
      updated_at = NOW()
  WHERE id = p_comment_id
  RETURNING * INTO target;

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (target.business_id, p_actor_id, 'comment.hidden_by_business',
          jsonb_build_object('commentId', p_comment_id));

  RETURN target;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reports
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_content_report(
  p_reporter_id INTEGER,
  p_entity_type TEXT,
  p_slug TEXT,
  p_comment_id UUID,
  p_reason TEXT,
  p_details TEXT
)
RETURNS TABLE (report_id UUID, already_reported BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_entity_id UUID;
  v_report_id UUID;
BEGIN
  IF p_entity_type = 'business' THEN
    v_business_id := resolve_public_business_id(p_slug);
    v_entity_id := v_business_id;
  ELSIF p_entity_type = 'comment' THEN
    SELECT c.business_id, c.id INTO v_business_id, v_entity_id
    FROM business_comments AS c
    WHERE c.id = p_comment_id
      AND c.status = 'visible'
      AND c.business_id = resolve_public_business_id(p_slug);
  ELSE
    RAISE EXCEPTION 'Invalid report target' USING ERRCODE = '22023';
  END IF;

  IF v_business_id IS NULL OR v_entity_id IS NULL THEN
    RAISE EXCEPTION 'Reported item not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO content_reports (reporter_id, entity_type, entity_id, business_id, reason, details)
  VALUES (p_reporter_id, p_entity_type, v_entity_id, v_business_id, p_reason, NULLIF(BTRIM(p_details), ''))
  ON CONFLICT (reporter_id, entity_type, entity_id) WHERE status = 'open' DO NOTHING
  RETURNING id INTO v_report_id;

  IF v_report_id IS NULL THEN
    SELECT r.id INTO v_report_id
    FROM content_reports AS r
    WHERE r.reporter_id = p_reporter_id
      AND r.entity_type = p_entity_type
      AND r.entity_id = v_entity_id
      AND r.status = 'open';
    RETURN QUERY SELECT v_report_id, TRUE;
  ELSE
    RETURN QUERY SELECT v_report_id, FALSE;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Staff moderation
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION staff_list_reports(
  p_status TEXT DEFAULT 'open',
  p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
  report_id UUID,
  entity_type TEXT,
  entity_id UUID,
  reason TEXT,
  details TEXT,
  report_status TEXT,
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  business_id UUID,
  business_name TEXT,
  business_slug TEXT,
  business_status TEXT,
  comment_body TEXT,
  comment_status TEXT,
  open_reports_for_entity BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    report.id,
    report.entity_type,
    report.entity_id,
    report.reason,
    report.details,
    report.status,
    report.created_at,
    report.resolved_at,
    report.resolution_note,
    business.id,
    business.name,
    business.slug,
    business.status,
    comment.body,
    comment.status,
    (SELECT COUNT(*) FROM content_reports AS other
      WHERE other.entity_type = report.entity_type
        AND other.entity_id = report.entity_id
        AND other.status = 'open')
  FROM content_reports AS report
  INNER JOIN businesses AS business ON business.id = report.business_id
  LEFT JOIN business_comments AS comment
    ON report.entity_type = 'comment' AND comment.id = report.entity_id
  WHERE report.status = p_status
  ORDER BY
    CASE WHEN p_status = 'open' THEN report.created_at END ASC,
    CASE WHEN p_status <> 'open' THEN report.resolved_at END DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- Resolves a report. 'hide' hides the reported comment or business and closes
-- every open report on that same item; 'dismiss' closes only this report.
CREATE OR REPLACE FUNCTION staff_resolve_report(
  p_report_id UUID,
  p_actor_id INTEGER,
  p_action TEXT,
  p_note TEXT
)
RETURNS content_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target content_reports;
  v_note TEXT := NULLIF(BTRIM(p_note), '');
BEGIN
  SELECT * INTO target FROM content_reports WHERE id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
  END IF;
  IF target.status <> 'open' THEN
    RAISE EXCEPTION 'Report already resolved' USING ERRCODE = '55000';
  END IF;

  IF p_action = 'dismiss' THEN
    UPDATE content_reports
    SET status = 'dismissed', resolved_by = p_actor_id, resolved_at = NOW(), resolution_note = v_note
    WHERE id = p_report_id
    RETURNING * INTO target;
  ELSIF p_action = 'hide' THEN
    IF target.entity_type = 'comment' THEN
      UPDATE business_comments
      SET status = 'hidden', moderated_by = p_actor_id, moderated_at = NOW(),
          moderation_reason = COALESCE(v_note, 'Hidden by PitchNest moderation'), updated_at = NOW()
      WHERE id = target.entity_id AND status = 'visible';
    ELSE
      UPDATE businesses
      SET status = 'hidden', published_at = NULL, unpublished_at = NOW()
      WHERE id = target.entity_id AND status <> 'removed';
      UPDATE business_publications
      SET status = 'withdrawn', withdrawn_at = NOW()
      WHERE business_id = target.entity_id AND status = 'active';
    END IF;

    UPDATE content_reports
    SET status = 'actioned', resolved_by = p_actor_id, resolved_at = NOW(), resolution_note = v_note
    WHERE entity_type = target.entity_type AND entity_id = target.entity_id AND status = 'open';

    SELECT * INTO target FROM content_reports WHERE id = p_report_id;
  ELSE
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (
    target.business_id,
    p_actor_id,
    CASE WHEN p_action = 'hide' THEN 'moderation.' || target.entity_type || '.hidden'
         ELSE 'moderation.report.dismissed' END,
    jsonb_build_object('reportId', p_report_id, 'entityId', target.entity_id, 'note', v_note)
  );

  RETURN target;
END;
$$;

-- Reverses a moderation hide. A restored business returns to draft so its
-- owner must review and republish it; it never silently reappears.
CREATE OR REPLACE FUNCTION staff_restore_content(
  p_entity_type TEXT,
  p_entity_id UUID,
  p_actor_id INTEGER
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  IF p_entity_type = 'comment' THEN
    UPDATE business_comments
    SET status = 'visible', moderated_by = p_actor_id, moderated_at = NOW(),
        moderation_reason = NULL, updated_at = NOW()
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING business_id INTO v_business_id;
  ELSIF p_entity_type = 'business' THEN
    UPDATE businesses
    SET status = 'draft'
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING id INTO v_business_id;
  ELSE
    RAISE EXCEPTION 'Invalid restore target' USING ERRCODE = '22023';
  END IF;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Nothing to restore' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (v_business_id, p_actor_id, 'moderation.' || p_entity_type || '.restored',
          jsonb_build_object('entityId', p_entity_id));

  RETURN v_business_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: service_role only
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION resolve_public_business_id(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_public_business_id(TEXT) TO service_role;

REVOKE ALL ON FUNCTION public_business_engagement(UUID[], INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public_business_engagement(UUID[], INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public_business_engagement_by_slug(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public_business_engagement_by_slug(TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION set_business_engagement(TEXT, INTEGER, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_business_engagement(TEXT, INTEGER, TEXT, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION create_business_comment(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_business_comment(TEXT, INTEGER, TEXT) TO service_role;

REVOKE ALL ON FUNCTION list_public_business_comments(TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_business_comments(TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION remove_business_comment(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION remove_business_comment(UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION create_content_report(INTEGER, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_content_report(INTEGER, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION staff_list_reports(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_list_reports(TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: deny direct access through the anon/authenticated keys
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE business_supports ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "business_supports_deny_direct" ON business_supports;
CREATE POLICY "business_supports_deny_direct" ON business_supports
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_follows_deny_direct" ON business_follows;
CREATE POLICY "business_follows_deny_direct" ON business_follows
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_comments_deny_direct" ON business_comments;
CREATE POLICY "business_comments_deny_direct" ON business_comments
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "content_reports_deny_direct" ON content_reports;
CREATE POLICY "content_reports_deny_direct" ON content_reports
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0021', 'Discover engagement, reports and staff moderation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
