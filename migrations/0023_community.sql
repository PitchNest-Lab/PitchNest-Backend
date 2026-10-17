-- Phase 4 (slice B): community discussions, reply notifications, and
-- moderation of community content through the existing report queue.
-- Depends on 0022 (notifications, notification_enabled) and 0021 (reports).
--
-- Design notes
--   * Threads and replies are created through functions that refuse duplicate
--     bursts and replies to hidden threads.
--   * A reply notifies the thread's author (unless they wrote it), honouring
--     users.settings.notifications.communityReplies (missing = on).
--   * content_reports now covers community items, which have no business, so
--     business_id becomes nullable with a check that business reports keep it.
--   * Community moderation is logged in community_moderation_log because
--     business_audit_log requires a business.
--   * All functions are SECURITY DEFINER and callable only by service_role.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_threads_topic_values CHECK (
    topic IN ('pitching', 'fundraising', 'growth', 'operations', 'validation', 'hiring', 'general')
  ),
  CONSTRAINT community_threads_title_length CHECK (char_length(title) BETWEEN 5 AND 140),
  CONSTRAINT community_threads_body_length CHECK (char_length(body) BETWEEN 10 AND 3000),
  CONSTRAINT community_threads_status_values CHECK (status IN ('visible', 'hidden', 'removed'))
);

CREATE TABLE IF NOT EXISTS community_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES community_threads(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT community_replies_body_length CHECK (char_length(body) BETWEEN 2 AND 2000),
  CONSTRAINT community_replies_status_values CHECK (status IN ('visible', 'hidden', 'removed'))
);

