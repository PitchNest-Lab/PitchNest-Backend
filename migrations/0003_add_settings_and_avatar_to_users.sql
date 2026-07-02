-- Migration 0003: add `settings` and `avatar_url` to the users table.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
-- There is no migration runner in this repo yet, so migrations live here as
-- numbered SQL files and are applied manually (same convention as 0001/0002 and
-- the password_resets / email_verification_tokens tables).
--
--   * settings   — JSONB bag of user app preferences (notification toggles, AI
--                  "toughness", default sector). Persisted by PATCH /api/auth/settings.
--                  New/existing rows default to an empty object.
--   * avatar_url — public URL of the user's uploaded profile image in Supabase
--                  Storage. Set by POST /api/upload-avatar. Nullable (falls back
--                  to a generated avatar in the UI when null).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text;
