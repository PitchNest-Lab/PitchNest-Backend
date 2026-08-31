-- Migration 0012: Harden email verification against OTP brute force.
--
-- Run once against Supabase (SQL editor or psql). Idempotent — safe to re-run.
--
-- ──────────────────────────────────────────────────────────────────────────────
-- WHY
-- ──────────────────────────────────────────────────────────────────────────────
-- The old flow stored ONE 6-digit value (generated with Math.random) that served
-- as BOTH the email link token AND the manual code, and verifyEmail looked it up
-- GLOBALLY (.eq("token", token)) with only a per-IP rate limit. That is
-- brute-forceable: ~10^6 space, no per-account attempt lockout, and the window is
-- refreshable via the public resend endpoint — so a stolen code yields a session
-- JWT for an account the attacker does not own.
--
-- The hardened flow splits the two factors:
--   • token   — a long, high-entropy value (crypto.randomBytes) used ONLY in the
--               emailed LINK. A global lookup on it is safe (unguessable).
--   • code    — a cryptographically-random 6-digit value for MANUAL entry, only
--               ever checked SCOPED to the account (verifyEmailOtp) with a
--               per-record attempt counter that invalidates after 5 tries.
-- These two columns support that. The app has rollout-safety fallbacks so signup
-- keeps working before this migration runs (link-only verification until then).

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
