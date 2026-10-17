-- PitchNest database upgrade: schema 0014 -> 0031
--
-- GENERATED FILE (2026-10-17). Do not edit by hand: change the numbered
-- migrations in this folder's parent, then run npm run migrations:combined
-- and npm run test:migrations in the backend.
--
-- What it does
--   Applies migrations 0015 through 0031, in order, as ONE transaction. Either
--   every change is applied or none is. Each migration is written to be
--   re-runnable, so running this again on an upgraded database changes nothing.
--   A pre-flight check stops before any change if the database is missing part
--   of the 0014 schema these migrations build on, and lists what is missing.
--   Migrations already applied (by ledger row, or for 0015-0017 by their
--   objects) are skipped, so a partly upgraded database is completed safely.
--
--   DATA CHANGE: organization passwords that are not bcrypt hashes are cleared
--   (set to NULL). They cannot sign in under the current backend and would
--   stop migration 0030. Affected organizations need a new password afterwards.
--   check_schema_state.sql reports how many there are before you run this.
--
-- Before running
--   1. Take a backup or restorable snapshot of the database.
--   2. Run check_schema_state.sql (read-only) and confirm that the
--      "prerequisites" row says ok.
--   3. Run on the DEV project first, then PROD.
--
-- How to run (Supabase dashboard)
--   SQL Editor -> New query -> paste this whole file -> Run.
--   Success ends with "Success. No rows returned". Any error rolls everything
--   back; read the message, fix the cause, and run the whole file again.
--
-- After running
--   * Run check_schema_state.sql again: every migration row should say applied.
--   * Feature flags stay off until set on the backend (see ../README.md):
--     FEATURE_DISCOVER_ENGAGEMENT, FEATURE_COMMUNITY, FEATURE_PITCH_ARENA.
--   * Organization logins need bcrypt password hashes (see 0018 in ../README.md).

BEGIN;

-- Fail fast instead of queueing behind a long-running lock on a live table.
SET LOCAL lock_timeout = '15s';

-- ── Pre-flight: the 0014 schema these migrations build on ───────────────────
DO $preflight$
DECLARE
  missing TEXT[] := ARRAY[]::TEXT[];
  item RECORD;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
    ('table', 'Organizations'),
    ('table', 'deck_audits'),
    ('table', 'decks'),
    ('table', 'email_verification_tokens'),
    ('table', 'password_resets'),
    ('table', 'payments'),
    ('table', 'profiles'),
    ('table', 'session_pdfs'),
    ('table', 'session_starts'),
    ('table', 'sessions'),
    ('table', 'users'),
    ('table', 'waitlist')
    ) AS expected(kind, name)
  LOOP
    IF to_regclass(format('public.%I', item.name)) IS NULL THEN
      missing := missing || format('table %s', item.name);
    END IF;
  END LOOP;

  FOR item IN
    SELECT * FROM (VALUES
    ('Organizations', 'country'),
    ('Organizations', 'created_at'),
    ('Organizations', 'email'),
    ('Organizations', 'id'),
    ('Organizations', 'org_code'),
    ('Organizations', 'org_name'),
    ('Organizations', 'org_users_capacity'),
    ('Organizations', 'org_users_enrolled'),
    ('Organizations', 'password'),
    ('Organizations', 'plan'),
    ('Organizations', 'trial_expires_at'),
    ('Organizations', 'trial_started_at'),
    ('Organizations', 'trial_status'),
    ('Organizations', 'validity'),
    ('Organizations', 'website_url'),
    ('deck_audits', 'created_at'),
    ('deck_audits', 'deck_id'),
    ('deck_audits', 'id'),
    ('deck_audits', 'report'),
    ('deck_audits', 'user_id'),
    ('decks', 'created_at'),
    ('decks', 'extracted_text'),
    ('decks', 'file_url'),
    ('decks', 'id'),
    ('decks', 'name'),
    ('decks', 'page_count'),
    ('decks', 'size'),
    ('decks', 'status'),
    ('decks', 'user_id'),
    ('email_verification_tokens', 'attempts'),
    ('email_verification_tokens', 'code'),
    ('email_verification_tokens', 'created_at'),
    ('email_verification_tokens', 'expires_at'),
    ('email_verification_tokens', 'id'),
    ('email_verification_tokens', 'token'),
    ('email_verification_tokens', 'user_id'),
    ('password_resets', 'created_at'),
    ('password_resets', 'expires_at'),
    ('password_resets', 'id'),
    ('password_resets', 'token'),
    ('password_resets', 'used'),
    ('password_resets', 'user_id'),
    ('payments', 'amount'),
    ('payments', 'completed_at'),
    ('payments', 'created_at'),
    ('payments', 'currency'),
    ('payments', 'granted_days'),
    ('payments', 'id'),
    ('payments', 'plan'),
    ('payments', 'provider'),
    ('payments', 'provider_ref'),
    ('payments', 'status'),
    ('payments', 'term'),
    ('payments', 'tx_ref'),
    ('payments', 'user_id'),
    ('profiles', 'created_at'),
    ('profiles', 'funding_stage'),
    ('profiles', 'goal'),
    ('profiles', 'id'),
    ('profiles', 'industry'),
    ('profiles', 'startup_name'),
    ('profiles', 'user_id'),
    ('session_pdfs', 'created_at'),
    ('session_pdfs', 'id'),
    ('session_pdfs', 'pdf_base64'),
    ('session_pdfs', 'session_id'),
    ('session_starts', 'id'),
    ('session_starts', 'started_at'),
    ('session_starts', 'user_id'),
    ('sessions', 'attempt_number'),
    ('sessions', 'business_name'),
    ('sessions', 'created_at'),
    ('sessions', 'evaluation_report'),
    ('sessions', 'id'),
    ('sessions', 'mode'),
    ('sessions', 'org_id'),
    ('sessions', 'parent_session_id'),
    ('sessions', 'pitch_config'),
    ('sessions', 'pitch_root_id'),
    ('sessions', 'share_id'),
    ('sessions', 'summary'),
    ('sessions', 'timestamp'),
    ('sessions', 'user_id'),
    ('sessions', 'video_url'),
    ('sessions', 'visibility'),
    ('users', 'auth_provider'),
    ('users', 'avatar_url'),
    ('users', 'bio'),
    ('users', 'created_at'),
    ('users', 'email'),
    ('users', 'enrolled_at'),
    ('users', 'failed_login_attempts'),
    ('users', 'id'),
    ('users', 'isEmailVerified'),
    ('users', 'last_active'),
    ('users', 'locked_until'),
    ('users', 'name'),
    ('users', 'onboardingCompleted'),
    ('users', 'orgCode'),
    ('users', 'password'),
    ('users', 'plan'),
    ('users', 'plan_expires_at'),
    ('users', 'role'),
    ('users', 'settings'),
    ('users', 'trial_expires_at'),
    ('users', 'trial_started_at'),
    ('users', 'trial_status'),
    ('waitlist', 'created_at'),
    ('waitlist', 'email'),
    ('waitlist', 'feedback_opt_in'),
    ('waitlist', 'frustration'),
    ('waitlist', 'id'),
    ('waitlist', 'next_pitch'),
    ('waitlist', 'pitch_type')
    ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = item.table_name
        AND c.column_name = item.column_name
    ) THEN
      missing := missing || format('column %s.%s', item.table_name, item.column_name);
    END IF;
  END LOOP;

  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. The database is missing % item(s) of the 0014 schema: %',
      cardinality(missing), array_to_string(missing, ', ')
      USING HINT = 'Run check_schema_state.sql for the full list, bring those items in line with 0000_complete_fresh_setup.sql, then run this file again.';
  END IF;

  -- Data that 0030 re-validates. Neither should exist; stop rather than guess.
  IF EXISTS (SELECT 1 FROM users WHERE auth_provider IS NOT NULL AND auth_provider NOT IN ('form', 'google')) THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. % user(s) have an auth_provider other than form or google, which migration 0030 does not allow.',
      (SELECT count(*) FROM users WHERE auth_provider IS NOT NULL AND auth_provider NOT IN ('form', 'google'))
      USING HINT = 'Inspect them with: SELECT id, email, auth_provider FROM users WHERE auth_provider NOT IN (''form'', ''google''); set each to form (password sign-in) or google, then run this file again.';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE failed_login_attempts < 0) THEN
    RAISE EXCEPTION 'PitchNest upgrade stopped before changing anything. % user(s) have a negative failed_login_attempts, which migration 0030 does not allow.',
      (SELECT count(*) FROM users WHERE failed_login_attempts < 0)
      USING HINT = 'Reset them with: UPDATE users SET failed_login_attempts = 0 WHERE failed_login_attempts < 0; then run this file again.';
  END IF;
