-- Migration 0013: Make the per-pitch attempt counter server-authoritative.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- WHY
-- ──────────────────────────────────────────────────────────────────────────────
-- There is no `pitches` table in this schema. A "pitch" is a CHAIN of `sessions`
-- rows linked by `parent_session_id`: the first attempt is a row with
-- parent_session_id IS NULL, and each re-pitch points at the attempt it followed.
--
-- Counting attempts therefore meant walking that chain, and the only code that
-- did so was the FRONTEND (MyPitchesArchive.computeAttemptInfo). That is
-- advisory only — it cannot enforce a limit, and it re-walks the whole session
-- list on every render. Enforcing "max 5 attempts per pitch" against a walk the
-- client performs is trivially bypassed (refresh, second tab, re-login, edited
-- client state, replaying an old session), so the count has to be one indexed
-- server-side query instead.
--
-- These two DENORMALISED columns make it exactly that:
--   • pitch_root_id   — id of attempt 1 of this chain. A root row stores its OWN
--                       id here, so "all attempts of this pitch" is
--                       WHERE pitch_root_id = <root> — a single indexed lookup
--                       with no recursion at request time.
--   • attempt_number  — 1-based position in the chain, so the UI can render
--                       "3 of 5" without walking anything.
--
-- WHY DENORMALISE INSTEAD OF RECURSING PER REQUEST
-- parent_session_id stays the source of truth (nothing about it changes), but a
-- recursive CTE per session list / per session start is O(chain) round-trips
-- through PostgREST and cannot be indexed. These columns are derivable at any
-- time from parent_session_id (the backfill below is the derivation), so they
-- are a cache, not a second source of truth — if they ever drift, re-running
-- this backfill repairs them.
--
-- WHY NOT NOT-NULL
-- Both columns stay NULLABLE on purpose. Rows written by a server that predates
-- this migration have NULL, and the reader treats NULL as "chain of one, rooted
-- at itself" (see pitchAttemptService.resolveAttemptState). That keeps old rows
-- readable and lets the app deploy in either order.
--
-- NOTHING IS DELETED OR REWRITTEN HERE. No column is dropped, no row is removed,
-- and evaluation_report / video_url / share_id are untouched — pitch retention is
-- a READ-TIME status in this codebase (see PITCH_RETENTION_DAYS), never a
-- destructive job.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS pitch_root_id bigint,
  ADD COLUMN IF NOT EXISTS attempt_number integer;

-- The hot query is "how many attempts exist in this chain for this user", so the
-- index leads with the columns that query filters on.
CREATE INDEX IF NOT EXISTS idx_sessions_pitch_root
  ON sessions (user_id, pitch_root_id);

-- Attempt-limit enforcement reads the chain by root alone when resolving a
-- parent that may belong to an older row set.
CREATE INDEX IF NOT EXISTS idx_sessions_pitch_root_only
  ON sessions (pitch_root_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- BACKFILL — derive both columns from the existing parent_session_id chains.
-- ──────────────────────────────────────────────────────────────────────────────
-- Only touches rows where the value is still NULL, so re-running is a no-op and
-- an already-correct row is never rewritten.
WITH RECURSIVE chain AS (
  -- Attempt 1: no parent, so the chain is rooted at the row itself.
  SELECT id, id AS root_id, 1 AS attempt_no
  FROM sessions
  WHERE parent_session_id IS NULL

  UNION ALL

  -- Each re-pitch inherits its parent's root and sits one position further on.
  SELECT s.id, c.root_id, c.attempt_no + 1
  FROM sessions s
  JOIN chain c ON s.parent_session_id = c.id
)
UPDATE sessions AS s
SET pitch_root_id = c.root_id,
    attempt_number = c.attempt_no
FROM chain c
WHERE s.id = c.id
  AND (s.pitch_root_id IS NULL OR s.attempt_number IS NULL);

-- Safety net for orphans: a row whose parent_session_id points at a session that
-- no longer exists (the parent was deleted) is unreachable from the recursion
-- above and would stay NULL forever. Treat it as its own root — it is the oldest
-- surviving attempt of whatever chain it belonged to, so counting it as attempt 1
-- is both correct for the user and the safe direction (never over-counts a limit).
UPDATE sessions
SET pitch_root_id = id,
    attempt_number = 1
WHERE pitch_root_id IS NULL;
