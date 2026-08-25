-- Migration 0011: 30-Day Free Access / Trial Period + Pricing Deck Alignment.
--
-- Run once against Supabase. Idempotent — safe to re-run.
--
-- 1. Add trial columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS trial_expires_at timestamptz DEFAULT (now() + interval '30 days'),
  ADD COLUMN IF NOT EXISTS trial_status text DEFAULT 'active';

-- 2. Grant 30-day full access to all existing accounts
UPDATE users
   SET trial_started_at = COALESCE(trial_started_at, now()),
       trial_expires_at = GREATEST(COALESCE(trial_expires_at, now()), now() + interval '30 days'),
       trial_status = 'active'
 WHERE trial_expires_at IS NULL OR trial_expires_at <= now();

-- 3. Update plan constraint if needed
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users
  ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'prep', 'pro', 'founder', 'enterprise'));
