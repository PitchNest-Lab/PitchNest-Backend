-- Migration 0004: Enable Row Level Security (RLS) on all tables.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- The backend uses the service_role key which BYPASSES RLS by design.
-- These policies protect against direct Supabase REST / JS client access
-- with the anon key, which is the primary attack vector if the key leaks.
--
-- NOTE: Since the PitchNest backend is the only writer and it uses the
-- service_role key, these policies are defense-in-depth. They prevent
-- anyone with just the anon key from reading or modifying data.

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. USERS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Deny all access through anon key (service_role bypasses this)
DROP POLICY IF EXISTS "users_deny_anon" ON users;
CREATE POLICY "users_deny_anon" ON users
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. SESSIONS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sessions_deny_anon" ON sessions;
CREATE POLICY "sessions_deny_anon" ON sessions
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. DECKS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE decks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "decks_deny_anon" ON decks;
CREATE POLICY "decks_deny_anon" ON decks
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. PROFILES — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_deny_anon" ON profiles;
CREATE POLICY "profiles_deny_anon" ON profiles
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. PASSWORD_RESETS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_resets_deny_anon" ON password_resets;
CREATE POLICY "password_resets_deny_anon" ON password_resets
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 6. EMAIL_VERIFICATION_TOKENS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_verification_tokens_deny_anon" ON email_verification_tokens;
CREATE POLICY "email_verification_tokens_deny_anon" ON email_verification_tokens
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 7. WAITLIST — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "waitlist_deny_anon" ON waitlist;
CREATE POLICY "waitlist_deny_anon" ON waitlist
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 8. DECK_AUDITS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE deck_audits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deck_audits_deny_anon" ON deck_audits;
CREATE POLICY "deck_audits_deny_anon" ON deck_audits
  FOR ALL
  USING (false);

-- ──────────────────────────────────────────────────────────────────────────────
-- 9. SESSION_PDFS — no public access via anon key
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE session_pdfs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "session_pdfs_deny_anon" ON session_pdfs;
CREATE POLICY "session_pdfs_deny_anon" ON session_pdfs
  FOR ALL
  USING (false);
