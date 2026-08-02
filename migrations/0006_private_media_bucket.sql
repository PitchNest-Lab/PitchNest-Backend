-- Migration 0006: Make the pitch-media storage bucket PRIVATE; move avatars to
-- a separate PUBLIC bucket (Item A).
--
-- Run once against Supabase (SQL editor or psql). Some steps are dashboard/CLI
-- actions, called out inline. Idempotent where written as SQL.
--
-- WHY: decks and pitch videos were stored in a PUBLIC bucket, so anyone with a
-- URL (or who could guess/enumerate a path) could read another founder's deck
-- or recorded pitch. Bucket-level public access is NOT covered by the table RLS
-- in migration 0004 — Storage objects have their own access model.
--
-- DECISION (Item A): decks + videos move to a fully PRIVATE bucket and are read
-- via short-lived signed URLs. Avatars are low-sensitivity, rendered unsigned as
-- <img> on every page, so they move to a SEPARATE PUBLIC bucket instead of being
-- signed. This keeps the main bucket fully private with zero avatar-rendering
-- changes on the frontend.
--
-- WHAT THE CODE ALREADY DOES (deploy the app BEFORE running this):
--   • Deck/video uploads store the BARE object path (e.g. "decks/171_x.pdf"),
--     never a public URL. (deckController.ts, uploadController.ts)
--   • Decks render via signed URLs from GET /api/decks/:id/signed-url (owner-
--     checked). Signed URLs work on a public OR private bucket, so deploying the
--     code first is safe and causes no downtime.
--   • Videos are write-only (never replayed), so a private bucket alone protects
--     them.
--   • Avatars now upload to config.avatarBucket ("pitchnest-avatars") and keep
--     using getPublicUrl. (uploadController.ts)
--   • Account deletion removes deck/video objects from the media bucket and the
--     avatar object from the avatar bucket, deriving paths from bare paths OR
--     legacy full URLs (storagePath.ts) — NO DECK/VIDEO BACKFILL REQUIRED.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 1 (DASHBOARD or CLI, do FIRST): create the public avatar bucket.
--   Dashboard: Storage → New bucket → name "pitchnest-avatars" → Public: ON.
--   Or SQL:
INSERT INTO storage.buckets (id, name, public)
  VALUES ('pitchnest-avatars', 'pitchnest-avatars', true)
  ON CONFLICT (id) DO UPDATE SET public = true;

-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 2 (OPTIONAL BACKFILL): migrate EXISTING avatars out of the media bucket.
-- Existing avatar_url values point at pitchnest-media/avatars/... Once STEP 3
-- makes that bucket private, those <img> links stop resolving. Options:
--   (a) Simplest: have users re-upload a profile picture (avatars are cosmetic).
--   (b) Copy objects media/avatars/* → pitchnest-avatars/avatars/* (Storage API
--       or `supabase storage cp`), then UPDATE users.avatar_url to swap the
--       bucket segment:
--         UPDATE users
--           SET avatar_url = REPLACE(avatar_url,
--                 '/pitchnest-media/avatars/',
--                 '/pitchnest-avatars/avatars/')
--           WHERE avatar_url LIKE '%/pitchnest-media/avatars/%';
-- Decks/videos need NO backfill — they are read via signed URLs / are write-only.

-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 3 (do AFTER the app is deployed): flip the media bucket to private.
UPDATE storage.buckets
  SET public = false
  WHERE id = 'pitchnest-media';

-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 4: defense-in-depth object policies. The backend uses the service_role
-- key, which BYPASSES these — they deny anon/authenticated DIRECT access if the
-- anon key leaks. Signed URLs are validated by Storage and are unaffected.
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Deny anon reads of the private media bucket (decks + pitch videos).
DROP POLICY IF EXISTS "pitchnest_media_deny_anon_read" ON storage.objects;
CREATE POLICY "pitchnest_media_deny_anon_read" ON storage.objects
  FOR SELECT
  TO anon
  USING (bucket_id = 'pitchnest-media' AND false);

-- Allow public read of the avatar bucket (it is a public bucket by design).
DROP POLICY IF EXISTS "pitchnest_avatars_public_read" ON storage.objects;
CREATE POLICY "pitchnest_avatars_public_read" ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'pitchnest-avatars');

-- ──────────────────────────────────────────────────────────────────────────────
-- DEPLOY ORDER (do not reorder):
--   2. Deploy backend + frontend (this commit).
--   3. STEP 1 (create avatar bucket) — can also be done before deploy.
--   4. STEP 2 backfill (optional) if you want existing avatars preserved.
--   5. STEP 3 (flip media bucket private) + STEP 4 (policies).
--   6. Smoke-test: upload a NEW deck + start a pitch (deck renders via signed
--      URL); open an existing deck's Preview; upload a new avatar (loads
--      unsigned); delete a throwaway account and confirm its deck/video objects
--      are gone from pitchnest-media and its avatar from pitchnest-avatars.
--
-- ENV: set SUPABASE_AVATAR_BUCKET if you name the bucket something other than
-- "pitchnest-avatars" (defaults to that).
