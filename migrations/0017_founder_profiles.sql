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
