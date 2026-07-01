-- Persist the Julius-style loan tape workspace and Q&A with each tape.
ALTER TABLE public.loan_tapes
  ADD COLUMN IF NOT EXISTS analyst_state JSONB NOT NULL DEFAULT '{}'::jsonb;
