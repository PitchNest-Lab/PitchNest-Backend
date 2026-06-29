-- Migration 0002: add `bio` to the users table.
--
-- Run once against Supabase (SQL editor or psql). Idempotent. `bio` is an
-- optional free-text founder/profile blurb edited from Settings → Profile.
-- name and email already exist on the table; only bio is new.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS bio text;
