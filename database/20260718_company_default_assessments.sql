-- Company-level default/Z-Score risk assessment, one row per client.
-- Z-Score value and classification are entered manually for now — the
-- calculation formula has not been implemented (to be provided later).
-- Run after the base FinMonitor schema.

CREATE TABLE IF NOT EXISTS company_default_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  z_score         NUMERIC,
  classification  TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  default_date    DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS company_default_assessments_client_id_idx ON company_default_assessments(client_id);

ALTER TABLE company_default_assessments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_child_org_scoped_all" ON company_default_assessments
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));
