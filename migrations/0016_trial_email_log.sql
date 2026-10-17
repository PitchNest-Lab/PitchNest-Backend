-- ─────────────────────────────────────────────────────────────────────────────
-- Trial lifecycle emails: a record of who has already been told what.
--
-- The trial runs for FREE_TRIAL_DAYS (30) and until now it lapsed in complete
-- silence — a founder's PDF access and 40-minute durations simply disappeared on
-- day 31 with nothing said. This table is what makes the replacement emails
-- safe to send.
--
-- WHY A TABLE AND NOT A FLAG ON users
--
-- Two reasons, both about running more than one server process:
--
--  1. At-most-once. The primary key IS the lock. A sweep claims a milestone by
--     inserting the row, and only the insert that succeeds sends the email. Two
--     instances sweeping at the same moment both run, one wins, and nobody gets
--     "your trial ends tomorrow" twice. A boolean column would need a read, a
--     check and a write, and the gap between them is where the duplicate lives.
--
--  2. It stays legible. "Which reminders has this founder seen, and when" is a
--     question support will actually ask, and it can be answered by looking at
--     rows rather than decoding a JSONB bag.
--
-- user_id is INTEGER because users.id is SERIAL in this schema (0000), not a
-- UUID. ON DELETE CASCADE so the account-deletion flow takes this with it.
--
-- Idempotent: safe to run twice.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trial_email_log (
  user_id   INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The reminder point, not a date. 't7' | 't3' | 't1' are the days remaining
  -- when the mail goes out; 'expired' is the one that goes out after the trial
  -- lapses (and is also what stops the three reminders being re-sent by a sweep
  -- that runs while the user is already past their expiry).
  milestone TEXT        NOT NULL CHECK (milestone IN ('t7', 't3', 't1', 'expired')),
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, milestone)
);

-- The sweep never reads this table by index — it claims rows and moves on. This
-- index is for the operator question ("did the job run last night?") rather than
-- for the job itself.
CREATE INDEX IF NOT EXISTS idx_trial_email_log_sent_at
  ON trial_email_log (sent_at DESC);

-- Raw-SQL tables in Supabase do not automatically inherit a deny policy.
-- Reminder state contains user ids and can suppress lifecycle email, so it is
-- service-role-only just like the other backend-owned ledgers.
ALTER TABLE trial_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trial_email_log_deny_direct" ON trial_email_log;
CREATE POLICY "trial_email_log_deny_direct" ON trial_email_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE trial_email_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trial_email_log TO service_role;