CREATE TABLE IF NOT EXISTS community_moderation_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_threads_activity
  ON community_threads (last_activity_at DESC, id DESC)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_community_threads_topic_activity
  ON community_threads (topic, last_activity_at DESC, id DESC)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_community_threads_author
  ON community_threads (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_replies_thread
  ON community_replies (thread_id, created_at, id)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS idx_community_replies_author
  ON community_replies (author_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reports: allow community items, which have no business
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE content_reports ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_entity_values;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_entity_values
  CHECK (entity_type IN ('business', 'comment', 'thread', 'reply'));
ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_business_required;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_business_required
  CHECK (business_id IS NOT NULL OR entity_type IN ('thread', 'reply'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Notifications: community replies
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_values;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_values
  CHECK (type IN ('business_comment', 'business_update', 'community_reply'));

CREATE OR REPLACE FUNCTION on_community_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'visible' THEN
    RETURN NEW;
  END IF;
  UPDATE community_threads
  SET last_activity_at = NEW.created_at
  WHERE id = NEW.thread_id;

  INSERT INTO notifications (user_id, type, entity_id)
  SELECT thread.author_id, 'community_reply', NEW.id
  FROM community_threads AS thread
  INNER JOIN users AS recipient ON recipient.id = thread.author_id
  WHERE thread.id = NEW.thread_id
    AND thread.status = 'visible'
    AND thread.author_id <> NEW.author_id
    AND notification_enabled(recipient.settings, 'communityReplies');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS community_replies_after_insert ON community_replies;
CREATE TRIGGER community_replies_after_insert
  AFTER INSERT ON community_replies
  FOR EACH ROW
  EXECUTE FUNCTION on_community_reply();

-- The return shape changes (thread columns), so drop and recreate.
DROP FUNCTION IF EXISTS list_user_notifications(INTEGER, INTEGER);
CREATE FUNCTION list_user_notifications(
  p_user_id INTEGER,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  notification_id UUID,
  type TEXT,
  created_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  business_id UUID,
  business_name TEXT,
  business_slug TEXT,
  business_status TEXT,
  thread_id UUID,
  thread_title TEXT,
  excerpt TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    note.id,
    note.type,
    note.created_at,
    note.read_at,
    business.id,
    business.name,
    business.slug,
    business.status,
    thread.id,
    thread.title,
    LEFT(COALESCE(comment.body, business_update.body, reply.body), 140)
  FROM notifications AS note
  LEFT JOIN businesses AS business ON business.id = note.business_id
  LEFT JOIN business_comments AS comment
    ON note.type = 'business_comment' AND comment.id = note.entity_id
  LEFT JOIN business_updates AS business_update
    ON note.type = 'business_update' AND business_update.id = note.entity_id
  LEFT JOIN community_replies AS reply
    ON note.type = 'community_reply' AND reply.id = note.entity_id
  LEFT JOIN community_threads AS thread
    ON thread.id = reply.thread_id
  WHERE note.user_id = p_user_id
    AND (
      (note.type = 'business_comment' AND comment.status = 'visible'
        AND business.status IS DISTINCT FROM 'removed')
      OR (note.type = 'business_update' AND business_update.status = 'visible'
        AND business.status = 'published')
      OR (note.type = 'community_reply' AND reply.status = 'visible'
        AND thread.status = 'visible')
    )
  ORDER BY note.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Writes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_community_thread(
  p_author_id INTEGER,
  p_topic TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS community_threads
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created community_threads;
BEGIN
  IF EXISTS (
    SELECT 1 FROM community_threads AS thread
    WHERE thread.author_id = p_author_id
      AND LOWER(thread.title) = LOWER(p_title)
      AND thread.created_at > NOW() - INTERVAL '1 hour'
  ) THEN
    RAISE EXCEPTION 'Duplicate thread' USING ERRCODE = '23505';
  END IF;

  INSERT INTO community_threads (author_id, topic, title, body)
  VALUES (p_author_id, p_topic, p_title, p_body)
  RETURNING * INTO created;
  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION create_community_reply(
  p_thread_id UUID,
  p_author_id INTEGER,
  p_body TEXT
)
RETURNS community_replies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created community_replies;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM community_threads AS thread
    WHERE thread.id = p_thread_id AND thread.status = 'visible'
  ) THEN
    RAISE EXCEPTION 'Thread not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM community_replies AS reply
    WHERE reply.thread_id = p_thread_id
      AND reply.author_id = p_author_id
      AND reply.body = p_body
      AND reply.created_at > NOW() - INTERVAL '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Duplicate reply' USING ERRCODE = '23505';
  END IF;

  INSERT INTO community_replies (thread_id, author_id, body)
  VALUES (p_thread_id, p_author_id, p_body)
  RETURNING * INTO created;
  RETURN created;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reads (visible content only; author ids are for viewer flags and never
-- serialised by the API)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION list_community_threads(
  p_topic TEXT DEFAULT NULL,
  p_query TEXT DEFAULT NULL,
  p_cursor_activity_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_thread_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 21
)
RETURNS TABLE (
  thread_id UUID,
  topic TEXT,
  title TEXT,
  excerpt TEXT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  reply_count BIGINT,
  author_id INTEGER,
  author_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    thread.id,
    thread.topic,
    thread.title,
    LEFT(thread.body, 240),
    thread.created_at,
    thread.last_activity_at,
    (SELECT COUNT(*) FROM community_replies AS reply
      WHERE reply.thread_id = thread.id AND reply.status = 'visible'),
    thread.author_id,
    author.name
  FROM community_threads AS thread
  INNER JOIN users AS author ON author.id = thread.author_id
  WHERE thread.status = 'visible'
    AND (NULLIF(BTRIM(p_topic), '') IS NULL OR thread.topic = BTRIM(p_topic))
    AND (
      NULLIF(BTRIM(p_query), '') IS NULL
      OR thread.title ILIKE '%' || BTRIM(p_query) || '%'
      OR thread.body ILIKE '%' || BTRIM(p_query) || '%'
    )
    AND (
      p_cursor_activity_at IS NULL
      OR p_cursor_thread_id IS NULL
      OR (thread.last_activity_at, thread.id) < (p_cursor_activity_at, p_cursor_thread_id)
    )
  ORDER BY thread.last_activity_at DESC, thread.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 51);
$$;

CREATE OR REPLACE FUNCTION get_community_thread(p_thread_id UUID)
RETURNS TABLE (
  thread_id UUID,
  topic TEXT,
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  reply_count BIGINT,
  author_id INTEGER,
  author_name TEXT,
  author_avatar_url TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    thread.id,
    thread.topic,
    thread.title,
    thread.body,
    thread.created_at,
    thread.last_activity_at,
    (SELECT COUNT(*) FROM community_replies AS reply
      WHERE reply.thread_id = thread.id AND reply.status = 'visible'),
    thread.author_id,
    author.name,
    author.avatar_url
  FROM community_threads AS thread
  INNER JOIN users AS author ON author.id = thread.author_id
  WHERE thread.id = p_thread_id
    AND thread.status = 'visible';
$$;

CREATE OR REPLACE FUNCTION list_community_replies(
  p_thread_id UUID,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_reply_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 31
)
RETURNS TABLE (
  reply_id UUID,
  body TEXT,
  created_at TIMESTAMPTZ,
  author_id INTEGER,
  author_name TEXT,
  author_avatar_url TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT reply.id, reply.body, reply.created_at, reply.author_id, author.name, author.avatar_url
  FROM community_replies AS reply
  INNER JOIN community_threads AS thread ON thread.id = reply.thread_id
  INNER JOIN users AS author ON author.id = reply.author_id
  WHERE reply.thread_id = p_thread_id
    AND reply.status = 'visible'
    AND thread.status = 'visible'
    AND (
      p_cursor_created_at IS NULL
      OR p_cursor_reply_id IS NULL
      OR (reply.created_at, reply.id) > (p_cursor_created_at, p_cursor_reply_id)
    )
  ORDER BY reply.created_at ASC, reply.id ASC
  LIMIT LEAST(GREATEST(p_limit, 1), 51);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reports on community items
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_community_report(
  p_reporter_id INTEGER,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_reason TEXT,
  p_details TEXT
)
RETURNS TABLE (report_id UUID, already_reported BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_report_id UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_entity_type = 'thread' THEN
    SELECT EXISTS (
      SELECT 1 FROM community_threads AS thread
      WHERE thread.id = p_entity_id AND thread.status = 'visible'
    ) INTO v_exists;
  ELSIF p_entity_type = 'reply' THEN
    SELECT EXISTS (
      SELECT 1 FROM community_replies AS reply
      INNER JOIN community_threads AS thread ON thread.id = reply.thread_id
      WHERE reply.id = p_entity_id AND reply.status = 'visible' AND thread.status = 'visible'
    ) INTO v_exists;
  ELSE
    RAISE EXCEPTION 'Invalid report target' USING ERRCODE = '22023';
  END IF;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'Reported item not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO content_reports (reporter_id, entity_type, entity_id, business_id, reason, details)
  VALUES (p_reporter_id, p_entity_type, p_entity_id, NULL, p_reason, NULLIF(BTRIM(p_details), ''))
  ON CONFLICT (reporter_id, entity_type, entity_id) WHERE status = 'open' DO NOTHING
  RETURNING id INTO v_report_id;

  IF v_report_id IS NULL THEN
    SELECT r.id INTO v_report_id
    FROM content_reports AS r
    WHERE r.reporter_id = p_reporter_id
      AND r.entity_type = p_entity_type
      AND r.entity_id = p_entity_id
      AND r.status = 'open';
    RETURN QUERY SELECT v_report_id, TRUE;
  ELSE
    RETURN QUERY SELECT v_report_id, FALSE;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Staff moderation now covers community items
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS staff_list_reports(TEXT, INTEGER);
CREATE FUNCTION staff_list_reports(
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
  thread_id UUID,
  thread_title TEXT,
  community_body TEXT,
  community_status TEXT,
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
    COALESCE(thread.id, reply_thread.id),
    COALESCE(thread.title, reply_thread.title),
    COALESCE(thread.body, reply.body),
    COALESCE(thread.status, reply.status),
    (SELECT COUNT(*) FROM content_reports AS other
      WHERE other.entity_type = report.entity_type
        AND other.entity_id = report.entity_id
        AND other.status = 'open')
  FROM content_reports AS report
  LEFT JOIN businesses AS business ON business.id = report.business_id
  LEFT JOIN business_comments AS comment
    ON report.entity_type = 'comment' AND comment.id = report.entity_id
  LEFT JOIN community_threads AS thread
    ON report.entity_type = 'thread' AND thread.id = report.entity_id
  LEFT JOIN community_replies AS reply
    ON report.entity_type = 'reply' AND reply.id = report.entity_id
  LEFT JOIN community_threads AS reply_thread
    ON reply_thread.id = reply.thread_id
  WHERE report.status = p_status
  ORDER BY
    CASE WHEN p_status = 'open' THEN report.created_at END ASC,
    CASE WHEN p_status <> 'open' THEN report.resolved_at END DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

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
    ELSIF target.entity_type = 'business' THEN
      UPDATE businesses
      SET status = 'hidden', published_at = NULL, unpublished_at = NOW()
      WHERE id = target.entity_id AND status <> 'removed';
      UPDATE business_publications
      SET status = 'withdrawn', withdrawn_at = NOW()
      WHERE business_id = target.entity_id AND status = 'active';
    ELSIF target.entity_type = 'thread' THEN
      UPDATE community_threads
      SET status = 'hidden', updated_at = NOW()
      WHERE id = target.entity_id AND status = 'visible';
    ELSIF target.entity_type = 'reply' THEN
      UPDATE community_replies
      SET status = 'hidden', updated_at = NOW()
      WHERE id = target.entity_id AND status = 'visible';
    END IF;

    UPDATE content_reports
    SET status = 'actioned', resolved_by = p_actor_id, resolved_at = NOW(), resolution_note = v_note
    WHERE entity_type = target.entity_type AND entity_id = target.entity_id AND status = 'open';

    SELECT * INTO target FROM content_reports WHERE id = p_report_id;
  ELSE
    RAISE EXCEPTION 'Invalid moderation action' USING ERRCODE = '22023';
  END IF;

  IF target.business_id IS NOT NULL THEN
    INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
    VALUES (
      target.business_id,
      p_actor_id,
      CASE WHEN p_action = 'hide' THEN 'moderation.' || target.entity_type || '.hidden'
           ELSE 'moderation.report.dismissed' END,
      jsonb_build_object('reportId', p_report_id, 'entityId', target.entity_id, 'note', v_note)
    );
  ELSE
    INSERT INTO community_moderation_log (actor_id, action, entity_type, entity_id, metadata)
    VALUES (
      p_actor_id,
      CASE WHEN p_action = 'hide' THEN 'moderation.' || target.entity_type || '.hidden'
           ELSE 'moderation.report.dismissed' END,
      target.entity_type,
      target.entity_id,
      jsonb_build_object('reportId', p_report_id, 'note', v_note)
    );
  END IF;

  RETURN target;
END;
$$;

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
  v_restored UUID;
BEGIN
  IF p_entity_type = 'comment' THEN
    UPDATE business_comments
    SET status = 'visible', moderated_by = p_actor_id, moderated_at = NOW(),
        moderation_reason = NULL, updated_at = NOW()
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING business_id INTO v_business_id;
    v_restored := v_business_id;
  ELSIF p_entity_type = 'business' THEN
    UPDATE businesses
    SET status = 'draft'
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING id INTO v_business_id;
    v_restored := v_business_id;
  ELSIF p_entity_type = 'thread' THEN
    UPDATE community_threads
    SET status = 'visible', updated_at = NOW()
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING id INTO v_restored;
  ELSIF p_entity_type = 'reply' THEN
    UPDATE community_replies
    SET status = 'visible', updated_at = NOW()
    WHERE id = p_entity_id AND status = 'hidden'
    RETURNING id INTO v_restored;
  ELSE
    RAISE EXCEPTION 'Invalid restore target' USING ERRCODE = '22023';
  END IF;

  IF v_restored IS NULL THEN
    RAISE EXCEPTION 'Nothing to restore' USING ERRCODE = 'P0002';
  END IF;

  IF v_business_id IS NOT NULL THEN
    INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
    VALUES (v_business_id, p_actor_id, 'moderation.' || p_entity_type || '.restored',
            jsonb_build_object('entityId', p_entity_id));
  ELSE
    INSERT INTO community_moderation_log (actor_id, action, entity_type, entity_id)
    VALUES (p_actor_id, 'moderation.' || p_entity_type || '.restored', p_entity_type, p_entity_id);
  END IF;

  RETURN v_restored;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: service_role only
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION on_community_reply() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION list_user_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_user_notifications(INTEGER, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION create_community_thread(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_community_thread(INTEGER, TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION create_community_reply(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_community_reply(UUID, INTEGER, TEXT) TO service_role;

REVOKE ALL ON FUNCTION list_community_threads(TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_community_threads(TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION get_community_thread(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_community_thread(UUID) TO service_role;

REVOKE ALL ON FUNCTION list_community_replies(UUID, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_community_replies(UUID, TIMESTAMPTZ, UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION create_community_report(INTEGER, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_community_report(INTEGER, TEXT, UUID, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION staff_list_reports(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_list_reports(TEXT, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE community_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_moderation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "community_threads_deny_direct" ON community_threads;
CREATE POLICY "community_threads_deny_direct" ON community_threads
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "community_replies_deny_direct" ON community_replies;
CREATE POLICY "community_replies_deny_direct" ON community_replies
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "community_moderation_log_deny_direct" ON community_moderation_log;
CREATE POLICY "community_moderation_log_deny_direct" ON community_moderation_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0023', 'Community discussions, reply notifications, community moderation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
