-- PitchNest-hosted challenges (pitch competitions PitchNest runs itself), their
-- entries, verification, judging and winners; and percentage discount codes
-- for checkout.
-- Depends on 0024 (opportunities), 0029 (latest list_user_notifications) and
-- 0036 (payments.billing_mode). Independent of 0037.
--
-- Design notes
--   * A challenge appears in the Opportunities hub next to the curated
--     external listings (0024), but lives in its own table: it takes entries,
--     verifies them and picks winners, which an external listing never does.
--   * One challenge_participants row per founder per challenge IS their entry.
--     The unique keys make a second entry, a second prize for one founder, two
--     winners in one place, or one business entered twice impossible.
--   * Nobody enters a score. refresh_challenge_scores reads the founder's own
--     sessions (written only by the live-pitch server) inside the challenge
--     window and freezes the result once the deadline has passed.
--   * A discount code prices a ONE-TIME (manual renewal) checkout only, so a
--     discounted amount can never become a recurring Flutterwave plan price.
--     The discounted amount is the payment row's amount, so grant_pro_access
--     settles it like any other payment; a trigger on payments keeps the
--     redemption in step with the payment's outcome.
--   * Every table denies anon/authenticated; functions run for service_role only.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Discount codes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  percent_off INTEGER NOT NULL,
  plans TEXT[] NOT NULL DEFAULT ARRAY['pro'],
  terms TEXT[] NOT NULL DEFAULT ARRAY['monthly'],
  -- How many of one founder's checkouts the code may discount (1 = the first period only).
  periods INTEGER NOT NULL DEFAULT 1,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  max_redemptions INTEGER,
  new_customers_only BOOLEAN NOT NULL DEFAULT FALSE,
  -- Whether the first-subscription free months still apply on top.
  combine_with_offer BOOLEAN NOT NULL DEFAULT FALSE,
  -- Off until an admin has tested and activated it.
  active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discount_codes_code_format CHECK (code ~ '^[A-Z0-9]{4,32}$'),
  CONSTRAINT discount_codes_description_length CHECK (description IS NULL OR char_length(description) <= 300),
  CONSTRAINT discount_codes_percent_range CHECK (percent_off BETWEEN 1 AND 90),
  CONSTRAINT discount_codes_plans_values CHECK (cardinality(plans) >= 1 AND plans <@ ARRAY['prep', 'pro']::TEXT[]),
  CONSTRAINT discount_codes_terms_values CHECK (cardinality(terms) >= 1 AND terms <@ ARRAY['monthly', 'annual']::TEXT[]),
  CONSTRAINT discount_codes_periods_range CHECK (periods BETWEEN 1 AND 12),
  CONSTRAINT discount_codes_window CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CONSTRAINT discount_codes_max_positive CHECK (max_redemptions IS NULL OR max_redemptions > 0)
);

-- One row per discounted checkout. Pending until its payment settles.
CREATE TABLE IF NOT EXISTS discount_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_ref TEXT NOT NULL UNIQUE REFERENCES payments(tx_ref) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  list_amount NUMERIC(12, 2) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CONSTRAINT discount_redemptions_status_values CHECK (status IN ('pending', 'redeemed', 'released')),
  CONSTRAINT discount_redemptions_amounts CHECK (amount > 0 AND list_amount >= amount),
  CONSTRAINT discount_redemptions_currency_format CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code_status
  ON discount_redemptions (discount_code_id, status);
