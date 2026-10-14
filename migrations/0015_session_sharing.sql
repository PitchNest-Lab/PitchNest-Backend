-- ─────────────────────────────────────────────────────────────────────────────
-- Session sharing: opt-in, revocable public links.
--
-- WHY A NEW COLUMN, AND WHY IT DEFAULTS TO FALSE
--
-- sessions.share_id has existed since the very first schema and is populated on
-- EVERY session at insert (restSocket generates a UUID on end_session). Nothing
-- ever surfaced it, so it was harmless. The moment a public route reads it,
-- however, "share_id IS NOT NULL" would silently publish every session ever
-- recorded — including ones the founder never chose to share and has no idea is
-- public.
--
-- So sharing is gated on an explicit flag that defaults to false. Consequences:
--   • Running this migration publishes nothing. Existing rows stay private.
--   • Revoking is one boolean write, not a destructive delete of the id.
--   • Re-enabling returns the SAME url, rather than orphaning one a founder has
--     already pasted into a deck or an email.
--
-- The public url is /share/<share_id> and the API behind it is
-- GET /api/public/pitch/:shareId, which returns a redacted projection — score,
-- verdict, top strengths and top fixes. Not the transcript, not the financial
-- or competitive intelligence, not the panel's verbatim quotes. See
-- buildPublicPitch in controllers/sessionController.ts for the allowlist and
-- why it is an allowlist rather than a denylist.
--
-- Idempotent: safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the public route only ever looks rows up by share_id when the
-- flag is on, and that is the only query that runs unauthenticated, so it is the
-- one worth indexing. The unique constraint on share_id already covers the rest.
CREATE INDEX IF NOT EXISTS idx_sessions_share_id_enabled
  ON sessions (share_id)
  WHERE share_enabled = TRUE;