END
$preflight$;

-- ── Organization credentials ────────────────────────────────────────────────
-- 0018 only accepts bcrypt hashes for organization passwords (NOT VALID, so it
-- left existing values alone), and 0030 then updates every organization row,
-- which re-checks each one. Any other stored value would stop the upgrade and,
-- afterwards, block users joining or leaving that organization.
--
-- Such values can never sign in: the backend accepts only bcrypt hashes. They
-- are also not converted, because they are plain or unknown secrets that may
-- already have been exposed. They are cleared, and each affected organization
-- needs a new password set (see README.md, "Organization credentials").
DO $org_credentials$
DECLARE
  cleared INTEGER;
BEGIN
  UPDATE "Organizations"
     SET password = NULL
   WHERE password IS NOT NULL
     AND password !~ '^\$2[aby]\$[0-9]{2}\$.{53}$';
  GET DIAGNOSTICS cleared = ROW_COUNT;
  IF cleared > 0 THEN
    RAISE NOTICE 'PitchNest upgrade: cleared % organization password(s) that were not bcrypt hashes; set new ones before those organizations sign in.', cleared;
  END IF;
END
$org_credentials$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0015_session_sharing.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0015$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0015';
  END IF;
  -- Applied by hand before the ledger existed?
  already_applied := already_applied OR (
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'share_enabled')
  );
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0015 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0015';
  EXECUTE $body_0015$
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
$body_0015$;
END
$migration_0015$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0016_trial_email_log.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0016$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0016';
  END IF;
  -- Applied by hand before the ledger existed?
  already_applied := already_applied OR (
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trial_email_log' AND column_name = 'milestone')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trial_email_log' AND column_name = 'sent_at')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'trial_email_log' AND column_name = 'user_id')
      AND to_regclass('public."trial_email_log"') IS NOT NULL
  );
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0016 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0016';
  EXECUTE $body_0016$
-- ─────────────────────────────────────────────────────────────────────────────
-- Trial lifecycle emails: a record of who has already been told what.
--
-- The trial runs for FREE_TRIAL_DAYS (30) and until now it lapsed in complete
-- silence — a founder's PDF access and 40-minute durations simply disappeared on
-- day 31 with nothing said. This table is what makes the replacement emails
-- safe to send.
--
-- WHY A TABLE AND NOT A FLAG ON users
--
-- Two reasons, both about running more than one server process:
--
--  1. At-most-once. The primary key IS the lock. A sweep claims a milestone by
--     inserting the row, and only the insert that succeeds sends the email. Two
--     instances sweeping at the same moment both run, one wins, and nobody gets
--     "your trial ends tomorrow" twice. A boolean column would need a read, a
--     check and a write, and the gap between them is where the duplicate lives.
--
--  2. It stays legible. "Which reminders has this founder seen, and when" is a
--     question support will actually ask, and it can be answered by looking at
--     rows rather than decoding a JSONB bag.
--
-- user_id is INTEGER because users.id is SERIAL in this schema (0000), not a
-- UUID. ON DELETE CASCADE so the account-deletion flow takes this with it.
--
-- Idempotent: safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trial_email_log (
  user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The reminder point, not a date. 't7' | 't3' | 't1' are the days remaining
  -- when the mail goes out; 'expired' is the one that goes out after the trial
  -- lapses (and is also what stops the three reminders being re-sent by a sweep
  -- that runs while the user is already past their expiry).
  milestone TEXT        NOT NULL CHECK (milestone IN ('t7', 't3', 't1', 'expired')),
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, milestone)
);

-- The sweep never reads this table by index — it claims rows and moves on. This
-- index is for the operator question ("did the job run last night?") rather than
-- for the job itself.
CREATE INDEX IF NOT EXISTS idx_trial_email_log_sent_at
  ON trial_email_log (sent_at DESC);

-- Raw-SQL tables in Supabase do not automatically inherit a deny policy.
-- Reminder state contains user ids and can suppress lifecycle email, so it is
-- service-role-only just like the other backend-owned ledgers.
ALTER TABLE trial_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trial_email_log_deny_direct" ON trial_email_log;
CREATE POLICY "trial_email_log_deny_direct" ON trial_email_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE trial_email_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trial_email_log TO service_role;
$body_0016$;
END
$migration_0016$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0017_founder_profiles.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0017$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0017';
  END IF;
  -- Applied by hand before the ledger existed?
  already_applied := already_applied OR (
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'founder_profiles' AND column_name = 'profile')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'founder_profiles' AND column_name = 'updated_at')
      AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'founder_profiles' AND column_name = 'user_id')
      AND to_regclass('public."founder_profiles"') IS NOT NULL
  );
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0017 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0017';
  EXECUTE $body_0017$
-- ─────────────────────────────────────────────────────────────────────────────
-- Founder memory: a compact, per-user record of how this founder pitches.
--
-- WHY THIS EXISTS. The panel currently gets the founder's LAST score and risks
-- and nothing else (aiService.buildReturningFounderBlock). It cannot notice that
-- delivery has been this founder's weakest dimension three sessions running, or
-- that they lean on filler words when the numbers come up. A human coach
-- remembers that; this table is what lets the panel remember it too.
--
-- WHY A TABLE AND NOT users.settings
--
-- The settings JSONB bag already exists and would survive an update (the setter
-- merges). It is still the wrong home, for one decisive reason: toPublicUser()
-- returns the ENTIRE settings bag to the client on every login and refresh. A
-- profile stored there would ship the panel's private read of the founder —
-- their recurring weaknesses, the questions they dodge — in the auth payload of
-- every request. Memory about a person is not a user preference, and it must not
-- travel to the browser.
--
-- A dedicated table is server-only: it is read and written exclusively by
-- backend code using the service_role key, and RLS denies the anon key outright.
-- Same reasoning as trial_email_log (0016).
--
-- WHY ONE ROW PER USER WITH A JSONB PROFILE, rather than a row per session
--
-- The profile is a capped ring buffer of the last few sessions, read as a whole
-- at session start and rewritten as a whole at evaluation-complete. Aggregates
-- (trends, recurrence) are deliberately NOT stored: they are derived at read
-- time from the buffer, so a stored aggregate can never drift out of sync with
-- the sessions it claims to summarise. One row means one read and one upsert.
--
-- WHAT IS NOT IN HERE. No transcript, no per-session text beyond a few short
-- weakness phrases, no scores of the founder's choosing to hide. The snapshots
-- are frozen at evaluation time and are small by construction — see
-- FounderSessionSnapshot in services/founderMemoryService.ts.
--
-- user_id is INTEGER because users.id is SERIAL in this schema (0000), not a
-- UUID. ON DELETE CASCADE so the account-deletion flow takes this with it.
--
-- Idempotent: safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS founder_profiles (
  user_id    INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The FounderProfile object. NOT NULL with an empty-object default so a row
  -- can exist before the first session is folded without any reader having to
  -- handle SQL NULL as well as an absent key.
  profile    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────────────────────────────────────────────────────────────────────
-- RLS — no public access via the anon key (defense-in-depth; the backend uses
-- the service_role key, which bypasses this). Same shape as 0004.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE founder_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "founder_profiles_deny_anon" ON founder_profiles;
CREATE POLICY "founder_profiles_deny_anon" ON founder_profiles
  FOR ALL
  USING (false);
$body_0017$;
END
$migration_0017$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0018_security_and_migration_tracking.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0018$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0018';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0018 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0018';
  EXECUTE $body_0018$
-- Phase 0 security baseline
--
-- Earlier PitchNest migrations predate the migration ledger. Do not mark them
-- as applied without checking the target environment. This migration starts the
-- authoritative ledger at 0018; every later migration must record itself.


CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "schema_migrations_deny_anon" ON schema_migrations;
CREATE POLICY "schema_migrations_deny_anon"
  ON schema_migrations
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Organization dashboards may only read sessions carrying both an explicit
-- organization id and organization visibility. This partial index supports the
-- fail-closed query without changing any legacy private session.
CREATE INDEX IF NOT EXISTS idx_sessions_org_visibility_created
  ON sessions (org_id, visibility, created_at DESC)
  WHERE org_id IS NOT NULL;

-- Existing values are left for a deliberate credential migration. NOT VALID
-- still protects every newly inserted or updated organization credential.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_password_must_be_bcrypt'
      AND conrelid = '"Organizations"'::regclass
  ) THEN
    ALTER TABLE "Organizations"
      ADD CONSTRAINT organizations_password_must_be_bcrypt
      CHECK (
        password IS NULL
        OR password ~ '^\$2[aby]\$[0-9]{2}\$.{53}$'
      ) NOT VALID;
  END IF;
