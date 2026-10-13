-- Migration 0015: In-app reports of AI-generated content.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- WHY
-- ──────────────────────────────────────────────────────────────────────────────
-- Google Play's AI-Generated Content policy requires apps that generate content
-- with AI to let users report or flag offensive output from inside the app,
-- without leaving it. Apple expects the same for user-facing generated content.
-- Founders can now tap "Report this AI response" on a panel line or a report;
-- each report lands here for the team to review.
--
-- ids are stored without foreign keys on purpose: a report must survive the
-- reporter deleting their account or the session being removed, so the team
-- can still act on it.

CREATE TABLE IF NOT EXISTS ai_content_reports (
  id          bigserial PRIMARY KEY,
  user_id     bigint,
  session_id  bigint,
  speaker     text,
  content     text NOT NULL,
  reason      text NOT NULL,
  details     text,
  source      text,
  platform    text,
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_content_reports_status_created_idx
  ON ai_content_reports (status, created_at DESC);

-- Backend-only table (service_role bypasses RLS); deny anon-key access, the
-- same defense-in-depth as migration 0004.
ALTER TABLE ai_content_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_content_reports_deny_anon" ON ai_content_reports;
CREATE POLICY "ai_content_reports_deny_anon" ON ai_content_reports
  FOR ALL
  USING (false);
