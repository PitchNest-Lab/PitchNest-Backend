-- Founder pages and founder follows.
-- Depends on 0028 (public team consent) and 0026 (latest list_user_notifications).
--
--   * A founder is public only while they personally consent to appear on at
--     least one published business (business_members.public_display_consent).
--     Their page lists only those businesses.
--   * founder_handles gives each public founder a stable URL handle, assigned by
--     the backend the first time they consent, so user ids never appear in URLs.
--   * founder_follows: a user follows a founder. A follow is kept if the founder
--     later stops being public, but nothing about them is shown or sent while
--     they are not.
--   * Notifications, honouring settings.notifications.followedFounders:
--       founder_business: the first time a founder is publicly linked to a
--         published business. Recorded once per founder and business in
--         founder_business_announcements, so toggling consent cannot spam.
--       founder_update: a founder posts an update on a business they are
--         publicly shown on. Someone who already follows that business gets
--         the business notification only, never both.
--     Both are dropped at read time if the founder withdraws or the business
--     goes private.

BEGIN;

CREATE TABLE IF NOT EXISTS founder_handles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT founder_handles_format CHECK (
    handle ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(handle) BETWEEN 3 AND 60
  )
);

CREATE TABLE IF NOT EXISTS founder_follows (
  founder_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (founder_id, follower_id),
  CONSTRAINT founder_follows_not_self CHECK (founder_id <> follower_id)
);

CREATE INDEX IF NOT EXISTS idx_founder_follows_follower
  ON founder_follows (follower_id, created_at DESC);

CREATE TABLE IF NOT EXISTS founder_business_announcements (
  founder_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  announced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (founder_id, business_id)
);

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_values;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_values
  CHECK (type IN (
    'business_comment', 'business_update', 'community_reply',
    'founder_update', 'founder_business'
  ));

-- True while the founder is publicly shown on this business and it is published.
CREATE OR REPLACE FUNCTION founder_shown_on_business(p_founder_id INTEGER, p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM business_members AS member
    INNER JOIN businesses AS business ON business.id = member.business_id
    WHERE member.user_id = p_founder_id
      AND member.business_id = p_business_id
      AND member.status = 'active'
      AND member.public_display_consent = TRUE
      AND business.status = 'published'
  );
$$;

