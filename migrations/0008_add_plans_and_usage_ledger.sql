-- Migration 0008: Two-tier plans (free/pro) + a start-time session usage ledger.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run,
-- EXCEPT for the grandfathering UPDATE in section 2. Read that warning first.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- WHY A LEDGER, AND NOT COUNT(*) FROM sessions
-- ──────────────────────────────────────────────────────────────────────────────
-- Session rows are inserted ONLY at end_session (sockets/restSocket.ts). Two
-- consequences make the sessions table unusable as a quota meter:
--
--   1. A user who closes the tab mid-pitch burns the full Azure STT/LLM/TTS
--      cost and consumes ZERO quota. The expensive thing already happened.
--   2. Deleting a session would refund quota.
--
-- So usage is metered by session_starts, written at session START before any
-- AI work begins. The ledger is append-only and deliberately denormalised: it
-- records that a session was STARTED, which is the event that costs money,
-- and stays correct even if the resulting session row is later deleted.
--
-- WHY A ROLLING 7-DAY WINDOW, NOT A CALENDAR WEEK
-- A calendar reset lets a Friday + Sunday user take 4 sessions inside ~48h,
-- and "your quota resets Monday" is a support burden. The quota query is
-- `started_at > now() - interval '7 days'`, which is unambiguous.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. USERS — plan column
-- ──────────────────────────────────────────────────────────────────────────────
-- Entitlement lives in its own column, NOT in users.settings. settings is a
-- user-writable preferences bag (see sanitizeSettings in authController.ts) —
-- an entitlement is not a preference and must never be settable by its holder.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro'));

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. GRANDFATHERING — ⚠️ RUN ONCE, AT FIRST APPLY ONLY ⚠️
-- ──────────────────────────────────────────────────────────────────────────────
-- Every account that exists when the paywall launches becomes 'pro'. Nobody who
-- has the product today wakes up tomorrow behind a wall they cannot pay past —
-- there is no checkout yet. Only accounts created AFTER this runs start free.
--
-- ⚠️ THIS STATEMENT IS NOT IDEMPOTENT IN EFFECT. ⚠️
-- Re-running this file after launch would silently upgrade every free user to
-- pro and hand away the product. Before re-running 0008 for any reason, either
-- delete this UPDATE or bound it with the launch date, e.g.
--     UPDATE users SET plan = 'pro' WHERE created_at < '2026-08-10';
UPDATE users SET plan = 'pro';

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. SESSION_STARTS — the usage ledger
-- ──────────────────────────────────────────────────────────────────────────────
-- No session_id column: the session row does not exist yet at start time, and
-- the two events cannot be joined without deferring the write past the point
-- where the cost is incurred — which is exactly what this table exists to
-- avoid.
CREATE TABLE IF NOT EXISTS session_starts (
  id         bigserial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Serves the quota query directly: WHERE user_id = ? AND started_at > ?
CREATE INDEX IF NOT EXISTS idx_session_starts_user_time
  ON session_starts (user_id, started_at DESC);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. RLS — deny anon, mirroring 0004
-- ──────────────────────────────────────────────────────────────────────────────
-- The backend uses the service_role key which BYPASSES RLS by design. This is
-- defence in depth against a leaked anon key.
ALTER TABLE session_starts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "session_starts_deny_anon" ON session_starts;
CREATE POLICY "session_starts_deny_anon" ON session_starts
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- OPERATOR NOTES
-- ──────────────────────────────────────────────────────────────────────────────
-- Upgrade a user to pro (there is no checkout yet — this is the admin path):
--     UPDATE users SET plan = 'pro' WHERE email = 'someone@example.com';
--
-- Downgrade:
--     UPDATE users SET plan = 'free' WHERE email = 'someone@example.com';
--
-- Inspect a user's current usage against the free cap of 2:
--     SELECT count(*) FROM session_starts
--      WHERE user_id = <id> AND started_at > now() - interval '7 days';
--
-- Plan distribution:
--     SELECT plan, count(*) FROM users GROUP BY plan;
