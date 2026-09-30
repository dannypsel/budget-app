-- Widen churn_credits.frequency and persist every contributing transaction so
-- auto-detection can accumulate PARTIAL credit usage across multiple postings
-- (e.g. a $200 airline credit used via three separate purchases).
--
--   * frequency gains 'quarterly' (Resy, Lululemon, Hilton airline credits…)
--     and 'quadrennial' (Global Entry / TSA PreCheck, every 4 years).
--   * detected_transaction_ids uuid[] records every transaction whose
--     statement credit counted toward used_amount this cycle, so the detector
--     can re-scan each cycle without double-counting one posting for two
--     credits. detected_transaction_id (singular) is kept as the latest
--     contributing transaction for the UI's "View transaction" link.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'churn_credits_frequency_check') THEN
    ALTER TABLE churn_credits DROP CONSTRAINT churn_credits_frequency_check;
  END IF;
END $$;

ALTER TABLE churn_credits
  ADD CONSTRAINT churn_credits_frequency_check
  CHECK (frequency IN ('annual', 'semiannual', 'quarterly', 'monthly', 'quadrennial'));

ALTER TABLE churn_credits
  ADD COLUMN IF NOT EXISTS detected_transaction_ids uuid[] NOT NULL DEFAULT '{}';
