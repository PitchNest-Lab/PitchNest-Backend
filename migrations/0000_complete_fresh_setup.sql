-- ==============================================================================
-- PitchNest: Complete Database Setup for Fresh Supabase Project
-- ==============================================================================
-- Run this entire script ONCE in your new Supabase project SQL Editor.
-- It creates all required tables, constraints, indexes, functions, storage buckets,
-- and Row-Level Security (RLS) policies with full idempotency.
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  "isEmailVerified" BOOLEAN DEFAULT FALSE,
  "onboardingCompleted" BOOLEAN DEFAULT FALSE,
  role TEXT NOT NULL DEFAULT 'Founder' CHECK (role IN ('Founder', 'Investor', 'Advisor')),
  bio TEXT,
  settings JSONB DEFAULT '{}'::jsonb,
  avatar_url TEXT,
  auth_provider TEXT DEFAULT 'form' CHECK (auth_provider IN ('form', 'google')),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'prep', 'pro', 'founder', 'enterprise')),
  plan_expires_at TIMESTAMPTZ,
  trial_started_at TIMESTAMPTZ DEFAULT NOW(),
  trial_expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  trial_status TEXT DEFAULT 'active',
  "orgCode" TEXT,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  last_active TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_plan_expiry
  ON users (plan_expires_at)
  WHERE plan_expires_at IS NOT NULL;

-- 3. PROFILES TABLE
CREATE TABLE IF NOT EXISTS profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  startup_name TEXT,
  industry TEXT,
  goal TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  funding_stage TEXT
);

-- 4. DECKS TABLE
CREATE TABLE IF NOT EXISTS decks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  size BIGINT,
  status TEXT DEFAULT 'ready',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  extracted_text TEXT,
  page_count INTEGER
);

-- 5. SESSIONS TABLE
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  summary TEXT,
  evaluation_report JSONB,
  video_url TEXT,
  business_name TEXT,
  share_id TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  mode TEXT,
  parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  pitch_config JSONB,
  org_id TEXT,
  visibility TEXT DEFAULT 'private',
  pitch_root_id BIGINT,
  attempt_number INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_pitch_root
  ON sessions (user_id, pitch_root_id);

CREATE INDEX IF NOT EXISTS idx_sessions_pitch_root_only
  ON sessions (pitch_root_id);