END
$$;

INSERT INTO schema_migrations (version, description)
VALUES ('0018', 'Security baseline and migration tracking')
ON CONFLICT (version) DO NOTHING;
$body_0018$;
END
$migration_0018$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0019_business_identity_foundation.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0019$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0019';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0019 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0019';
  EXECUTE $body_0019$
-- Phase 1: multi-business identity and private workspace foundation.
-- Depends on 0018 (schema_migrations).


CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT,
  description TEXT,
  business_type TEXT NOT NULL,
  industry TEXT,
  stage TEXT,
  region TEXT,
  problem TEXT,
  solution TEXT,
  target_customer TEXT,
  website_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  profile_version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  unpublished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT businesses_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT businesses_name_length CHECK (char_length(name) BETWEEN 2 AND 120),
  CONSTRAINT businesses_type_values CHECK (
    business_type IN ('software', 'services', 'physical', 'traditional', 'other')
  ),
  CONSTRAINT businesses_status_values CHECK (
    status IN ('draft', 'submitted', 'published', 'hidden', 'removed')
  ),
  CONSTRAINT businesses_profile_version_positive CHECK (profile_version > 0)
);

CREATE TABLE IF NOT EXISTS business_members (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  public_display_consent BOOLEAN NOT NULL DEFAULT FALSE,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (business_id, user_id),
  CONSTRAINT business_members_role_values CHECK (
    role IN ('owner', 'admin', 'editor', 'viewer')
  ),
  CONSTRAINT business_members_status_values CHECK (
    status IN ('invited', 'active', 'removed')
  )
);

CREATE TABLE IF NOT EXISTS business_slug_history (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL UNIQUE,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  public_snapshot JSONB NOT NULL,
  consent_version TEXT NOT NULL,
  approved_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active',
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ,
  UNIQUE (business_id, version),
  CONSTRAINT business_publications_status_values CHECK (
    status IN ('active', 'superseded', 'withdrawn')
  )
);

CREATE TABLE IF NOT EXISTS business_audit_log (
  id BIGSERIAL PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS practice_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  context_snapshot JSONB NOT NULL,
  source_question TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT practice_drafts_mode_values CHECK (mode IN ('solo', 'coach', 'panel'))
);

