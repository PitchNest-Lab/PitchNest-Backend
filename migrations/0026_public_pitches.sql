-- Phase 5 (Pitch Arena, text first): a deliberate, consented public pitch per
-- business, plus structured feedback carried on business comments.
-- Depends on 0025 (product events), 0023 (notification list), 0022, 0021.
--
-- Design notes
--   * A public pitch is written fresh in the workspace. It is never derived
--     from a private practice session, recording, transcript or report.
--   * Each business has at most one draft and one published pitch. Publishing
--     requires the exact draft the founder previewed (updated_at check), an
--     explicit consent version, and a currently published business.
--   * Withdrawing removes the pitch from every public read immediately.
--   * Structured feedback is a business comment with a category and an
--     optional pitch link, so moderation, reports, notifications and
--     "practise this question" all apply without new machinery.
--   * The pitch itself can be reported. Staff can hide just the pitch, and
--     restore it, through the existing moderation functions (recreated here).

BEGIN;

CREATE TABLE IF NOT EXISTS public_pitches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 0,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  feedback_ask TEXT,
  consent_version TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT public_pitches_status_values CHECK (status IN ('draft', 'published', 'withdrawn', 'hidden')),
  CONSTRAINT public_pitches_headline_length CHECK (char_length(headline) BETWEEN 5 AND 120),
  CONSTRAINT public_pitches_body_length CHECK (char_length(body) BETWEEN 50 AND 1500),
  CONSTRAINT public_pitches_ask_length CHECK (feedback_ask IS NULL OR char_length(feedback_ask) <= 300)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_public_pitches_one_draft
  ON public_pitches (business_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS uq_public_pitches_one_published
  ON public_pitches (business_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_public_pitches_feed
  ON public_pitches (approved_at DESC, id DESC) WHERE status = 'published';

-- Structured feedback on comments.
ALTER TABLE business_comments
  ADD COLUMN IF NOT EXISTS pitch_id UUID REFERENCES public_pitches(id) ON DELETE SET NULL;
ALTER TABLE business_comments
  ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE business_comments DROP CONSTRAINT IF EXISTS business_comments_category_values;
ALTER TABLE business_comments ADD CONSTRAINT business_comments_category_values
  CHECK (category IS NULL OR category IN ('clarity', 'customer', 'evidence', 'go_to_market', 'question'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Pitch lifecycle
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION save_pitch_draft(
  p_business_id UUID,
  p_actor_id INTEGER,
  p_headline TEXT,
  p_body TEXT,
  p_feedback_ask TEXT
)
RETURNS public_pitches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public_pitches;
BEGIN
  INSERT INTO public_pitches (business_id, headline, body, feedback_ask, created_by, updated_by)
  VALUES (p_business_id, p_headline, p_body, NULLIF(BTRIM(p_feedback_ask), ''), p_actor_id, p_actor_id)
  ON CONFLICT (business_id) WHERE status = 'draft'
  DO UPDATE SET
    headline = EXCLUDED.headline,
    body = EXCLUDED.body,
    feedback_ask = EXCLUDED.feedback_ask,
    updated_by = EXCLUDED.updated_by,
    updated_at = NOW()
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION publish_pitch(
  p_business_id UUID,
  p_actor_id INTEGER,
  p_draft_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_consent_version TEXT
)
RETURNS public_pitches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  draft public_pitches;
  published public_pitches;
  v_next_version INTEGER;
BEGIN
  SELECT * INTO draft FROM public_pitches
  WHERE id = p_draft_id AND business_id = p_business_id
  FOR UPDATE;
  IF NOT FOUND OR draft.status <> 'draft' THEN
    RAISE EXCEPTION 'Pitch draft not found' USING ERRCODE = 'P0002';
  END IF;
  IF date_trunc('milliseconds', draft.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Pitch changed after preview; review it again' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM businesses AS business
    INNER JOIN business_publications AS publication ON publication.business_id = business.id
    WHERE business.id = p_business_id
      AND business.status = 'published'
      AND publication.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Publish the business profile before its pitch' USING ERRCODE = '23514';
  END IF;

  UPDATE public_pitches
  SET status = 'withdrawn', withdrawn_at = NOW(), updated_at = NOW()
  WHERE business_id = p_business_id AND status = 'published';

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next_version
  FROM public_pitches WHERE business_id = p_business_id;

  UPDATE public_pitches
  SET status = 'published',
      version = v_next_version,
      consent_version = p_consent_version,
      approved_by = p_actor_id,
      approved_at = NOW(),
      updated_by = p_actor_id,
      updated_at = NOW()
  WHERE id = p_draft_id
  RETURNING * INTO published;

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (p_business_id, p_actor_id, 'pitch.published',
          jsonb_build_object('pitchId', p_draft_id, 'version', v_next_version, 'consentVersion', p_consent_version));

  RETURN published;
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_pitch(
  p_business_id UUID,
  p_actor_id INTEGER
)
RETURNS public_pitches
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  withdrawn public_pitches;
BEGIN
  UPDATE public_pitches
  SET status = 'withdrawn', withdrawn_at = NOW(), updated_by = p_actor_id, updated_at = NOW()
  WHERE business_id = p_business_id AND status = 'published'
  RETURNING * INTO withdrawn;
  IF withdrawn.id IS NULL THEN
    RAISE EXCEPTION 'No published pitch' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (p_business_id, p_actor_id, 'pitch.withdrawn', jsonb_build_object('pitchId', withdrawn.id));
  RETURN withdrawn;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Public reads (published pitch of a published business only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_public_pitch(p_slug TEXT)
RETURNS TABLE (
  pitch_id UUID,
  version INTEGER,
  headline TEXT,
  body TEXT,
  feedback_ask TEXT,
  approved_at TIMESTAMPTZ,
  feedback_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pitch.id,
    pitch.version,
    pitch.headline,
    pitch.body,
    pitch.feedback_ask,
    pitch.approved_at,
    (SELECT COUNT(*) FROM business_comments AS comment
      WHERE comment.pitch_id = pitch.id AND comment.status = 'visible')
  FROM public_pitches AS pitch
  WHERE pitch.business_id = resolve_public_business_id(p_slug)
    AND pitch.status = 'published'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION list_public_pitches(
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
  business_region TEXT
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
    publication.public_snapshot ->> 'region'
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments gain an optional category and pitch link
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS create_business_comment(TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION create_business_comment(
  p_slug TEXT,
  p_author_id INTEGER,
  p_body TEXT,
  p_category TEXT DEFAULT NULL,
  p_on_pitch BOOLEAN DEFAULT FALSE
)
RETURNS business_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_pitch_id UUID;
  created business_comments;
BEGIN
  v_business_id := resolve_public_business_id(p_slug);
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  -- Feedback attaches to the business's CURRENT published pitch, resolved
  -- here; the client never supplies a pitch id.
  IF p_on_pitch THEN
    SELECT pitch.id INTO v_pitch_id
    FROM public_pitches AS pitch
    WHERE pitch.business_id = v_business_id AND pitch.status = 'published';
    IF v_pitch_id IS NULL THEN
      RAISE EXCEPTION 'No public pitch' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM business_comments AS c
    WHERE c.business_id = v_business_id
      AND c.author_id = p_author_id
      AND c.body = p_body
      AND c.created_at > NOW() - INTERVAL '10 minutes'
  ) THEN
    RAISE EXCEPTION 'Duplicate comment' USING ERRCODE = '23505';
  END IF;

  INSERT INTO business_comments (business_id, author_id, body, category, pitch_id)
  VALUES (v_business_id, p_author_id, p_body, p_category, v_pitch_id)
  RETURNING * INTO created;

  RETURN created;
END;
$$;

DROP FUNCTION IF EXISTS list_public_business_comments(TEXT, TIMESTAMPTZ, UUID, INTEGER);
CREATE FUNCTION list_public_business_comments(
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
  author_is_member BOOLEAN,
  category TEXT,
  on_pitch BOOLEAN
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
    ),
    comment.category,
    comment.pitch_id IS NOT NULL
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

-- Notifications: say "pitch feedback" when a comment carries a category.
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
  comment_category TEXT
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
    LEFT(COALESCE(comment.body, business_update.body, reply.body), 140),
    comment.category
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

-- Analytics: pitch events join the allowlist.
ALTER TABLE product_events DROP CONSTRAINT IF EXISTS product_events_name_values;
ALTER TABLE product_events ADD CONSTRAINT product_events_name_values CHECK (name IN (
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
  'opportunity_link_opened',
  'pitch_published',
  'pitch_withdrawn',
  'pitch_feedback_posted',
  'pitch_arena_viewed'
));

-- ─────────────────────────────────────────────────────────────────────────────
-- Moderation: a published pitch can be reported and hidden on its own,
-- without hiding the whole business profile.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_entity_values;
ALTER TABLE content_reports ADD CONSTRAINT content_reports_entity_values
  CHECK (entity_type IN ('business', 'comment', 'thread', 'reply', 'pitch'));
-- content_reports_business_required (0023) already holds: pitch reports carry
-- the business id.

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
  ELSIF p_entity_type = 'pitch' THEN
    -- Only the pitch the reporter can actually see: the live one.
    SELECT p.business_id, p.id INTO v_business_id, v_entity_id
    FROM public_pitches AS p
    WHERE p.business_id = resolve_public_business_id(p_slug)
      AND p.status = 'published';
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

-- The queue gains the reported pitch's text, so a moderator sees exactly what
-- was public. New columns change the return type, hence drop and recreate.
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
  pitch_headline TEXT,
  pitch_body TEXT,
  pitch_status TEXT,
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
    pitch.headline,
    pitch.body,
    pitch.status,
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
  LEFT JOIN public_pitches AS pitch
    ON report.entity_type = 'pitch' AND pitch.id = report.entity_id
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
    ELSIF target.entity_type = 'pitch' THEN
      UPDATE public_pitches
      SET status = 'hidden', withdrawn_at = NOW(), updated_at = NOW()
      WHERE id = target.entity_id AND status = 'published';
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
  ELSIF p_entity_type = 'pitch' THEN
    -- Back to live, unless the founder has published a newer pitch since; then
    -- it is restored as withdrawn so the newer one stays the only live pitch.
    UPDATE public_pitches AS restored
    SET status = CASE WHEN EXISTS (
          SELECT 1 FROM public_pitches AS other
          WHERE other.business_id = restored.business_id AND other.status = 'published'
        ) THEN 'withdrawn' ELSE 'published' END,
        withdrawn_at = CASE WHEN EXISTS (
          SELECT 1 FROM public_pitches AS other
          WHERE other.business_id = restored.business_id AND other.status = 'published'
        ) THEN restored.withdrawn_at ELSE NULL END,
        updated_at = NOW()
    WHERE restored.id = p_entity_id AND restored.status = 'hidden'
    RETURNING restored.business_id INTO v_business_id;
    v_restored := v_business_id;
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
-- Grants and RLS
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION create_content_report(INTEGER, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_content_report(INTEGER, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION staff_list_reports(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_list_reports(TEXT, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_resolve_report(UUID, INTEGER, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_restore_content(TEXT, UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION save_pitch_draft(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_pitch_draft(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION publish_pitch(UUID, INTEGER, UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_pitch(UUID, INTEGER, UUID, TIMESTAMPTZ, TEXT) TO service_role;
REVOKE ALL ON FUNCTION withdraw_pitch(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION withdraw_pitch(UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION get_public_pitch(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_public_pitch(TEXT) TO service_role;
REVOKE ALL ON FUNCTION list_public_pitches(TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_pitches(TIMESTAMPTZ, UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION create_business_comment(TEXT, INTEGER, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_business_comment(TEXT, INTEGER, TEXT, TEXT, BOOLEAN) TO service_role;
REVOKE ALL ON FUNCTION list_public_business_comments(TEXT, TIMESTAMPTZ, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_business_comments(TEXT, TIMESTAMPTZ, UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION list_user_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_user_notifications(INTEGER, INTEGER) TO service_role;

ALTER TABLE public_pitches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_pitches_deny_direct" ON public_pitches;
CREATE POLICY "public_pitches_deny_direct" ON public_pitches
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0026', 'Public pitches (text) and structured pitch feedback')
ON CONFLICT (version) DO NOTHING;

COMMIT;