CREATE INDEX IF NOT EXISTS idx_discount_redemptions_user_code
  ON discount_redemptions (user_id, discount_code_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Challenges
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  organizer TEXT NOT NULL DEFAULT 'PitchNest',
  tagline TEXT NOT NULL,
  description TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'Online',
  -- The challenge image (poster), uploaded by staff, shown uncropped.
  banner_file TEXT,
  -- Whether the app shows the challenge as a pop-up while it is upcoming or open.
  promo_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  website_url TEXT,
  prize_currency TEXT NOT NULL DEFAULT 'NGN',
  -- [{"place": 1, "amount": 100000}, ...]; the pool is their sum.
  prizes JSONB NOT NULL DEFAULT '[]'::jsonb,
  starts_at TIMESTAMPTZ NOT NULL,
  submission_deadline TIMESTAMPTZ NOT NULL,
  winners_announced_on DATE,
  eligibility TEXT,
  requirements TEXT,
  judging_criteria TEXT,
  terms TEXT,
  -- Share of the final score from the pitch; the business profile has the rest.
  pitch_weight INTEGER NOT NULL DEFAULT 60,
  eligible_session_modes TEXT[] NOT NULL DEFAULT ARRAY['solo', 'panel'],
  min_completed_sessions INTEGER NOT NULL DEFAULT 1,
  -- The paid plan an entrant must hold (NULL: none).
  required_plan TEXT DEFAULT 'pro',
  -- {"instagram": {"handle": "@x", "url": "https://..."}, "facebook": ..., "x": ...}
  social_handles JSONB NOT NULL DEFAULT '{}'::jsonb,
  discount_code_id UUID REFERENCES discount_codes(id) ON DELETE SET NULL,
  -- {"prizes": {"by": 1, "at": "...", "hash": "..."}, ...}: an admin's sign-off
  -- of each part of the rules, tied to the values it covered.
  confirmations JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  results_published_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT challenges_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(slug) <= 80),
  CONSTRAINT challenges_title_length CHECK (char_length(title) BETWEEN 5 AND 140),
  CONSTRAINT challenges_organizer_length CHECK (char_length(organizer) BETWEEN 2 AND 120),
  CONSTRAINT challenges_tagline_length CHECK (char_length(tagline) BETWEEN 10 AND 300),
  CONSTRAINT challenges_description_length CHECK (char_length(description) BETWEEN 10 AND 5000),
  CONSTRAINT challenges_region_length CHECK (char_length(region) <= 120),
  CONSTRAINT challenges_banner_file_format CHECK (banner_file IS NULL OR banner_file ~ '^banner-[a-f0-9]{32}\.webp$'),
  CONSTRAINT challenges_website_url_format CHECK (
    website_url IS NULL OR (website_url ~* '^https?://[^\s]+$' AND char_length(website_url) <= 500)
  ),
  CONSTRAINT challenges_prize_currency_format CHECK (prize_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT challenges_prizes_array CHECK (jsonb_typeof(prizes) = 'array' AND jsonb_array_length(prizes) <= 10),
  CONSTRAINT challenges_window CHECK (starts_at < submission_deadline),
  CONSTRAINT challenges_text_lengths CHECK (
    (eligibility IS NULL OR char_length(eligibility) <= 3000)
    AND (requirements IS NULL OR char_length(requirements) <= 5000)
    AND (judging_criteria IS NULL OR char_length(judging_criteria) <= 3000)
    AND (terms IS NULL OR char_length(terms) <= 15000)
  ),
  CONSTRAINT challenges_pitch_weight_range CHECK (pitch_weight BETWEEN 0 AND 100),
  CONSTRAINT challenges_modes_values CHECK (
    cardinality(eligible_session_modes) >= 1 AND eligible_session_modes <@ ARRAY['solo', 'coach', 'panel']::TEXT[]
  ),
  CONSTRAINT challenges_min_sessions_range CHECK (min_completed_sessions BETWEEN 1 AND 20),
  CONSTRAINT challenges_required_plan_values CHECK (required_plan IS NULL OR required_plan IN ('prep', 'pro')),
  CONSTRAINT challenges_social_object CHECK (jsonb_typeof(social_handles) = 'object'),
  CONSTRAINT challenges_confirmations_object CHECK (jsonb_typeof(confirmations) = 'object'),
  CONSTRAINT challenges_status_values CHECK (
    status IN ('draft', 'published', 'open', 'closed', 'judging', 'completed', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS idx_challenges_listed
  ON challenges (submission_deadline DESC)
  WHERE status <> 'draft';

-- ─────────────────────────────────────────────────────────────────────────────
-- Entries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS challenge_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in_progress',
  -- The Discover profile entered.
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  -- Best verified score, from refresh_challenge_scores only.
  best_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  best_score INTEGER,
  best_score_at TIMESTAMPTZ,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  score_checked_at TIMESTAMPTZ,
  score_frozen_at TIMESTAMPTZ,
  -- First time a paid plan backed by a settled payment was seen.
  subscription_verified_at TIMESTAMPTZ,
  subscription_tx_ref TEXT,
  -- First time every automatic requirement passed.
  eligible_at TIMESTAMPTZ,
  social_platform TEXT,
  social_post_url TEXT,
  evidence_file TEXT,
  profile_link_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  -- Whether the founder's own name may appear with a public result.
  public_name_consent BOOLEAN NOT NULL DEFAULT FALSE,
  rules_accepted_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  -- Verification (staff).
  review_note TEXT,
  social_checks JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  -- Judging (staff). profile_scores: {"completeness": 0-10, "problem": ..., ...}
  profile_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  pitch_score_valid BOOLEAN NOT NULL DEFAULT TRUE,
  judge_notes TEXT,
  shortlisted BOOLEAN NOT NULL DEFAULT FALSE,
  judged_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  judged_at TIMESTAMPTZ,
  placement INTEGER,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT challenge_participants_one_entry UNIQUE (challenge_id, user_id),
  CONSTRAINT challenge_participants_status_values CHECK (
    status IN ('in_progress', 'submitted', 'needs_correction', 'approved', 'rejected', 'disqualified')
  ),
  CONSTRAINT challenge_participants_best_score_range CHECK (best_score IS NULL OR best_score BETWEEN 0 AND 100),
  CONSTRAINT challenge_participants_sessions_nonnegative CHECK (completed_sessions >= 0),
  CONSTRAINT challenge_participants_platform_values CHECK (
    social_platform IS NULL OR social_platform IN ('instagram', 'facebook', 'x')
  ),
  CONSTRAINT challenge_participants_post_url_format CHECK (
    social_post_url IS NULL OR (social_post_url ~ '^https://[^\s]+$' AND char_length(social_post_url) <= 500)
  ),
  CONSTRAINT challenge_participants_evidence_file_format CHECK (
    evidence_file IS NULL OR evidence_file ~ '^evidence-[a-f0-9]{32}\.webp$'
  ),
  CONSTRAINT challenge_participants_review_note_length CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  CONSTRAINT challenge_participants_judge_notes_length CHECK (judge_notes IS NULL OR char_length(judge_notes) <= 3000),
  CONSTRAINT challenge_participants_social_checks_object CHECK (jsonb_typeof(social_checks) = 'object'),
  CONSTRAINT challenge_participants_profile_scores_object CHECK (jsonb_typeof(profile_scores) = 'object'),
  CONSTRAINT challenge_participants_placement_range CHECK (placement IS NULL OR placement BETWEEN 1 AND 10),
  CONSTRAINT challenge_participants_placement_approved CHECK (placement IS NULL OR status = 'approved')
);

-- One winner per place, one entry per business.
CREATE UNIQUE INDEX IF NOT EXISTS challenge_participants_one_per_place
  ON challenge_participants (challenge_id, placement)
  WHERE placement IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS challenge_participants_one_per_business
  ON challenge_participants (challenge_id, business_id)
  WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user
  ON challenge_participants (user_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_status
  ON challenge_participants (challenge_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit trail of staff decisions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  challenge_id UUID REFERENCES challenges(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_audit_log_action_length CHECK (char_length(action) BETWEEN 3 AND 80),
  CONSTRAINT admin_audit_log_subject_values CHECK (
    subject_type IN ('challenge', 'challenge_participant', 'discount_code')
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_challenge
  ON admin_audit_log (challenge_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_subject
  ON admin_audit_log (subject_type, subject_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verified scores
-- ─────────────────────────────────────────────────────────────────────────────

-- A category score from a report as a number 0-100, or NULL for anything else.
CREATE OR REPLACE FUNCTION challenge_score_number(p_value JSONB)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_value) = 'number'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 100
      THEN (p_value #>> '{}')::NUMERIC
    WHEN jsonb_typeof(p_value) = 'string'
      AND (p_value #>> '{}') ~ '^\d{1,3}(\.\d+)?$'
      AND (p_value #>> '{}')::NUMERIC BETWEEN 0 AND 100
      THEN (p_value #>> '{}')::NUMERIC
    ELSE NULL
  END;
$$;

-- Recomputes each entry's best score and completed-session count from the
-- founder's own sessions. A session counts when it was saved inside the
-- challenge window, in an eligible mode, with a complete evaluation and four
-- valid category scores. The score is the report's overall score (the mean of
-- the four, rounded, as computeOverallScore does). Ties go to the earliest.
-- After the deadline the first refresh freezes the entry, keeping the higher of
-- the stored and recomputed best, so a later deletion cannot lower it.
CREATE OR REPLACE FUNCTION refresh_challenge_scores(
  p_challenge_id UUID,
  p_participant_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge challenges;
  v_now TIMESTAMPTZ := NOW();
  v_after_deadline BOOLEAN;
  v_updated INTEGER;
BEGIN
  SELECT * INTO v_challenge FROM challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_after_deadline := v_now > v_challenge.submission_deadline;

  WITH targets AS (
    SELECT entry.id, entry.user_id
    FROM challenge_participants AS entry
    WHERE entry.challenge_id = p_challenge_id
      AND entry.score_frozen_at IS NULL
      AND (p_participant_id IS NULL OR entry.id = p_participant_id)
  ),
  scored AS (
    SELECT
      target.id AS participant_id,
      session.id AS session_id,
      session.created_at AS scored_at,
      ROUND((part.d + part.c + part.s + part.r) / 4)::INTEGER AS score
    FROM targets AS target
    INNER JOIN sessions AS session ON session.user_id = target.user_id
    CROSS JOIN LATERAL (
      SELECT
        challenge_score_number(session.evaluation_report -> 'scores' -> 'delivery') AS d,
        challenge_score_number(session.evaluation_report -> 'scores' -> 'clarity') AS c,
        challenge_score_number(session.evaluation_report -> 'scores' -> 'scalability') AS s,
        challenge_score_number(session.evaluation_report -> 'scores' -> 'readiness') AS r
    ) AS part
    WHERE session.created_at >= v_challenge.starts_at
      AND session.created_at <= v_challenge.submission_deadline
      AND jsonb_typeof(session.evaluation_report) = 'object'
      AND session.evaluation_report ->> 'evaluationStatus' = 'complete'
      AND COALESCE(NULLIF(session.mode, ''), session.evaluation_report ->> 'mode')
          = ANY (v_challenge.eligible_session_modes)
      AND part.d IS NOT NULL AND part.c IS NOT NULL AND part.s IS NOT NULL AND part.r IS NOT NULL
      AND part.d + part.c + part.s + part.r > 0
  ),
  best AS (
    SELECT DISTINCT ON (participant_id) participant_id, session_id, scored_at, score
    FROM scored
    ORDER BY participant_id, score DESC, scored_at ASC, session_id ASC
  ),
  counts AS (
    SELECT participant_id, COUNT(*)::INTEGER AS completed
    FROM scored
    GROUP BY participant_id
  ),
  calc AS (
    SELECT
      target.id,
      best.session_id,
      best.scored_at,
      best.score,
      COALESCE(counts.completed, 0) AS completed
    FROM targets AS target
    LEFT JOIN best ON best.participant_id = target.id
    LEFT JOIN counts ON counts.participant_id = target.id
  )
  UPDATE challenge_participants AS entry
  SET
    best_score = CASE
      WHEN v_after_deadline AND entry.best_score IS NOT NULL
        AND (calc.score IS NULL OR entry.best_score > calc.score) THEN entry.best_score
      ELSE calc.score
    END,
    best_session_id = CASE
      WHEN v_after_deadline AND entry.best_score IS NOT NULL
        AND (calc.score IS NULL OR entry.best_score > calc.score) THEN entry.best_session_id
      ELSE calc.session_id
    END,
    best_score_at = CASE
      WHEN v_after_deadline AND entry.best_score IS NOT NULL
        AND (calc.score IS NULL OR entry.best_score > calc.score) THEN entry.best_score_at
      ELSE calc.scored_at
    END,
    completed_sessions = CASE
      WHEN v_after_deadline THEN GREATEST(entry.completed_sessions, calc.completed)
      ELSE calc.completed
    END,
    score_checked_at = v_now,
    score_frozen_at = CASE WHEN v_after_deadline THEN v_now ELSE NULL END,
    updated_at = v_now
  FROM calc
  WHERE entry.id = calc.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Winners
-- ─────────────────────────────────────────────────────────────────────────────

-- Replaces a challenge's placements in one transaction. Each place must be a
-- prize place, used once; each winner must be a distinct approved entry.
CREATE OR REPLACE FUNCTION set_challenge_placements(
  p_challenge_id UUID,
  p_actor_id INTEGER,
  p_placements JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_challenge challenges;
  v_places INTEGER;
  v_item JSONB;
  v_participant UUID;
  v_place INTEGER;
  v_seen_places INTEGER[] := ARRAY[]::INTEGER[];
  v_seen_participants UUID[] := ARRAY[]::UUID[];
  v_set INTEGER := 0;
BEGIN
  SELECT * INTO v_challenge FROM challenges WHERE id = p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHALLENGE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_challenge.results_published_at IS NOT NULL THEN
    RAISE EXCEPTION 'RESULTS_ALREADY_PUBLISHED' USING ERRCODE = '23514';
  END IF;
  IF p_placements IS NULL OR jsonb_typeof(p_placements) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PLACEMENTS' USING ERRCODE = '22023';
  END IF;
  v_places := jsonb_array_length(v_challenge.prizes);

  UPDATE challenge_participants
     SET placement = NULL, updated_at = NOW()
   WHERE challenge_id = p_challenge_id AND placement IS NOT NULL;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_placements) LOOP
    IF jsonb_typeof(v_item) <> 'object'
      OR COALESCE(v_item ->> 'participantId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR COALESCE(v_item ->> 'place', '') !~ '^\d{1,2}$' THEN
      RAISE EXCEPTION 'INVALID_PLACEMENTS' USING ERRCODE = '22023';
    END IF;
    v_participant := (v_item ->> 'participantId')::UUID;
    v_place := (v_item ->> 'place')::INTEGER;
    IF v_place < 1 OR v_place > v_places THEN
      RAISE EXCEPTION 'INVALID_PLACE' USING ERRCODE = '22023';
    END IF;
    IF v_place = ANY (v_seen_places) THEN
      RAISE EXCEPTION 'DUPLICATE_PLACE' USING ERRCODE = '23505';
    END IF;
    IF v_participant = ANY (v_seen_participants) THEN
      RAISE EXCEPTION 'DUPLICATE_WINNER' USING ERRCODE = '23505';
    END IF;

    UPDATE challenge_participants
       SET placement = v_place, updated_at = NOW()
     WHERE id = v_participant
       AND challenge_id = p_challenge_id
       AND status = 'approved';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'WINNER_NOT_ELIGIBLE' USING ERRCODE = '23514';
    END IF;

    v_seen_places := v_seen_places || v_place;
    v_seen_participants := v_seen_participants || v_participant;
    v_set := v_set + 1;
  END LOOP;

  INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, challenge_id, metadata)
  VALUES (
    p_actor_id, 'challenge.placements_set', 'challenge', p_challenge_id::TEXT, p_challenge_id,
    jsonb_build_object('placements', p_placements)
  );
  RETURN v_set;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Discount redemption
-- ─────────────────────────────────────────────────────────────────────────────

-- Called by checkout right after it records the pending payment. Re-checks the
-- code under a row lock, so the usage limits hold when founders check out at
-- the same moment, and records the pending redemption. Returns 'reserved' or
-- the reason the code does not apply.
CREATE OR REPLACE FUNCTION reserve_discount_redemption(
  p_code_id UUID,
  p_user_id INTEGER,
  p_tx_ref TEXT,
  p_list_amount NUMERIC,
  p_amount NUMERIC,
  p_currency TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code discount_codes;
  v_payment payments;
  v_mine INTEGER;
  v_used INTEGER;
BEGIN
  SELECT * INTO v_code FROM discount_codes WHERE id = p_code_id FOR UPDATE;
  IF NOT FOUND OR NOT v_code.active THEN
    RETURN 'inactive';
  END IF;
  IF v_code.starts_at IS NOT NULL AND NOW() < v_code.starts_at THEN
    RETURN 'not_started';
  END IF;
  IF v_code.ends_at IS NOT NULL AND NOW() >= v_code.ends_at THEN
    RETURN 'expired';
  END IF;

  SELECT * INTO v_payment FROM payments WHERE tx_ref = p_tx_ref;
  IF NOT FOUND
    OR v_payment.user_id <> p_user_id
    OR v_payment.status <> 'pending'
    OR v_payment.kind <> 'subscription_initial'
    OR v_payment.amount <> p_amount
    OR UPPER(v_payment.currency) <> UPPER(p_currency) THEN
    RAISE EXCEPTION 'DISCOUNT_PAYMENT_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_payment.billing_mode <> 'manual' THEN
    RETURN 'manual_only';
  END IF;
  IF NOT (v_payment.plan = ANY (v_code.plans)) OR NOT (v_payment.term = ANY (v_code.terms)) THEN
    RETURN 'not_applicable';
  END IF;
  IF p_list_amount IS NULL OR p_amount <= 0
    OR p_amount <> ROUND(p_list_amount * (100 - v_code.percent_off) / 100.0, 2) THEN
    RAISE EXCEPTION 'INVALID_DISCOUNT_AMOUNT' USING ERRCODE = '22023';
  END IF;
  IF v_code.new_customers_only AND EXISTS (
    SELECT 1 FROM payments WHERE user_id = p_user_id AND status = 'successful'
  ) THEN
    RETURN 'new_customers_only';
  END IF;

  -- A founder's own earlier, unfinished checkout with this code gives way.
  UPDATE discount_redemptions
     SET status = 'released', released_at = NOW()
   WHERE discount_code_id = p_code_id AND user_id = p_user_id AND status = 'pending';

  SELECT COUNT(*) INTO v_mine
    FROM discount_redemptions
   WHERE discount_code_id = p_code_id AND user_id = p_user_id AND status = 'redeemed';
  IF v_mine >= v_code.periods THEN
    RETURN 'already_used';
  END IF;

  IF v_code.max_redemptions IS NOT NULL THEN
    -- Abandoned checkouts stop holding a place after two hours.
    SELECT COUNT(*) INTO v_used
      FROM discount_redemptions
     WHERE discount_code_id = p_code_id
       AND (status = 'redeemed' OR (status = 'pending' AND created_at > NOW() - INTERVAL '2 hours'));
    IF v_used >= v_code.max_redemptions THEN
      RETURN 'exhausted';
    END IF;
  END IF;

  INSERT INTO discount_redemptions (discount_code_id, user_id, tx_ref, list_amount, amount, currency)
  VALUES (p_code_id, p_user_id, p_tx_ref, p_list_amount, p_amount, UPPER(p_currency));
  RETURN 'reserved';
END;
$$;

-- A redemption follows its payment: settled → redeemed, failed → released.
-- Runs inside grant_pro_access and markPaymentFailed alike, so every path that
-- settles a payment also settles its redemption.
CREATE OR REPLACE FUNCTION sync_discount_redemption()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'successful' THEN
      UPDATE discount_redemptions
         SET status = 'redeemed', redeemed_at = NOW(), released_at = NULL
       WHERE tx_ref = NEW.tx_ref AND status <> 'redeemed';
    ELSIF NEW.status = 'failed' THEN
      UPDATE discount_redemptions
         SET status = 'released', released_at = NOW()
       WHERE tx_ref = NEW.tx_ref AND status = 'pending';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payments_sync_discount_redemption ON payments;
CREATE TRIGGER payments_sync_discount_redemption
  AFTER UPDATE OF status ON payments
  FOR EACH ROW
  EXECUTE FUNCTION sync_discount_redemption();

-- ─────────────────────────────────────────────────────────────────────────────
-- Notifications about a founder's own entry
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_values;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_values
  CHECK (type IN (
    'business_comment', 'business_update', 'community_reply',
    'founder_update', 'founder_business',
    'challenge_joined', 'challenge_eligible', 'challenge_submitted',
    'challenge_correction', 'challenge_approved', 'challenge_rejected',
    'challenge_results'
  ));

-- 0029's function plus challenge rows (entity_id = the challenge). The return
-- shape gains challenge columns, so drop and recreate.
DROP FUNCTION IF EXISTS list_user_notifications(INTEGER, INTEGER);
CREATE FUNCTION list_user_notifications(
  p_user_id INTEGER,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  notification_id UUID,
  type TEXT,
  created_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  business_id UUID,
  business_name TEXT,
  business_slug TEXT,
  business_status TEXT,
  thread_id UUID,
  thread_title TEXT,
  excerpt TEXT,
  comment_category TEXT,
  founder_name TEXT,
  founder_handle TEXT,
  challenge_title TEXT,
  challenge_slug TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    note.id,
    note.type,
    note.created_at,
    note.read_at,
    business.id,
    business.name,
    business.slug,
    business.status,
    thread.id,
    thread.title,
    LEFT(COALESCE(
      comment.body,
      business_update.body,
      reply.body,
      CASE WHEN note.type = 'founder_business' THEN business.tagline END,
      CASE WHEN note.type IN ('challenge_correction', 'challenge_rejected') THEN entry.review_note END
    ), 140),
    comment.category,
    founder.name,
    founder_handle.handle,
    challenge.title,
    challenge.slug
  FROM notifications AS note
  LEFT JOIN businesses AS business ON business.id = note.business_id
  LEFT JOIN business_comments AS comment
    ON note.type = 'business_comment' AND comment.id = note.entity_id
  LEFT JOIN business_updates AS business_update
    ON note.type IN ('business_update', 'founder_update') AND business_update.id = note.entity_id
  LEFT JOIN community_replies AS reply
    ON note.type = 'community_reply' AND reply.id = note.entity_id
  LEFT JOIN community_threads AS thread
    ON thread.id = reply.thread_id
  LEFT JOIN users AS founder ON founder.id = note.actor_id
  LEFT JOIN founder_handles AS founder_handle ON founder_handle.user_id = note.actor_id
  LEFT JOIN challenges AS challenge
    ON starts_with(note.type, 'challenge_') AND challenge.id = note.entity_id
  LEFT JOIN challenge_participants AS entry
    ON entry.challenge_id = challenge.id AND entry.user_id = note.user_id
  WHERE note.user_id = p_user_id
    AND (
      (note.type = 'business_comment' AND comment.status = 'visible'
        AND business.status IS DISTINCT FROM 'removed')
      OR (note.type = 'business_update' AND business_update.status = 'visible'
        AND business.status = 'published')
      OR (note.type = 'community_reply' AND reply.status = 'visible'
        AND thread.status = 'visible')
      OR (note.type = 'founder_update' AND business_update.status = 'visible'
        AND founder_shown_on_business(note.actor_id, note.business_id))
      OR (note.type = 'founder_business'
        AND founder_shown_on_business(note.actor_id, note.business_id))
      OR (starts_with(note.type, 'challenge_') AND challenge.status <> 'draft')
    )
  ORDER BY note.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The first challenge and its code, as drafts. Nothing here is public or
-- usable until an admin confirms the rules, publishes the challenge and
-- activates the code. The dates, prizes, handles and texts are proposals.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO discount_codes (code, description, percent_off, plans, terms, periods, active)
VALUES (
  'PCHU01',
  'PitchNest Challenge: 50% off the first month of Pro Founder',
  50, ARRAY['pro'], ARRAY['monthly'], 1, FALSE
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO challenges (
  slug, title, organizer, tagline, description, region, website_url,
  prize_currency, prizes, starts_at, submission_deadline, winners_announced_on,
  eligibility, requirements, judging_criteria, terms,
  pitch_weight, eligible_session_modes, min_completed_sessions, required_plan,
  social_handles, discount_code_id, status
)
SELECT
  'pitchnest-challenge',
  'PitchNest Challenge',
  'PitchNest',
  'Practice. Pitch. Showcase. Win!',
  E'The PitchNest Challenge gives startup founders an opportunity to strengthen their pitching skills, showcase their businesses, and compete for cash prizes.\n\nPractice with AI investors, improve your pitch readiness score, publish your business on PitchNest Discover, and share your progress.',
  'Online · open to founders everywhere',
  'https://www.pitchnest.app',
  'NGN',
  '[{"place": 1, "amount": 100000}, {"place": 2, "amount": 60000}, {"place": 3, "amount": 40000}]'::jsonb,
  '2026-11-06T00:00:00+01:00',
  '2026-11-18T23:59:00+01:00',
  '2026-11-21',
  E'Open to startup founders everywhere. You do not need to be part of Akwa Ibom Tech Week or any other programme.\n- You must be 18 or older.\n- You enter with a business you own or manage (owner or admin) on PitchNest Discover.\n- One entry per founder, and each business can be entered once.\n- You need an active, paid Pro Founder plan during the challenge.',
  E'Keep your social media post public until the winners are announced.\nOnly sessions that finish before the submission deadline count.',
  E'Entries that meet every requirement are judged on two parts:\n- Pitch performance (60%): your highest verified readiness score from a complete AI investor session during the challenge, taken from PitchNest''s own report. Screenshots are supporting evidence only.\n- Business profile (40%): how complete and clear your Discover profile is: the problem, the solution, the target market, the business model, and your traction or supporting information.\nThe highest combined scores win, after verification.',
  E'1. Organiser. The PitchNest Challenge is run by PitchNest (www.pitchnest.app).\n2. Entry period. Entries are accepted from the start date to the submission deadline shown on the challenge page, in West Africa Time.\n3. How to enter. Follow every step on the challenge page and submit your entry on PitchNest before the deadline.\n4. Scores. Only the score in PitchNest''s own report counts. Edited or fabricated screenshots lead to disqualification.\n5. Judging. Entries are judged as described in the judging criteria, with the published weights.\n6. Prizes. 1st place NGN 100,000; 2nd place NGN 60,000; 3rd place NGN 40,000. One prize per founder and per business. Winners are contacted by email and paid by bank transfer after PitchNest confirms their identity and eligibility.\n7. Announcement. Winners are announced on PitchNest''s official social media accounts on the announcement date. PitchNest may publish winners'' business names and Discover profile links; founders'' names only with their permission.\n8. Subscription. The Pro Founder plan is a normal paid plan under PitchNest''s Terms of Service and Refund Policy. The discount code applies to the first monthly payment only. A refunded payment ends the access it bought, and the entry may then no longer qualify.\n9. Social platforms. This challenge is not sponsored, endorsed or administered by, or associated with, Instagram, Facebook or X. By entering you release them from any liability connected with it.\n10. Disqualification. PitchNest may disqualify entries that break these terms, use manipulated evidence or misrepresent a business, and records the reason.\n11. Changes. PitchNest may change or cancel the challenge if it must; any change is posted on the challenge page.\n12. Privacy. Entry data is handled under PitchNest''s Privacy Policy.',
  60,
  ARRAY['solo', 'panel'],
  1,
  'pro',
  '{"instagram": {"handle": "@pitchnestapp", "url": "https://instagram.com/pitchnestapp"}, "facebook": {"handle": "pitchnestapp", "url": "https://facebook.com/pitchnestapp"}, "x": {"handle": "@pitchnestapp", "url": "https://x.com/pitchnestapp"}}'::jsonb,
  (SELECT id FROM discount_codes WHERE code = 'PCHU01'),
  'draft'
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants and RLS
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION challenge_score_number(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION challenge_score_number(JSONB) TO service_role;
REVOKE ALL ON FUNCTION refresh_challenge_scores(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION refresh_challenge_scores(UUID, UUID) TO service_role;
REVOKE ALL ON FUNCTION set_challenge_placements(UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_challenge_placements(UUID, INTEGER, JSONB) TO service_role;
REVOKE ALL ON FUNCTION reserve_discount_redemption(UUID, INTEGER, TEXT, NUMERIC, NUMERIC, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_discount_redemption(UUID, INTEGER, TEXT, NUMERIC, NUMERIC, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION sync_discount_redemption() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION list_user_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_user_notifications(INTEGER, INTEGER) TO service_role;

ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE challenge_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "discount_codes_deny_direct" ON discount_codes;
CREATE POLICY "discount_codes_deny_direct" ON discount_codes
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "discount_redemptions_deny_direct" ON discount_redemptions;
CREATE POLICY "discount_redemptions_deny_direct" ON discount_redemptions
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "challenges_deny_direct" ON challenges;
CREATE POLICY "challenges_deny_direct" ON challenges
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "challenge_participants_deny_direct" ON challenge_participants;
CREATE POLICY "challenge_participants_deny_direct" ON challenge_participants
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "admin_audit_log_deny_direct" ON admin_audit_log;
CREATE POLICY "admin_audit_log_deny_direct" ON admin_audit_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0038', 'Hosted challenges, entries, judging, winners and discount codes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