CREATE INDEX IF NOT EXISTS idx_business_members_user_active
  ON business_members (user_id, business_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_business_members_business_active
  ON business_members (business_id, role)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_businesses_status_updated
  ON businesses (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_publications_active
  ON business_publications (business_id, approved_at DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_business_audit_business_created
  ON business_audit_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_practice_drafts_owner_expiry
  ON practice_drafts (user_id, expires_at DESC);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;
ALTER TABLE decks
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_business_created
  ON sessions (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decks_business_created
  ON decks (business_id, created_at DESC)
  WHERE business_id IS NOT NULL;

CREATE OR REPLACE FUNCTION touch_business_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  IF ROW(
    NEW.name, NEW.tagline, NEW.description, NEW.business_type, NEW.industry,
    NEW.stage, NEW.region, NEW.problem, NEW.solution, NEW.target_customer,
    NEW.website_url
  ) IS DISTINCT FROM ROW(
    OLD.name, OLD.tagline, OLD.description, OLD.business_type, OLD.industry,
    OLD.stage, OLD.region, OLD.problem, OLD.solution, OLD.target_customer,
    OLD.website_url
  ) THEN
    NEW.profile_version := OLD.profile_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS businesses_touch_row ON businesses;
CREATE TRIGGER businesses_touch_row
  BEFORE UPDATE ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION touch_business_row();

CREATE OR REPLACE FUNCTION create_business_with_owner(
  p_owner_id INTEGER,
  p_slug TEXT,
  p_name TEXT,
  p_tagline TEXT,
  p_description TEXT,
  p_business_type TEXT,
  p_industry TEXT,
  p_stage TEXT,
  p_region TEXT,
  p_problem TEXT,
  p_solution TEXT,
  p_target_customer TEXT,
  p_website_url TEXT
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created businesses;
BEGIN
  INSERT INTO businesses (
    slug, name, tagline, description, business_type, industry, stage, region,
    problem, solution, target_customer, website_url, created_by
  ) VALUES (
    p_slug, p_name, p_tagline, p_description, p_business_type, p_industry,
    p_stage, p_region, p_problem, p_solution, p_target_customer, p_website_url,
    p_owner_id
  )
  RETURNING * INTO created;

  INSERT INTO business_members (
    business_id, user_id, role, status, public_display_consent, joined_at
  ) VALUES (
    created.id, p_owner_id, 'owner', 'active', FALSE, NOW()
  );

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (created.id, p_owner_id, 'business.created');

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION publish_business(
  p_business_id UUID,
  p_actor_id INTEGER,
  p_expected_profile_version INTEGER,
  p_consent_version TEXT
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
  next_publication_version INTEGER;
  snapshot JSONB;
BEGIN
  SELECT * INTO current_business
  FROM businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  IF current_business.status IN ('hidden', 'removed') THEN
    RAISE EXCEPTION 'Business cannot be published in its current state'
      USING ERRCODE = '23514';
  END IF;

  IF current_business.profile_version <> p_expected_profile_version THEN
    RAISE EXCEPTION 'Business changed after preview; review it again'
      USING ERRCODE = '40001';
  END IF;

  IF NULLIF(BTRIM(current_business.tagline), '') IS NULL
    OR NULLIF(BTRIM(current_business.description), '') IS NULL
    OR NULLIF(BTRIM(current_business.industry), '') IS NULL
    OR NULLIF(BTRIM(current_business.stage), '') IS NULL
    OR NULLIF(BTRIM(current_business.region), '') IS NULL THEN
    RAISE EXCEPTION 'Business profile is incomplete'
      USING ERRCODE = '23514';
  END IF;

  UPDATE business_publications
  SET status = 'superseded', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  UPDATE businesses
  SET status = 'published', published_at = NOW(), unpublished_at = NULL
  WHERE id = p_business_id
  RETURNING * INTO current_business;

  SELECT COALESCE(MAX(version), 0) + 1
  INTO next_publication_version
  FROM business_publications
  WHERE business_id = p_business_id;

  snapshot := jsonb_build_object(
    'id', current_business.id,
    'slug', current_business.slug,
    'name', current_business.name,
    'tagline', current_business.tagline,
    'description', current_business.description,
    'businessType', current_business.business_type,
    'industry', current_business.industry,
    'stage', current_business.stage,
    'region', current_business.region,
    'problem', current_business.problem,
    'solution', current_business.solution,
    'targetCustomer', current_business.target_customer,
    'websiteUrl', current_business.website_url,
    'publishedAt', current_business.published_at
  );

  INSERT INTO business_publications (
    business_id, version, profile_version, public_snapshot, consent_version,
    approved_by, status
  ) VALUES (
    p_business_id, next_publication_version, current_business.profile_version,
    snapshot, p_consent_version, p_actor_id, 'active'
  );

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (
    p_business_id,
    p_actor_id,
    'business.published',
    jsonb_build_object(
      'publicationVersion', next_publication_version,
      'profileVersion', current_business.profile_version,
      'consentVersion', p_consent_version
    )
  );

  RETURN current_business;
END;
$$;

CREATE OR REPLACE FUNCTION unpublish_business(
  p_business_id UUID,
  p_actor_id INTEGER
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
BEGIN
  UPDATE businesses
  SET status = 'draft', published_at = NULL, unpublished_at = NOW()
  WHERE id = p_business_id AND status = 'published'
  RETURNING * INTO current_business;

  IF NOT FOUND THEN
    SELECT * INTO current_business FROM businesses WHERE id = p_business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN current_business;
  END IF;

  UPDATE business_publications
  SET status = 'withdrawn', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (p_business_id, p_actor_id, 'business.unpublished');

  RETURN current_business;
END;
$$;

CREATE OR REPLACE FUNCTION archive_business(
  p_business_id UUID,
  p_actor_id INTEGER
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
BEGIN
  UPDATE businesses
  SET status = 'removed', published_at = NULL, unpublished_at = NOW()
  WHERE id = p_business_id AND status <> 'removed'
  RETURNING * INTO current_business;

  IF NOT FOUND THEN
    SELECT * INTO current_business FROM businesses WHERE id = p_business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN current_business;
  END IF;

  UPDATE business_publications
  SET status = 'withdrawn', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  INSERT INTO business_audit_log (business_id, actor_id, action)
  VALUES (p_business_id, p_actor_id, 'business.archived');

  UPDATE business_members
  SET status = 'removed', updated_at = NOW()
  WHERE business_id = p_business_id;

  RETURN current_business;
END;
$$;

REVOKE ALL ON FUNCTION create_business_with_owner(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_business_with_owner(
  INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION unpublish_business(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION unpublish_business(UUID, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION archive_business(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION archive_business(UUID, INTEGER)
  TO service_role;

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_slug_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "businesses_deny_direct" ON businesses;
CREATE POLICY "businesses_deny_direct" ON businesses
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_members_deny_direct" ON business_members;
CREATE POLICY "business_members_deny_direct" ON business_members
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_slug_history_deny_direct" ON business_slug_history;
CREATE POLICY "business_slug_history_deny_direct" ON business_slug_history
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_publications_deny_direct" ON business_publications;
CREATE POLICY "business_publications_deny_direct" ON business_publications
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "business_audit_log_deny_direct" ON business_audit_log;
CREATE POLICY "business_audit_log_deny_direct" ON business_audit_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "practice_drafts_deny_direct" ON practice_drafts;
CREATE POLICY "practice_drafts_deny_direct" ON practice_drafts
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0019', 'Business identity and private workspace foundation')
ON CONFLICT (version) DO NOTHING;
$body_0019$;
END
$migration_0019$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0020_discover_public_reads.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0020$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0020';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0020 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0020';
  EXECUTE $body_0020$
-- Phase 2: snapshot-only public discovery reads.
-- Depends on 0019 (business identity and publication snapshots).


CREATE INDEX IF NOT EXISTS idx_business_publications_discover_cursor
  ON business_publications (approved_at DESC, id DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_business_publications_discover_filters
  ON business_publications (
    (LOWER(public_snapshot ->> 'businessType')),
    (LOWER(public_snapshot ->> 'industry')),
    (LOWER(public_snapshot ->> 'stage')),
    (LOWER(public_snapshot ->> 'region'))
  )
  WHERE status = 'active';

-- The application service role is the only caller. Returning the approved JSON
-- snapshot prevents a future private column on businesses from silently becoming
-- public through SELECT * or an expanding join.
CREATE OR REPLACE FUNCTION discover_public_businesses(
  p_query TEXT DEFAULT NULL,
  p_industry TEXT DEFAULT NULL,
  p_business_type TEXT DEFAULT NULL,
  p_stage TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_cursor_published_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_publication_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 13
)
RETURNS TABLE (
  publication_id UUID,
  published_at TIMESTAMPTZ,
  public_snapshot JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    publication.id AS publication_id,
    publication.approved_at AS published_at,
    publication.public_snapshot
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
    AND (
      p_cursor_published_at IS NULL
      OR p_cursor_publication_id IS NULL
      OR (publication.approved_at, publication.id)
        < (p_cursor_published_at, p_cursor_publication_id)
    )
  ORDER BY publication.approved_at DESC, publication.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 25);
$$;

CREATE OR REPLACE FUNCTION get_public_business_by_slug(p_slug TEXT)
RETURNS TABLE (
  published_at TIMESTAMPTZ,
  public_snapshot JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT publication.approved_at, publication.public_snapshot
  FROM business_publications AS publication
  INNER JOIN businesses AS business
    ON business.id = publication.business_id
  WHERE publication.status = 'active'
    AND business.status = 'published'
    AND business.slug = BTRIM(p_slug)
    AND business.slug = publication.public_snapshot ->> 'slug'
  ORDER BY publication.approved_at DESC
  LIMIT 1;
$$;

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
  GROUP BY business.id, business.slug
  ORDER BY MAX(publication.approved_at) DESC
  LIMIT 49998;
$$;

REVOKE ALL ON FUNCTION discover_public_businesses(
  TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION discover_public_businesses(
  TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION get_public_business_by_slug(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_public_business_by_slug(TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION list_public_business_sitemap()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_public_business_sitemap()
  TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0020', 'Snapshot-only public business discovery reads')
ON CONFLICT (version) DO NOTHING;
$body_0020$;
END
$migration_0020$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0021_discover_engagement.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0021$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0021';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0021 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0021';
  EXECUTE $body_0021$
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
$body_0021$;
END
$migration_0021$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0022_updates_notifications.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0022$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0022';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0022 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0022';
  EXECUTE $body_0022$
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
$body_0022$;
END
$migration_0022$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0023_community.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0023$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0023';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0023 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0023';
  EXECUTE $body_0023$
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
$body_0023$;
END
$migration_0023$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0024_opportunities.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0024$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0024';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0024 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0024';
  EXECUTE $body_0024$
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
$body_0024$;
END
$migration_0024$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0025_product_events.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0025$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0025';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0025 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0025';
  EXECUTE $body_0025$
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
$body_0025$;
END
$migration_0025$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0026_public_pitches.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0026$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0026';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0026 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0026';
  EXECUTE $body_0026$
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
$body_0026$;
END
$migration_0026$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0027_emergency_security_hardening.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0027$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0027';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0027 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0027';
  EXECUTE $body_0027$
-- Emergency security hardening discovered during the full application audit.
-- Idempotent and safe to apply after 0026.


-- Billing settlement is callable only by the backend service role. Protect the
-- active four-argument function and the legacy five-argument overload when it
-- still exists in an environment that has not completed migration 0010.
DO $$
BEGIN
  IF to_regprocedure('public.grant_pro_access(text,text,numeric,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pro_access(text,text,numeric,text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pro_access(text,text,numeric,text) TO service_role';
    EXECUTE 'ALTER FUNCTION public.grant_pro_access(text,text,numeric,text) SET search_path = public';
  END IF;

  IF to_regprocedure('public.grant_pro_access(text,text,numeric,text,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pro_access(text,text,numeric,text,integer) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pro_access(text,text,numeric,text,integer) TO service_role';
    EXECUTE 'ALTER FUNCTION public.grant_pro_access(text,text,numeric,text,integer) SET search_path = public';
  END IF;
END
$$;

-- Trial reminder claims are backend-owned state. Direct access could expose
-- user identifiers or let a caller suppress email by pre-claiming milestones.
ALTER TABLE trial_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trial_email_log_deny_direct" ON trial_email_log;
CREATE POLICY "trial_email_log_deny_direct" ON trial_email_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE trial_email_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trial_email_log TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0027', 'Emergency billing RPC and trial lifecycle hardening')
ON CONFLICT (version) DO NOTHING;
$body_0027$;
END
$migration_0027$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0028_business_media_and_team.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0028$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0028';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0028 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0028';
  EXECUTE $body_0028$
-- Business logos, cover images, and consenting team members on public profiles.
-- Depends on 0019 (businesses, members, publications).
--
--   * logo_file / cover_file name an image the backend has already processed
--     (resized, re-encoded as WebP, all metadata stripped). Drafts live in the
--     private media bucket. When the business is published the backend copies
--     the approved files to public storage, and it removes them again when the
--     business is unpublished, archived or hidden by moderation.
--   * Changing either image bumps profile_version, so the publication preview
--     and the publishing consent always cover the images that go public.
--   * The publication snapshot records the approved file names.
--   * business_members.public_title is the member's own public job title. A
--     member appears on the public profile only while they personally consent
--     (public_display_consent) and the business is published.


ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS logo_file TEXT,
  ADD COLUMN IF NOT EXISTS cover_file TEXT;

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_logo_file_format;
ALTER TABLE businesses ADD CONSTRAINT businesses_logo_file_format
  CHECK (logo_file IS NULL OR logo_file ~ '^logo-[a-f0-9]{32}\.webp$');

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_cover_file_format;
ALTER TABLE businesses ADD CONSTRAINT businesses_cover_file_format
  CHECK (cover_file IS NULL OR cover_file ~ '^cover-[a-f0-9]{32}\.webp$');

ALTER TABLE business_members
  ADD COLUMN IF NOT EXISTS public_title TEXT;

ALTER TABLE business_members DROP CONSTRAINT IF EXISTS business_members_public_title_length;
ALTER TABLE business_members ADD CONSTRAINT business_members_public_title_length
  CHECK (public_title IS NULL OR char_length(public_title) <= 80);

CREATE INDEX IF NOT EXISTS idx_business_members_public_team
  ON business_members (business_id)
  WHERE status = 'active' AND public_display_consent = TRUE;

CREATE OR REPLACE FUNCTION touch_business_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  IF ROW(
    NEW.name, NEW.tagline, NEW.description, NEW.business_type, NEW.industry,
    NEW.stage, NEW.region, NEW.problem, NEW.solution, NEW.target_customer,
    NEW.website_url, NEW.logo_file, NEW.cover_file
  ) IS DISTINCT FROM ROW(
    OLD.name, OLD.tagline, OLD.description, OLD.business_type, OLD.industry,
    OLD.stage, OLD.region, OLD.problem, OLD.solution, OLD.target_customer,
    OLD.website_url, OLD.logo_file, OLD.cover_file
  ) THEN
    NEW.profile_version := OLD.profile_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Same signature and behaviour as 0019; the snapshot now also records the
-- approved image files. CREATE OR REPLACE keeps the existing grants.
CREATE OR REPLACE FUNCTION publish_business(
  p_business_id UUID,
  p_actor_id INTEGER,
  p_expected_profile_version INTEGER,
  p_consent_version TEXT
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_business businesses;
  next_publication_version INTEGER;
  snapshot JSONB;
BEGIN
  SELECT * INTO current_business
  FROM businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'P0002';
  END IF;

  IF current_business.status IN ('hidden', 'removed') THEN
    RAISE EXCEPTION 'Business cannot be published in its current state'
      USING ERRCODE = '23514';
  END IF;

  IF current_business.profile_version <> p_expected_profile_version THEN
    RAISE EXCEPTION 'Business changed after preview; review it again'
      USING ERRCODE = '40001';
  END IF;

  IF NULLIF(BTRIM(current_business.tagline), '') IS NULL
    OR NULLIF(BTRIM(current_business.description), '') IS NULL
    OR NULLIF(BTRIM(current_business.industry), '') IS NULL
    OR NULLIF(BTRIM(current_business.stage), '') IS NULL
    OR NULLIF(BTRIM(current_business.region), '') IS NULL THEN
    RAISE EXCEPTION 'Business profile is incomplete'
      USING ERRCODE = '23514';
  END IF;

  UPDATE business_publications
  SET status = 'superseded', withdrawn_at = NOW()
  WHERE business_id = p_business_id AND status = 'active';

  UPDATE businesses
  SET status = 'published', published_at = NOW(), unpublished_at = NULL
  WHERE id = p_business_id
  RETURNING * INTO current_business;

  SELECT COALESCE(MAX(version), 0) + 1
  INTO next_publication_version
  FROM business_publications
  WHERE business_id = p_business_id;

  snapshot := jsonb_build_object(
    'id', current_business.id,
    'slug', current_business.slug,
    'name', current_business.name,
    'tagline', current_business.tagline,
    'description', current_business.description,
    'businessType', current_business.business_type,
    'industry', current_business.industry,
    'stage', current_business.stage,
    'region', current_business.region,
    'problem', current_business.problem,
    'solution', current_business.solution,
    'targetCustomer', current_business.target_customer,
    'websiteUrl', current_business.website_url,
    'logoFile', current_business.logo_file,
    'coverFile', current_business.cover_file,
    'publishedAt', current_business.published_at
  );

  INSERT INTO business_publications (
    business_id, version, profile_version, public_snapshot, consent_version,
    approved_by, status
  ) VALUES (
    p_business_id, next_publication_version, current_business.profile_version,
    snapshot, p_consent_version, p_actor_id, 'active'
  );

  INSERT INTO business_audit_log (business_id, actor_id, action, metadata)
  VALUES (
    p_business_id,
    p_actor_id,
    'business.published',
    jsonb_build_object(
      'publicationVersion', next_publication_version,
      'profileVersion', current_business.profile_version,
      'consentVersion', p_consent_version
    )
  );

  RETURN current_business;
END;
$$;

INSERT INTO schema_migrations (version, description)
VALUES ('0028', 'Business logos, cover images and consenting public team members')
ON CONFLICT (version) DO NOTHING;
$body_0028$;
END
$migration_0028$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0029_founder_pages_and_follows.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0029$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0029';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0029 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0029';
  EXECUTE $body_0029$
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
$body_0029$;
END
$migration_0029$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0030_auth_and_erasure_hardening.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0030$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0030';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0030 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0030';
  EXECUTE $body_0030$
-- Authentication revocation and account-erasure hardening.
-- Depends on 0029.


-- Incremented after a password reset or explicit logout. JWTs carry the value
-- they were issued with, so old tokens stop working immediately instead of
-- remaining valid for up to 30 days.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

-- Every pre-Google account was created with a password. Backfill those legacy
-- rows once, then make the authentication method explicit and immutable at the
-- application boundary. Leaving NULL claimable by the first OAuth login would
-- let someone with a same-address provider account change a password account's
-- sign-in method.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_provider TEXT;
UPDATE users SET auth_provider = 'form' WHERE auth_provider IS NULL;
ALTER TABLE users
  ALTER COLUMN auth_provider SET DEFAULT 'form',
  ALTER COLUMN auth_provider SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
ALTER TABLE users ADD CONSTRAINT users_auth_provider_check
  CHECK (auth_provider IN ('form', 'google'));

-- An organization invite is not membership until the address is verified.
-- Keeping it separate prevents an unverified signup from consuming a seat or
-- exposing its email/session activity to an organization dashboard.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_org_code TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pending_org_code_format;
ALTER TABLE users ADD CONSTRAINT users_pending_org_code_format
  CHECK (pending_org_code IS NULL OR pending_org_code ~ '^[0-9]{1,18}$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_version_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_auth_version_nonnegative
  CHECK (auth_version >= 0);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_failed_login_attempts_nonnegative;
ALTER TABLE users ADD CONSTRAINT users_failed_login_attempts_nonnegative
  CHECK (failed_login_attempts >= 0);

ALTER TABLE "Organizations"
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE "Organizations" DROP CONSTRAINT IF EXISTS organizations_auth_version_nonnegative;
ALTER TABLE "Organizations" ADD CONSTRAINT organizations_auth_version_nonnegative
  CHECK (auth_version >= 0);
ALTER TABLE "Organizations" DROP CONSTRAINT IF EXISTS organizations_failed_login_attempts_nonnegative;
ALTER TABLE "Organizations" ADD CONSTRAINT organizations_failed_login_attempts_nonnegative
  CHECK (failed_login_attempts >= 0);

CREATE OR REPLACE FUNCTION revoke_user_sessions(p_user_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  UPDATE users
  SET auth_version = auth_version + 1
  WHERE id = p_user_id
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION rotate_user_password(p_user_id INTEGER, p_password_hash TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;
  UPDATE users
  SET password = p_password_hash,
      auth_version = auth_version + 1,
      failed_login_attempts = 0,
      locked_until = NULL
  WHERE id = p_user_id AND auth_provider IS DISTINCT FROM 'google'
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

-- Consume the one-time verification row and flip the account state in one
-- transaction. Application-side delete-then-update can strand an account with
-- no usable token if the second network call fails.
CREATE OR REPLACE FUNCTION consume_email_verification(
  p_token_id INTEGER,
  p_user_id INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed_id INTEGER;
BEGIN
  DELETE FROM email_verification_tokens
   WHERE id = p_token_id
     AND user_id = p_user_id
     AND expires_at > NOW()
   RETURNING id INTO consumed_id;
  IF consumed_id IS NULL THEN
    RETURN FALSE;
  END IF;

  DELETE FROM email_verification_tokens WHERE user_id = p_user_id;

  UPDATE users SET "isEmailVerified" = TRUE WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN TRUE;
END;
$$;

-- Mark a reset token used, rotate the hash, clear lockout state, and revoke all
-- old sessions atomically. Any failure rolls the entire operation back.
CREATE OR REPLACE FUNCTION consume_password_reset(
  p_reset_id INTEGER,
  p_user_id INTEGER,
  p_password_hash TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  consumed_id INTEGER;
  next_version INTEGER;
BEGIN
  IF p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' THEN
    RAISE EXCEPTION 'Invalid password hash' USING ERRCODE = '22023';
  END IF;

  DELETE FROM password_resets
   WHERE id = p_reset_id
     AND user_id = p_user_id
     AND used = FALSE
     AND expires_at > NOW()
   RETURNING id INTO consumed_id;
  IF consumed_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Concurrent reset requests can create more than one valid row. Once any
  -- token succeeds, revoke every sibling token in the same transaction so an
  -- older email cannot change the password again afterward.
  DELETE FROM password_resets WHERE user_id = p_user_id;

  UPDATE users
     SET password = p_password_hash,
         auth_version = auth_version + 1,
         failed_login_attempts = 0,
         locked_until = NULL
   WHERE id = p_user_id AND auth_provider IS DISTINCT FROM 'google'
   RETURNING auth_version INTO next_version;
  IF next_version IS NULL THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION record_failed_login(p_user_id INTEGER)
RETURNS TABLE(failed_attempts INTEGER, lock_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE users
  SET failed_login_attempts = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
        ELSE failed_login_attempts + 1
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
          ELSE failed_login_attempts + 1
        END) >= 5 THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END
  WHERE id = p_user_id
  RETURNING users.failed_login_attempts, users.locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION record_failed_org_login(p_org_id INTEGER)
RETURNS TABLE(failed_attempts INTEGER, lock_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE "Organizations"
  SET failed_login_attempts = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
        ELSE failed_login_attempts + 1
      END,
      locked_until = CASE
        WHEN (CASE
          WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
          ELSE failed_login_attempts + 1
        END) >= 5 THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END
  WHERE id = p_org_id
  RETURNING "Organizations".failed_login_attempts, "Organizations".locked_until;
END;
$$;

CREATE OR REPLACE FUNCTION revoke_organization_sessions(p_org_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  UPDATE "Organizations"
  SET auth_version = auth_version + 1
  WHERE id = p_org_id
  RETURNING auth_version INTO next_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN next_version;
END;
$$;

CREATE OR REPLACE FUNCTION enroll_user_in_organization(
  p_user_id INTEGER,
  p_org_code TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_user users%ROWTYPE;
  target_org "Organizations"%ROWTYPE;
  requested_code TEXT;
  enrolled_count INTEGER;
BEGIN
  SELECT * INTO target_user FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  IF target_user."orgCode" IS NOT NULL THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN target_user."orgCode";
  END IF;

  requested_code := COALESCE(NULLIF(TRIM(p_org_code), ''), target_user.pending_org_code);
  IF requested_code IS NULL OR requested_code !~ '^[0-9]{1,18}$' THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  SELECT * INTO target_org
    FROM "Organizations"
   WHERE org_code::TEXT = requested_code
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;
  IF target_org.validity IS NOT NULL AND target_org.validity <= NOW() THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::INTEGER INTO enrolled_count
    FROM users
   WHERE "orgCode" = requested_code;
  IF enrolled_count >= GREATEST(COALESCE(target_org.org_users_capacity, 0), 0) THEN
    UPDATE users SET pending_org_code = NULL WHERE id = p_user_id;
    RETURN NULL;
  END IF;

  UPDATE users
     SET "orgCode" = requested_code,
         pending_org_code = NULL,
         enrolled_at = NOW()
   WHERE id = p_user_id AND "isEmailVerified" = TRUE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- The orgCode trigger below recounts the organization atomically after this
  -- row update; do not increment the denormalized count a second time here.
  RETURN requested_code;
END;
$$;

CREATE OR REPLACE FUNCTION sync_organization_enrollment_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_code TEXT;
  new_code TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_code := OLD."orgCode";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_code := NEW."orgCode";
  END IF;
  IF old_code IS NOT NULL THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (SELECT COUNT(*) FROM users WHERE "orgCode" = old_code)
     WHERE org_code::TEXT = old_code;
  END IF;
  IF new_code IS NOT NULL AND new_code IS DISTINCT FROM old_code THEN
    UPDATE "Organizations"
       SET org_users_enrolled = (SELECT COUNT(*) FROM users WHERE "orgCode" = new_code)
     WHERE org_code::TEXT = new_code;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_organization_enrollment_count ON users;
CREATE TRIGGER trg_sync_organization_enrollment_count
AFTER INSERT OR UPDATE OF "orgCode" OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION sync_organization_enrollment_count();

UPDATE "Organizations" AS organization
SET org_users_enrolled = (
  SELECT COUNT(*) FROM users WHERE "orgCode" = organization.org_code::TEXT
);

-- A business with another active member is shared workspace data and survives
-- its creator's departure. A business with no other active member would become
-- an ownerless public profile, so delete it (and all DB children) as part of the
-- same user-delete transaction. Object storage is removed by the application
-- before issuing the user delete.
CREATE OR REPLACE FUNCTION delete_orphaned_user_businesses()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM businesses AS business
   WHERE (
     business.created_by = OLD.id
     OR EXISTS (
       SELECT 1 FROM business_members mine
        WHERE mine.business_id = business.id AND mine.user_id = OLD.id
     )
   )
   AND NOT EXISTS (
     SELECT 1 FROM business_members other_member
      WHERE other_member.business_id = business.id
        AND other_member.user_id <> OLD.id
        AND other_member.status = 'active'
   );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_delete_orphaned_user_businesses ON users;
CREATE TRIGGER trg_delete_orphaned_user_businesses
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION delete_orphaned_user_businesses();

-- Archive/dashboard reads must not pull every full transcript and recording key
-- through the API just to discard them in Node. This service-role-only view is
-- a database-level projection, so those private fields never leave Postgres.
CREATE OR REPLACE VIEW session_list_safe
WITH (security_invoker = true)
AS
SELECT
  id,
  user_id,
  "timestamp",
  summary,
  COALESCE(evaluation_report, '{}'::jsonb) - 'transcript' AS evaluation_report,
  business_name,
  share_id,
  created_at,
  mode,
  parent_session_id,
  pitch_config,
  org_id,
  visibility,
  pitch_root_id,
  attempt_number,
  business_id,
  share_enabled,
  (video_url IS NOT NULL AND BTRIM(video_url) <> '') AS has_recording
FROM sessions;

REVOKE ALL ON session_list_safe FROM PUBLIC, anon, authenticated;
GRANT SELECT ON session_list_safe TO service_role;

CREATE INDEX IF NOT EXISTS idx_sessions_user_timestamp
  ON sessions (user_id, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_users_active_trial_expiry
  ON users (trial_expires_at, id)
  WHERE trial_status = 'active' AND "isEmailVerified" = TRUE;

-- Human access to confidential founder transcripts must leave a durable audit
-- trail outside ephemeral application logs. The endpoint writes one summary row
-- per paginated read and refuses to disclose data if that write fails.
CREATE TABLE IF NOT EXISTS staff_data_access_log (
  id BIGSERIAL PRIMARY KEY,
  staff_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('transcript_review')),
  result_count INTEGER NOT NULL CHECK (result_count >= 0),
  query_details JSONB NOT NULL DEFAULT '{}'::JSONB,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_data_access_time
  ON staff_data_access_log (accessed_at DESC);
ALTER TABLE staff_data_access_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_data_access_deny_direct" ON staff_data_access_log;
CREATE POLICY "staff_data_access_deny_direct" ON staff_data_access_log
  FOR ALL USING (FALSE) WITH CHECK (FALSE);
REVOKE ALL ON staff_data_access_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON staff_data_access_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE staff_data_access_log_id_seq TO service_role;

-- A reminder claim is a lease, not a permanent marker, until the provider has
-- accepted the message. This closes the process-crash gap in the original
-- insert-before-send design: an unfinished lease can be reclaimed after 30
-- minutes, while a delivered row remains final. `sent_at` is retained for
-- compatibility with the original table and records the first claim time;
-- `delivered_at` is now the authoritative delivery timestamp.
ALTER TABLE trial_email_log
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_id UUID;

-- Rows created by migration 0016 represented successfully completed sends.
-- Backfill them before the application starts using lease semantics.
UPDATE trial_email_log
   SET claimed_at = COALESCE(claimed_at, sent_at),
       delivered_at = COALESCE(delivered_at, sent_at)
 WHERE delivered_at IS NULL AND lease_id IS NULL;

CREATE OR REPLACE FUNCTION claim_trial_email(
  p_user_id INTEGER,
  p_milestone TEXT,
  p_lease_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed BOOLEAN := FALSE;
BEGIN
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'A lease id is required' USING ERRCODE = '22023';
  END IF;
  IF p_milestone NOT IN ('t7', 't3', 't1', 'expired') THEN
    RAISE EXCEPTION 'Invalid trial milestone' USING ERRCODE = '22023';
  END IF;

  INSERT INTO trial_email_log (
    user_id, milestone, sent_at, claimed_at, delivered_at, lease_id
  ) VALUES (
    p_user_id, p_milestone, NOW(), NOW(), NULL, p_lease_id
  )
  ON CONFLICT (user_id, milestone) DO UPDATE
     SET claimed_at = EXCLUDED.claimed_at,
         lease_id = EXCLUDED.lease_id
   WHERE trial_email_log.delivered_at IS NULL
     AND trial_email_log.claimed_at < NOW() - INTERVAL '30 minutes'
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

-- Serialize limited-plan quota claims on the owning user row. The former
-- insert-then-count sequence could admit two requests on separate application
-- instances because each transaction need not see the other's uncommitted row.
-- This function checks and records under one row lock and therefore remains
-- authoritative when the backend scales horizontally.
CREATE OR REPLACE FUNCTION claim_weekly_session_slot(
  p_user_id INTEGER,
  p_limit INTEGER
)
RETURNS TABLE(
  allowed BOOLEAN,
  used INTEGER,
  remaining INTEGER,
  resets_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_used INTEGER;
  oldest_start TIMESTAMPTZ;
BEGIN
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Invalid session limit' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COUNT(*)::INTEGER, MIN(started_at)
    INTO current_used, oldest_start
    FROM session_starts
   WHERE user_id = p_user_id
     AND started_at > NOW() - INTERVAL '7 days';

  IF current_used >= p_limit THEN
    RETURN QUERY SELECT
      FALSE,
      current_used,
      0,
      oldest_start + INTERVAL '7 days';
    RETURN;
  END IF;

  INSERT INTO session_starts (user_id) VALUES (p_user_id);
  current_used := current_used + 1;
  IF oldest_start IS NULL THEN
    oldest_start := NOW();
  END IF;

  RETURN QUERY SELECT
    TRUE,
    current_used,
    GREATEST(0, p_limit - current_used),
    oldest_start + INTERVAL '7 days';
END;
$$;

REVOKE ALL ON FUNCTION revoke_user_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION rotate_user_password(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION rotate_user_password(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION consume_email_verification(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_email_verification(INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION consume_password_reset(INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_password_reset(INTEGER, INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION record_failed_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION record_failed_org_login(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_failed_org_login(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION revoke_organization_sessions(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revoke_organization_sessions(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION enroll_user_in_organization(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION enroll_user_in_organization(INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION sync_organization_enrollment_count() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION delete_orphaned_user_businesses() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_trial_email(INTEGER, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_trial_email(INTEGER, TEXT, UUID) TO service_role;
REVOKE ALL ON FUNCTION claim_weekly_session_slot(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_weekly_session_slot(INTEGER, INTEGER) TO service_role;

-- A person may erase their account without deleting a shared business. These
-- provenance fields are intentionally nullable and become anonymous when the
-- referenced user is deleted; memberships and genuinely personal records
-- continue to cascade as defined by their own foreign keys.
ALTER TABLE businesses
  ALTER COLUMN created_by DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS businesses_created_by_fkey;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE business_publications
  ALTER COLUMN approved_by DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS business_publications_approved_by_fkey;
ALTER TABLE business_publications
  ADD CONSTRAINT business_publications_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- Enforce the payment invariant in the database too. Settlement may only move
-- a pending row to successful when the verified provider amount covers the
-- checkout amount and the currency is identical. This protects the grant RPC
-- even if a future caller forgets the controller-side comparison.
CREATE OR REPLACE FUNCTION enforce_payment_settlement()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'successful' AND NEW.status = 'successful' THEN
    IF NEW.amount < OLD.amount THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF UPPER(NEW.currency) <> UPPER(OLD.currency) THEN
      RAISE EXCEPTION 'PAYMENT_CURRENCY_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NEW.plan IS DISTINCT FROM OLD.plan
      OR NEW.term IS DISTINCT FROM OLD.term
      OR NEW.granted_days IS DISTINCT FROM OLD.granted_days THEN
      RAISE EXCEPTION 'PAYMENT_GRANT_CHANGED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_payment_settlement ON payments;
CREATE TRIGGER trg_enforce_payment_settlement
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION enforce_payment_settlement();

-- Keep the invariant inside the settlement function as well as in the trigger:
-- amount/currency are checked against the locked checkout row before any grant.
CREATE OR REPLACE FUNCTION grant_pro_access(
  p_tx_ref TEXT,
  p_provider_ref TEXT,
  p_amount NUMERIC,
  p_currency TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_user users;
  v_target TEXT;
  v_days INTEGER;
  v_rank_target INTEGER;
  v_rank_current INTEGER;
  v_new_plan TEXT;
BEGIN
  SELECT * INTO v_payment
    FROM payments
   WHERE tx_ref = p_tx_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UNKNOWN_TX_REF';
  END IF;
  IF v_payment.status = 'successful' THEN
    RETURN FALSE;
  END IF;
  IF p_amount IS NULL OR p_amount < v_payment.amount THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF p_currency IS NULL OR UPPER(TRIM(p_currency)) <> UPPER(TRIM(v_payment.currency)) THEN
    RAISE EXCEPTION 'PAYMENT_CURRENCY_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF p_provider_ref IS NULL OR LENGTH(TRIM(p_provider_ref)) = 0 OR LENGTH(p_provider_ref) > 255 THEN
    RAISE EXCEPTION 'INVALID_PROVIDER_REFERENCE' USING ERRCODE = '22023';
  END IF;

  v_target := COALESCE(v_payment.plan, 'pro');
  v_days := COALESCE(v_payment.granted_days, 30);
  IF v_target NOT IN ('prep', 'pro') OR v_days NOT BETWEEN 1 AND 3650 THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_GRANT' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_user FROM users WHERE id = v_payment.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_USER_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE payments
     SET status = 'successful',
         provider_ref = TRIM(p_provider_ref),
         amount = p_amount,
         currency = UPPER(TRIM(p_currency)),
         completed_at = NOW()
   WHERE id = v_payment.id;

  -- Do not replace any unlimited paid/grandfathered access with a dated plan.
  IF v_user.plan IN ('prep', 'pro', 'founder', 'enterprise')
     AND v_user.plan_expires_at IS NULL THEN
    RETURN TRUE;
  END IF;

  v_rank_target := CASE v_target WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END;
  v_rank_current := CASE
    WHEN v_user.plan_expires_at IS NOT NULL AND v_user.plan_expires_at > NOW()
      THEN CASE v_user.plan
        WHEN 'enterprise' THEN 4 WHEN 'founder' THEN 3
        WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END
    ELSE 0
  END;
  v_new_plan := CASE WHEN v_rank_current > v_rank_target THEN v_user.plan ELSE v_target END;

  UPDATE users
     SET plan = v_new_plan,
         plan_expires_at = GREATEST(COALESCE(plan_expires_at, NOW()), NOW())
                           + (v_days || ' days')::INTERVAL
   WHERE id = v_user.id;

  RETURN TRUE;
END;
$$;

-- CREATE OR REPLACE normally retains ACLs, but reassert this explicitly in the
-- same migration so a fresh, restored or partially migrated environment cannot
-- expose a subscription-granting SECURITY DEFINER function.
REVOKE ALL ON FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  TO service_role;
ALTER FUNCTION grant_pro_access(TEXT, TEXT, NUMERIC, TEXT)
  SET search_path = public;

-- 0028 replaces this SECURITY DEFINER function. Reassert the least-privilege
-- grant explicitly rather than relying on CREATE OR REPLACE preserving ACLs.
REVOKE ALL ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION publish_business(UUID, INTEGER, INTEGER, TEXT)
  TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0030', 'Authentication, organization enrollment, billing, email delivery, privacy and erasure hardening')
ON CONFLICT (version) DO NOTHING;
$body_0030$;
END
$migration_0030$;


-- ════════════════════════════════════════════════════════════════════════════
-- 0031_recurring_subscriptions.sql
-- ════════════════════════════════════════════════════════════════════════════
DO $migration_0031$
DECLARE
  already_applied BOOLEAN := false;
BEGIN
  IF to_regclass('public.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = $1)'
      INTO already_applied USING '0031';
  END IF;
  IF already_applied THEN
    RAISE NOTICE 'PitchNest upgrade: 0031 already applied, skipped';
    RETURN;
  END IF;
  RAISE NOTICE 'PitchNest upgrade: applying 0031';
  EXECUTE $body_0031$
-- Auto-renewing subscriptions on Flutterwave payment plans.
-- Depends on 0030 (settlement invariants and the current grant_pro_access).
--
--   * billing_provider_plans caches the Flutterwave payment plan created for
--     each (plan, term, amount, currency). A price change makes a new row, so a
--     subscriber keeps renewing at the price they signed up for.
--   * subscriptions holds one row per subscription we started. At most one is
--     active per user. Starting a new one retires the old row and marks it
--     provider_cancel_pending until Flutterwave confirms the cancel, so a plan
--     switch can never leave two renewals charging the same card.
--   * payments.kind separates the first subscription charge from renewals and
--     from legacy one-off purchases. bonus_days records the free month given on
--     a first subscription; it is already included in granted_days.
--
-- Access is still granted only by grant_pro_access on a verified payment, and
-- entitlement still reads users.plan_expires_at. A subscription row never
-- grants anything by itself.


CREATE TABLE IF NOT EXISTS billing_provider_plans (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  plan TEXT NOT NULL CHECK (plan IN ('prep', 'pro')),
  term TEXT NOT NULL CHECK (term IN ('monthly', 'annual')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_plan_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_provider_plans_sku UNIQUE (provider, plan, term, amount, currency)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  plan TEXT NOT NULL CHECK (plan IN ('prep', 'pro')),
  term TEXT NOT NULL CHECK (term IN ('monthly', 'annual')),
  -- The recurring charge renewals are checked against.
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_plan_id BIGINT NOT NULL,
  -- Learned from Flutterwave after the first charge; needed to cancel.
  provider_subscription_id BIGINT,
  -- Flutterwave binds a subscription to the email used at checkout.
  customer_email TEXT NOT NULL,
  initial_tx_ref TEXT NOT NULL UNIQUE REFERENCES payments(tx_ref) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  provider_cancel_pending BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_user
  ON subscriptions (user_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_user
  ON subscriptions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_cancel_pending
  ON subscriptions (user_id) WHERE provider_cancel_pending;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'one_time',
  ADD COLUMN IF NOT EXISTS provider_plan_id BIGINT,
  ADD COLUMN IF NOT EXISTS bonus_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_values;
ALTER TABLE payments ADD CONSTRAINT payments_kind_values
  CHECK (kind IN ('one_time', 'subscription_initial', 'subscription_renewal'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bonus_days_range;
ALTER TABLE payments ADD CONSTRAINT payments_bonus_days_range
  CHECK (bonus_days BETWEEN 0 AND 400);

CREATE INDEX IF NOT EXISTS idx_payments_user_settled
  ON payments (user_id) WHERE status = 'successful';

-- Records the subscription a settled first charge started, retiring any
-- earlier one. Idempotent: a webhook replay returns the same subscription.
CREATE OR REPLACE FUNCTION start_subscription_from_payment(
  p_tx_ref TEXT,
  p_customer_email TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment payments;
  v_amount NUMERIC(12, 2);
  v_id UUID;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE tx_ref = p_tx_ref FOR UPDATE;
  IF NOT FOUND
     OR v_payment.status <> 'successful'
     OR v_payment.kind <> 'subscription_initial'
     OR v_payment.provider_plan_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_payment.subscription_id IS NOT NULL THEN
    RETURN v_payment.subscription_id;
  END IF;
  IF p_customer_email IS NULL OR LENGTH(TRIM(p_customer_email)) = 0 THEN
    RAISE EXCEPTION 'SUBSCRIPTION_EMAIL_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- The plan's recurring price, not the first charge (which may differ).
  SELECT amount INTO v_amount
    FROM billing_provider_plans
   WHERE provider = v_payment.provider
     AND provider_plan_id = v_payment.provider_plan_id
   ORDER BY id DESC
   LIMIT 1;
  IF v_amount IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_PROVIDER_PLAN' USING ERRCODE = '23503';
  END IF;

  UPDATE subscriptions
     SET status = 'cancelled',
         cancelled_at = NOW(),
         provider_cancel_pending = TRUE,
         updated_at = NOW()
   WHERE user_id = v_payment.user_id
     AND status = 'active';

  INSERT INTO subscriptions (
    user_id, provider, plan, term, amount, currency,
    provider_plan_id, customer_email, initial_tx_ref
  )
  VALUES (
    v_payment.user_id, v_payment.provider, v_payment.plan, v_payment.term,
    v_amount, UPPER(v_payment.currency), v_payment.provider_plan_id,
    LOWER(TRIM(p_customer_email)), v_payment.tx_ref
  )
  ON CONFLICT (initial_tx_ref) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM subscriptions WHERE initial_tx_ref = v_payment.tx_ref;
  END IF;

  UPDATE payments SET subscription_id = v_id WHERE id = v_payment.id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION start_subscription_from_payment(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION start_subscription_from_payment(TEXT, TEXT) TO service_role;

ALTER TABLE billing_provider_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_provider_plans_deny_direct" ON billing_provider_plans;
CREATE POLICY "billing_provider_plans_deny_direct" ON billing_provider_plans
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "subscriptions_deny_direct" ON subscriptions;
CREATE POLICY "subscriptions_deny_direct" ON subscriptions
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0031', 'Auto-renewing subscriptions on Flutterwave payment plans')
ON CONFLICT (version) DO NOTHING;
$body_0031$;
END
$migration_0031$;


-- ── Ledger rows for the migrations that predate schema_migrations ───────────
INSERT INTO schema_migrations (version, description) VALUES
  ('0015', 'Session sharing'),
  ('0016', 'Trial email log'),
  ('0017', 'Founder profiles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
