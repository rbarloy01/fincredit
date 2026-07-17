-- Pasivos Institucionales: who is lending money TO the client (banks, development
-- banks, institutional investors) — the mirror of loan_tapes (who the client lends
-- money to). One row per facility/credit line rather than one row per uploaded file:
-- unlike a retail loan tape with thousands of borrower rows, a client's institutional
-- funding sources are a short, human-scale list (typically 5-30 facilities), so a
-- normal editable table fits better than loan_tapes' single-JSON-blob-per-file shape.

CREATE TABLE IF NOT EXISTS institutional_liabilities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL, -- documents already exists in prod, safe to reference inline here
  lender_name       TEXT NOT NULL,
  liability_type    TEXT DEFAULT 'linea_credito', -- linea_credito | prestamo_simple | bono | otro
  original_amount   NUMERIC,
  current_balance   NUMERIC,
  currency          TEXT DEFAULT 'MXN',
  interest_rate     NUMERIC,           -- all-in annual rate as a decimal (0.12 = 12%), for calculations
  rate_description  TEXT,              -- human-readable formula, e.g. "TIIE + 350 pb"
  origination_date  DATE,
  maturity_date     DATE,
  amortization      TEXT,              -- bullet | mensual | trimestral | otro
  guarantee         TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS institutional_liabilities_client_id_idx ON institutional_liabilities(client_id);

ALTER TABLE institutional_liabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_child_org_scoped_all" ON institutional_liabilities
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));
