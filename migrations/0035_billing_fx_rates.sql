-- Exchange rates for local-currency prices.
-- Depends on 0018 (schema_migrations). A converted price gets its own
-- Flutterwave payment plan in billing_provider_plans (0031), like any price.
--
--   * billing_fx_rates holds, per currency, how many units buy one US dollar,
--     as the backend last read it from Flutterwave. Every server instance
--     prices from the same row, so the amount a buyer is shown is the amount
--     checkout charges.
--   * checked_at is when Flutterwave last confirmed the rate; updated_at is
--     when usd_rate last changed. The backend keeps a rate until it moves by
--     2% or more, and stops offering a currency whose rate is over 7 days old.
--   * Only the backend (service_role) reads or writes it. Deleting a row makes
--     the backend fetch that currency's rate again on the next price request.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_fx_rates (
  currency TEXT PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'USD'),
  -- Units of this currency per one US dollar.
  usd_rate NUMERIC(18, 6) NOT NULL CHECK (usd_rate > 0),
  source TEXT NOT NULL DEFAULT 'flutterwave',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billing_fx_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_fx_rates_deny_direct" ON billing_fx_rates;
CREATE POLICY "billing_fx_rates_deny_direct" ON billing_fx_rates
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

INSERT INTO schema_migrations (version, description)
VALUES ('0035', 'Exchange rates for local-currency prices')
ON CONFLICT (version) DO NOTHING;

COMMIT;