-- The first public link between a founder and a business tells their
-- followers once. Members of that business are not told about it.
CREATE OR REPLACE FUNCTION announce_founder_business(p_founder_id INTEGER, p_business_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT founder_shown_on_business(p_founder_id, p_business_id) THEN
    RETURN;
  END IF;

  INSERT INTO founder_business_announcements (founder_id, business_id)
  VALUES (p_founder_id, p_business_id)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO notifications (user_id, type, business_id, actor_id)
  SELECT follow.follower_id, 'founder_business', p_business_id, p_founder_id
  FROM founder_follows AS follow
  INNER JOIN users AS recipient ON recipient.id = follow.follower_id
  WHERE follow.founder_id = p_founder_id
    AND NOT EXISTS (
      SELECT 1 FROM business_members AS member
      WHERE member.business_id = p_business_id
        AND member.user_id = follow.follower_id
        AND member.status = 'active'
    )
    AND notification_enabled(recipient.settings, 'followedFounders');
END;
$$;

-- A member turns on public display (or rejoins) while the business is live.
CREATE OR REPLACE FUNCTION on_member_public_display()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'active' AND NEW.public_display_consent = TRUE THEN
    PERFORM announce_founder_business(NEW.user_id, NEW.business_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_members_public_display ON business_members;
CREATE TRIGGER business_members_public_display
  AFTER INSERT OR UPDATE OF public_display_consent, status ON business_members
  FOR EACH ROW
  EXECUTE FUNCTION on_member_public_display();

-- A business goes live with members who already chose to be shown.
CREATE OR REPLACE FUNCTION on_business_published()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    PERFORM announce_founder_business(member.user_id, NEW.id)
    FROM business_members AS member
    WHERE member.business_id = NEW.id
      AND member.status = 'active'
      AND member.public_display_consent = TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_published_announce ON businesses;
CREATE TRIGGER businesses_published_announce
  AFTER UPDATE OF status ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION on_business_published();

-- Same as 0022 for business followers, plus the author's followers.
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

  -- Followers of the author, only while the author is shown on this business.
  -- Anyone who follows the business itself is governed by the business
  -- notification above, so nobody is told twice.
  IF NEW.author_id IS NOT NULL AND founder_shown_on_business(NEW.author_id, NEW.business_id) THEN
    INSERT INTO notifications (user_id, type, business_id, entity_id, actor_id)
    SELECT follow.follower_id, 'founder_update', NEW.business_id, NEW.id, NEW.author_id
    FROM founder_follows AS follow
    INNER JOIN users AS recipient ON recipient.id = follow.follower_id
    WHERE follow.founder_id = NEW.author_id
      AND NOT EXISTS (
        SELECT 1 FROM business_follows AS business_follow
        WHERE business_follow.business_id = NEW.business_id
          AND business_follow.user_id = follow.follower_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM business_members AS member
        WHERE member.business_id = NEW.business_id
          AND member.user_id = follow.follower_id
          AND member.status = 'active'
      )
      AND notification_enabled(recipient.settings, 'followedFounders');
  END IF;
  RETURN NEW;
END;
$$;

-- The return shape gains founder columns, so drop and recreate.
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
  excerpt TEXT,
  comment_category TEXT,
  founder_name TEXT,
  founder_handle TEXT
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
    LEFT(COALESCE(
      comment.body,
      business_update.body,
      reply.body,
      CASE WHEN note.type = 'founder_business' THEN business.tagline END
    ), 140),
    comment.category,
    founder.name,
    founder_handle.handle
  FROM notifications AS note
  LEFT JOIN businesses AS business ON business.id = note.business_id
  LEFT JOIN business_comments AS comment
    ON note.type = 'business_comment' AND comment.id = note.entity_id
  LEFT JOIN business_updates AS business_update
    ON note.type IN ('business_update', 'founder_update') AND business_update.id = note.entity_id
  LEFT JOIN community_replies AS reply
    ON note.type = 'community_reply' AND reply.id = note.entity_id
  LEFT JOIN community_threads AS thread
    ON thread.id = reply.thread_id
  LEFT JOIN users AS founder ON founder.id = note.actor_id
  LEFT JOIN founder_handles AS founder_handle ON founder_handle.user_id = note.actor_id
  WHERE note.user_id = p_user_id
    AND (
      (note.type = 'business_comment' AND comment.status = 'visible'
        AND business.status IS DISTINCT FROM 'removed')
      OR (note.type = 'business_update' AND business_update.status = 'visible'
        AND business.status = 'published')
      OR (note.type = 'community_reply' AND reply.status = 'visible'
        AND thread.status = 'visible')
      OR (note.type = 'founder_update' AND business_update.status = 'visible'
        AND founder_shown_on_business(note.actor_id, note.business_id))
      OR (note.type = 'founder_business'
        AND founder_shown_on_business(note.actor_id, note.business_id))
    )
  ORDER BY note.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

REVOKE ALL ON FUNCTION founder_shown_on_business(INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION founder_shown_on_business(INTEGER, UUID) TO service_role;
REVOKE ALL ON FUNCTION announce_founder_business(INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION on_member_public_display() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION on_business_published() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION notify_business_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION list_user_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_user_notifications(INTEGER, INTEGER) TO service_role;

ALTER TABLE founder_handles ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_business_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "founder_handles_deny_direct" ON founder_handles;
CREATE POLICY "founder_handles_deny_direct" ON founder_handles
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "founder_follows_deny_direct" ON founder_follows;
CREATE POLICY "founder_follows_deny_direct" ON founder_follows
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "founder_business_announcements_deny_direct" ON founder_business_announcements;
CREATE POLICY "founder_business_announcements_deny_direct" ON founder_business_announcements
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0029', 'Founder pages, founder follows and founder notifications')
ON CONFLICT (version) DO NOTHING;

COMMIT;
