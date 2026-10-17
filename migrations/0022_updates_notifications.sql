-- Phase 4 (slice A): business updates, in-app notifications, and practising a
-- question that came from a public comment.
-- Depends on 0021 (comments, follows, resolve_public_business_id) and 0019.
--
-- Design notes
--   * Notifications are written by triggers in the same transaction as the
--     comment or update that causes them, so no code path can forget them.
--   * Each recipient's switch in users.settings.notifications is honoured at
--     write time. A missing key means "on"; only an explicit false opts out.
--   * Notifications store ids only. Names, excerpts and links are joined at
--     read time, so a hidden comment or unpublished business never leaks
--     through an old notification row.
--   * All functions are SECURITY DEFINER and callable only by service_role.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Business updates and milestones
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'update',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_updates_kind_values CHECK (kind IN ('update', 'milestone', 'launch')),
  CONSTRAINT business_updates_body_length CHECK (char_length(body) BETWEEN 2 AND 1500),
  CONSTRAINT business_updates_status_values CHECK (status IN ('visible', 'hidden', 'removed'))
);

CREATE INDEX IF NOT EXISTS idx_business_updates_visible
  ON business_updates (business_id, created_at DESC, id DESC)
  WHERE status = 'visible';

-- ─────────────────────────────────────────────────────────────────────────────
-- In-app notifications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_type_values CHECK (type IN ('business_comment', 'business_update'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;

-- A recipient opts out only with an explicit false; a missing key means on.
CREATE OR REPLACE FUNCTION notification_enabled(p_settings JSONB, p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_settings -> 'notifications' ->> p_key, 'true') <> 'false';
$$;

-- New public comment → the business's owners, admins and editors (not the author).
CREATE OR REPLACE FUNCTION notify_business_comment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'visible' THEN
    RETURN NEW;
  END IF;
  INSERT INTO notifications (user_id, type, business_id, entity_id)
  SELECT member.user_id, 'business_comment', NEW.business_id, NEW.id
  FROM business_members AS member
  INNER JOIN users AS recipient ON recipient.id = member.user_id
  WHERE member.business_id = NEW.business_id
    AND member.status = 'active'
    AND member.role IN ('owner', 'admin', 'editor')
    AND member.user_id <> NEW.author_id
    AND notification_enabled(recipient.settings, 'businessActivity');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_comments_notify ON business_comments;
CREATE TRIGGER business_comments_notify
  AFTER INSERT ON business_comments
  FOR EACH ROW
  EXECUTE FUNCTION notify_business_comment();

-- New visible update on a PUBLISHED business → its followers (not the author).
CREATE OR REPLACE FUNCTION notify_business_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'visible' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM businesses AS business
    WHERE business.id = NEW.business_id AND business.status = 'published'
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO notifications (user_id, type, business_id, entity_id)
  SELECT follow.user_id, 'business_update', NEW.business_id, NEW.id
  FROM business_follows AS follow
  INNER JOIN users AS recipient ON recipient.id = follow.user_id
  WHERE follow.business_id = NEW.business_id
    AND follow.user_id IS DISTINCT FROM NEW.author_id
    AND notification_enabled(recipient.settings, 'followedUpdates');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_updates_notify ON business_updates;
CREATE TRIGGER business_updates_notify
  AFTER INSERT ON business_updates
  FOR EACH ROW
  EXECUTE FUNCTION notify_business_update();

-- A notification is only shown while the thing it points at is still visible.
CREATE OR REPLACE FUNCTION list_user_notifications(
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
    LEFT(COALESCE(comment.body, business_update.body), 140)
  FROM notifications AS note
  INNER JOIN businesses AS business ON business.id = note.business_id
  LEFT JOIN business_comments AS comment
    ON note.type = 'business_comment' AND comment.id = note.entity_id
  LEFT JOIN business_updates AS business_update
    ON note.type = 'business_update' AND business_update.id = note.entity_id
  WHERE note.user_id = p_user_id
    AND business.status <> 'removed'
    AND (
      (note.type = 'business_comment' AND comment.status = 'visible')
      OR (note.type = 'business_update' AND business_update.status = 'visible'
          AND business.status = 'published')
    )
  ORDER BY note.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public updates (published businesses only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION list_public_business_updates(
  p_slug TEXT,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  update_id UUID,
  kind TEXT,
  body TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business_update.id, business_update.kind, business_update.body, business_update.created_at
  FROM business_updates AS business_update
  WHERE business_update.business_id = resolve_public_business_id(p_slug)
    AND business_update.status = 'visible'
  ORDER BY business_update.created_at DESC, business_update.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 30);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Practice drafts may cite the public comment their question came from.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE practice_drafts
  ADD COLUMN IF NOT EXISTS source_comment_id UUID REFERENCES business_comments(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants and RLS
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION notify_business_comment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION notify_business_update() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION list_user_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_user_notifications(INTEGER, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION list_public_business_updates(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_business_updates(TEXT, INTEGER) TO service_role;

ALTER TABLE business_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "business_updates_deny_direct" ON business_updates;
CREATE POLICY "business_updates_deny_direct" ON business_updates
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "notifications_deny_direct" ON notifications;
CREATE POLICY "notifications_deny_direct" ON notifications
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0022', 'Business updates, in-app notifications, practice from comments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
