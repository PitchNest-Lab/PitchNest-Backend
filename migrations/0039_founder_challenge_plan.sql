-- The PitchNest Challenge uses the paid Founder plan. New accounts still start
-- on Free; this changes only the seeded challenge and its promotion.
BEGIN;

DO $$
DECLARE
  changed_plans INTEGER;
BEGIN
  UPDATE discount_codes
     SET plans = ARRAY['prep']::TEXT[]
   WHERE code = 'PCHU01'
     AND plans IS DISTINCT FROM ARRAY['prep']::TEXT[];
  GET DIAGNOSTICS changed_plans = ROW_COUNT;

  IF changed_plans > 0 THEN
    UPDATE challenges
       SET confirmations = COALESCE(confirmations, '{}'::JSONB) - 'discount'
     WHERE slug = 'pitchnest-challenge';
  END IF;
END $$;

UPDATE discount_codes
   SET description = replace(description, 'Pro Founder', 'Founder')
 WHERE code = 'PCHU01'
   AND description IS DISTINCT FROM replace(description, 'Pro Founder', 'Founder');

UPDATE challenges
   SET required_plan = 'prep',
       eligibility = replace(eligibility, 'Pro Founder', 'Founder'),
       terms = replace(terms, 'Pro Founder', 'Founder'),
       confirmations = COALESCE(confirmations, '{}'::JSONB) - 'terms'
 WHERE slug = 'pitchnest-challenge'
   AND (
     required_plan IS DISTINCT FROM 'prep'
     OR eligibility IS DISTINCT FROM replace(eligibility, 'Pro Founder', 'Founder')
     OR terms IS DISTINCT FROM replace(terms, 'Pro Founder', 'Founder')
   );

INSERT INTO schema_migrations (version, description)
VALUES ('0039', 'Use the paid Founder plan for the PitchNest Challenge')
ON CONFLICT (version) DO NOTHING;

COMMIT;