-- 6. SESSION_STARTS (Usage Ledger)
CREATE TABLE IF NOT EXISTS session_starts (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_starts_user_time
  ON session_starts (user_id, started_at DESC);

-- 7. SESSION_PDFS TABLE
CREATE TABLE IF NOT EXISTS session_pdfs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE UNIQUE,
  pdf_base64 TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. DECK_AUDITS TABLE
CREATE TABLE IF NOT EXISTS deck_audits (
  id SERIAL PRIMARY KEY,
  deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. PASSWORD_RESETS TABLE
CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. EMAIL_VERIFICATION_TOKENS TABLE
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. PAYMENTS TABLE
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_ref TEXT NOT NULL UNIQUE,
  provider_ref TEXT UNIQUE,
  provider TEXT NOT NULL DEFAULT 'flutterwave',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed')),
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  granted_days INTEGER,
  plan TEXT CHECK (plan IN ('prep', 'pro')),
  term TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_user
  ON payments (user_id, created_at DESC);

-- 12. WAITLIST TABLE
CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  pitch_type TEXT,
  frustration TEXT,
  next_pitch TEXT,
  feedback_opt_in BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. ORGANIZATIONS TABLE
CREATE TABLE IF NOT EXISTS "Organizations" (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  org_code BIGINT UNIQUE,
  org_name TEXT,
  org_users_capacity INTEGER DEFAULT 10,
  org_users_enrolled INTEGER DEFAULT 0,
  validity TIMESTAMPTZ,
  plan TEXT,
  email TEXT UNIQUE,
  password TEXT,
  country TEXT,
  website_url TEXT,
  trial_started_at TIMESTAMPTZ DEFAULT NOW(),
  trial_expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  trial_status TEXT DEFAULT 'active'
);

-- 14. BILLING GRANT FUNCTION
CREATE OR REPLACE FUNCTION grant_pro_access(
  p_tx_ref       TEXT,
  p_provider_ref TEXT,
  p_amount       NUMERIC,
  p_currency     TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_payment        payments;
  v_user           users;
  v_target         TEXT;
  v_days           INTEGER;
  v_rank_target    INTEGER;
  v_rank_current   INTEGER;
  v_new_plan       TEXT;
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

  v_target := COALESCE(v_payment.plan, 'pro');
  v_days   := COALESCE(v_payment.granted_days, 30);

  UPDATE payments
     SET status       = 'successful',
         provider_ref = p_provider_ref,
         amount       = p_amount,
         currency     = p_currency,
         completed_at = NOW()
   WHERE id = v_payment.id;

  SELECT * INTO v_user FROM users WHERE id = v_payment.user_id FOR UPDATE;

  IF v_user.plan = 'pro' AND v_user.plan_expires_at IS NULL THEN
    RETURN TRUE;
  END IF;

  v_rank_target := CASE v_target WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END;
  v_rank_current := CASE
    WHEN v_user.plan_expires_at IS NOT NULL AND v_user.plan_expires_at > NOW()
      THEN CASE v_user.plan WHEN 'pro' THEN 2 WHEN 'prep' THEN 1 ELSE 0 END
    ELSE 0
  END;
  v_new_plan := CASE WHEN v_rank_current > v_rank_target THEN v_user.plan ELSE v_target END;

  UPDATE users
     SET plan            = v_new_plan,
         plan_expires_at  = GREATEST(COALESCE(plan_expires_at, NOW()), NOW())
                              + (v_days || ' days')::interval
   WHERE id = v_user.id;

  RETURN TRUE;
END;
$$;

-- 15. STORAGE BUCKETS (Public avatar, private media)
INSERT INTO storage.buckets (id, name, public)
  VALUES ('pitchnest-avatars', 'pitchnest-avatars', true)
  ON CONFLICT (id) DO UPDATE SET public = true;

INSERT INTO storage.buckets (id, name, public)
  VALUES ('pitchnest-media', 'pitchnest-media', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

-- Storage object policies
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pitchnest_media_deny_anon_read" ON storage.objects;
CREATE POLICY "pitchnest_media_deny_anon_read" ON storage.objects
  FOR SELECT
  TO anon
  USING (bucket_id = 'pitchnest-media' AND false);

DROP POLICY IF EXISTS "pitchnest_avatars_public_read" ON storage.objects;
CREATE POLICY "pitchnest_avatars_public_read" ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'pitchnest-avatars');

-- 16. ROW LEVEL SECURITY (RLS) ON ALL TABLES
-- (Backend connects with service_role key which automatically bypasses RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_deny_anon" ON users;
CREATE POLICY "users_deny_anon" ON users FOR ALL USING (false);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_deny_anon" ON profiles;
CREATE POLICY "profiles_deny_anon" ON profiles FOR ALL USING (false);

ALTER TABLE decks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "decks_deny_anon" ON decks;
CREATE POLICY "decks_deny_anon" ON decks FOR ALL USING (false);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_deny_anon" ON sessions;
CREATE POLICY "sessions_deny_anon" ON sessions FOR ALL USING (false);

ALTER TABLE session_starts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "session_starts_deny_anon" ON session_starts;
CREATE POLICY "session_starts_deny_anon" ON session_starts FOR ALL USING (false);

ALTER TABLE session_pdfs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "session_pdfs_deny_anon" ON session_pdfs;
CREATE POLICY "session_pdfs_deny_anon" ON session_pdfs FOR ALL USING (false);

ALTER TABLE deck_audits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "deck_audits_deny_anon" ON deck_audits;
CREATE POLICY "deck_audits_deny_anon" ON deck_audits FOR ALL USING (false);

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "password_resets_deny_anon" ON password_resets;
CREATE POLICY "password_resets_deny_anon" ON password_resets FOR ALL USING (false);

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "email_verification_tokens_deny_anon" ON email_verification_tokens;
CREATE POLICY "email_verification_tokens_deny_anon" ON email_verification_tokens FOR ALL USING (false);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "payments_deny_anon" ON payments;
CREATE POLICY "payments_deny_anon" ON payments FOR ALL USING (false);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "waitlist_deny_anon" ON waitlist;
CREATE POLICY "waitlist_deny_anon" ON waitlist FOR ALL USING (false);

ALTER TABLE "Organizations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "organizations_deny_anon" ON "Organizations";
CREATE POLICY "organizations_deny_anon" ON "Organizations" FOR ALL USING (false);

-- ==============================================================================
-- PitchNest database initialization complete!
-- ==============================================================================
