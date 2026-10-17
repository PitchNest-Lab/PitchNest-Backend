-- Emergency security hardening discovered during the full application audit.
-- Idempotent and safe to apply after 0026.

BEGIN;

-- Billing settlement is callable only by the backend service role. Protect the
-- active four-argument function and the legacy five-argument overload when it
-- still exists in an environment that has not completed migration 0010.
DO $$
BEGIN
  IF to_regprocedure('public.grant_pro_access(text,text,numeric,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pro_access(text,text,numeric,text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pro_access(text,text,numeric,text) TO service_role';
    EXECUTE 'ALTER FUNCTION public.grant_pro_access(text,text,numeric,text) SET search_path = public';
  END IF;

  IF to_regprocedure('public.grant_pro_access(text,text,numeric,text,integer)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.grant_pro_access(text,text,numeric,text,integer) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.grant_pro_access(text,text,numeric,text,integer) TO service_role';
    EXECUTE 'ALTER FUNCTION public.grant_pro_access(text,text,numeric,text,integer) SET search_path = public';
  END IF;
END
$$;

-- Trial reminder claims are backend-owned state. Direct access could expose
-- user identifiers or let a caller suppress email by pre-claiming milestones.
ALTER TABLE trial_email_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trial_email_log_deny_direct" ON trial_email_log;
CREATE POLICY "trial_email_log_deny_direct" ON trial_email_log
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

REVOKE ALL ON TABLE trial_email_log FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE trial_email_log TO service_role;

INSERT INTO schema_migrations (version, description)
VALUES ('0027', 'Emergency billing RPC and trial lifecycle hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
