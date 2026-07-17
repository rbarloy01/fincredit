-- FinMonitor v2 — Supabase Schema
-- Run this in the Supabase SQL Editor or via Management API

-- ── Organizations ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Profiles (extends Supabase Auth) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL DEFAULT 'pending' CHECK (role IN ('manager', 'analyst', 'pending')),
  org_id     UUID REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Clients ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID REFERENCES organizations(id),
  name                  TEXT NOT NULL,
  tax_id                TEXT,
  industry              TEXT,
  score                 TEXT,
  currency              TEXT NOT NULL DEFAULT 'MXN',
  total_credit_value    NUMERIC NOT NULL DEFAULT 0,
  credit_type           TEXT[] DEFAULT '{}',
  contract_name         TEXT,
  analyst_name          TEXT,
  created_by            UUID REFERENCES profiles(id),
  payment_history       JSONB DEFAULT '[]',
  current_due           NUMERIC DEFAULT 0,
  max_default_days      INTEGER DEFAULT 0,
  max_default_amount    NUMERIC DEFAULT 0,
  default_frequency_12m INTEGER DEFAULT 0,
  opinion               TEXT DEFAULT '',
  aforo_requerido       TEXT DEFAULT '',
  aforo_history         JSONB DEFAULT '[]',
  documentation         JSONB DEFAULT '[]',
  report_date           TEXT DEFAULT '',
  frequency             TEXT DEFAULT 'mensual',
  last_period           TEXT DEFAULT '',
  logo_left             TEXT,
  logo_right            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Custom Fields ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_fields (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  value      TEXT DEFAULT '',
  field_type TEXT NOT NULL DEFAULT 'text',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Client Settings / SaaS Preferences ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, key)
);

-- ── Org Settings / Shared SaaS Preferences ──────────────────────────────────
CREATE TABLE IF NOT EXISTS org_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, key)
);

-- ── Transactions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  date            TEXT DEFAULT '',
  credit_type     TEXT DEFAULT '',
  original_amount NUMERIC DEFAULT 0,
  currency        TEXT DEFAULT 'MXN',
  signed_at       TEXT DEFAULT '',
  maturity_at     TEXT DEFAULT '',
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Contract Files ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contract_files (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  original_name       TEXT NOT NULL,
  mime_type           TEXT,
  base64_data         TEXT,
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extraction_status   TEXT DEFAULT 'pending',
  extracted_covenants JSONB
);

-- ── Covenants ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS covenants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  transaction_id    UUID REFERENCES transactions(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('financial', 'hacer', 'noHacer')),
  formula           TEXT DEFAULT '',
  formula_by_period JSONB DEFAULT '{}',
  threshold         TEXT DEFAULT '',
  operator          TEXT DEFAULT 'none',
  description       TEXT DEFAULT '',
  compliance_status TEXT DEFAULT 'pendiente',
  is_custom         BOOLEAN DEFAULT TRUE,
  extracted_from    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Covenant Annotations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS covenant_annotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  covenant_id UUID NOT NULL REFERENCES covenants(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES profiles(id),
  user_name   TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Financial Statements ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS financial_statements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_document_id  UUID,
  source_company_name TEXT,
  document_type       TEXT,
  period              TEXT NOT NULL,
  period_date         TEXT NOT NULL,
  file_name           TEXT,
  raw_line_items      JSONB DEFAULT '[]',
  mapped_data         JSONB NOT NULL DEFAULT '{}',
  extra_accounts      JSONB DEFAULT '[]',
  upload_date         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Loan Tapes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_tapes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_document_id UUID,
  name           TEXT NOT NULL,
  file_name      TEXT,
  tape_type      TEXT DEFAULT 'credito',
  extracted_data JSONB,
  analyst_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  upload_date    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Institutional Liabilities (Pasivos Institucionales) ─────────────────────
-- Mirror of loan_tapes for the other side of the balance sheet: who is lending
-- money TO the client (banks, development banks, institutional investors).
-- One row per facility/credit line — a client's funding sources are a short,
-- human-scale list, unlike a retail loan tape's thousands of borrower rows.
CREATE TABLE IF NOT EXISTS institutional_liabilities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_document_id UUID,
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

-- ── Source Documents / Private Upload Registry ──────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  source_kind         TEXT NOT NULL DEFAULT 'upload',
  drive_file_id       TEXT,
  drive_parent_id     TEXT,
  drive_path          TEXT DEFAULT '',
  source_uri          TEXT,
  storage_bucket      TEXT,
  storage_path        TEXT,
  file_name           TEXT NOT NULL,
  mime_type           TEXT,
  size_bytes          BIGINT,
  checksum            TEXT,
  document_type       TEXT NOT NULL DEFAULT 'unknown',
  period              TEXT DEFAULT '',
  period_date         DATE,
  source_status       TEXT NOT NULL DEFAULT 'active',
  extraction_status   TEXT NOT NULL DEFAULT 'pending',
  confidence_score    NUMERIC DEFAULT 0,
  raw_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, drive_file_id)
);

ALTER TABLE financial_statements
  ADD CONSTRAINT financial_statements_source_document_id_fkey
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE loan_tapes
  ADD CONSTRAINT loan_tapes_source_document_id_fkey
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE institutional_liabilities
  ADD CONSTRAINT institutional_liabilities_source_document_id_fkey
  FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_org_client_idx ON documents(org_id, client_id);
CREATE INDEX IF NOT EXISTS documents_type_status_idx ON documents(document_type, extraction_status);

-- ── Document AI Ingestion Warehouse ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_extraction_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  processor           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',
  pages_processed     INTEGER DEFAULT 0,
  tables_found        INTEGER DEFAULT 0,
  error               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS document_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_run_id   UUID REFERENCES document_extraction_runs(id) ON DELETE SET NULL,
  page_number         INTEGER NOT NULL,
  raw_text            TEXT DEFAULT '',
  ocr_used            BOOLEAN DEFAULT FALSE,
  layout              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, page_number)
);

CREATE TABLE IF NOT EXISTS document_tables (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  extraction_run_id   UUID REFERENCES document_extraction_runs(id) ON DELETE SET NULL,
  page_number         INTEGER,
  sheet_name          TEXT,
  table_index         INTEGER NOT NULL DEFAULT 0,
  raw_table           JSONB NOT NULL,
  detected_periods    TEXT[] DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_mapping_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_pattern      TEXT NOT NULL,
  normalized_pattern  TEXT NOT NULL,
  statement_type      TEXT DEFAULT 'any',
  target_metric       TEXT NOT NULL,
  confidence          NUMERIC NOT NULL DEFAULT 0.8,
  rule_source         TEXT NOT NULL DEFAULT 'manual',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS extraction_review_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id) ON DELETE CASCADE,
  document_id         UUID REFERENCES documents(id) ON DELETE CASCADE,
  item_type           TEXT NOT NULL,
  source_key          TEXT,
  raw_value           JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggested_value     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'pending',
  confidence_score    NUMERIC DEFAULT 0,
  reviewed_by         UUID REFERENCES profiles(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS financial_line_item_sources (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_statement_id UUID REFERENCES financial_statements(id) ON DELETE CASCADE,
  document_id            UUID REFERENCES documents(id) ON DELETE SET NULL,
  document_table_id      UUID REFERENCES document_tables(id) ON DELETE SET NULL,
  page_number            INTEGER,
  sheet_name             TEXT,
  row_number             INTEGER,
  source_key             TEXT,
  account_name           TEXT NOT NULL,
  value                  NUMERIC NOT NULL DEFAULT 0,
  source_excerpt         TEXT DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  legal_name            TEXT DEFAULT '',
  tax_id                TEXT DEFAULT '',
  business_model        TEXT DEFAULT '',
  geography             TEXT DEFAULT '',
  years_operating       TEXT DEFAULT '',
  ownership_structure   TEXT DEFAULT '',
  management_summary    TEXT DEFAULT '',
  source_document_id    UUID REFERENCES documents(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id)
);

CREATE TABLE IF NOT EXISTS qualitative_factors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id         UUID REFERENCES documents(id) ON DELETE SET NULL,
  source_key          TEXT,
  category            TEXT NOT NULL,
  factor              TEXT NOT NULL,
  assessment          TEXT DEFAULT '',
  risk_level          TEXT DEFAULT 'unknown',
  source_excerpt      TEXT DEFAULT '',
  period_date         DATE,
  status              TEXT NOT NULL DEFAULT 'draft',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  document_id         UUID REFERENCES documents(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  task_type           TEXT NOT NULL,
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  total_tokens        INTEGER DEFAULT 0,
  estimated_cost_usd  NUMERIC DEFAULT 0,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_pages_document_idx ON document_pages(document_id);
CREATE INDEX IF NOT EXISTS document_tables_document_idx ON document_tables(document_id);
CREATE INDEX IF NOT EXISTS review_items_status_idx ON extraction_review_items(org_id, status, item_type);
CREATE INDEX IF NOT EXISTS qualitative_factors_client_idx ON qualitative_factors(client_id, category);

CREATE UNIQUE INDEX IF NOT EXISTS review_items_source_key_idx
  ON extraction_review_items(org_id, document_id, item_type, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS line_item_sources_source_key_idx
  ON financial_line_item_sources(financial_statement_id, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS qualitative_factors_source_key_idx
  ON qualitative_factors(client_id, document_id, source_key);

-- ── SaaS Monitoring Core ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitoring_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,
  period_date DATE,
  frequency   TEXT DEFAULT 'mensual',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'approved', 'locked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, period)
);

CREATE TABLE IF NOT EXISTS document_requirements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('financial_statement', 'loan_tape', 'contract', 'other')),
  name           TEXT NOT NULL,
  periodicity    TEXT DEFAULT 'mensual',
  due_day        INTEGER DEFAULT 15,
  required       BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── CRM Contacts / Relationship Tracking ───────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  title          TEXT DEFAULT '',
  department     TEXT DEFAULT '',
  email          TEXT DEFAULT '',
  phone          TEXT DEFAULT '',
  influence      TEXT NOT NULL DEFAULT 'medium' CHECK (influence IN ('low', 'medium', 'high', 'decision_maker')),
  relationship   TEXT NOT NULL DEFAULT 'neutral' CHECK (relationship IN ('champion', 'neutral', 'risk')),
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT DEFAULT '',
  created_by     UUID REFERENCES profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  type           TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('call', 'meeting', 'email', 'task', 'note', 'review')),
  phase          TEXT DEFAULT '',
  record_type    TEXT DEFAULT '',
  next_stage     TEXT DEFAULT '',
  contact_name   TEXT DEFAULT '',
  analyst_name   TEXT DEFAULT '',
  subject        TEXT NOT NULL,
  quick_note     TEXT DEFAULT '',
  next_step      TEXT DEFAULT '',
  detail         TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'canceled')),
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  due_at         TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  owner_id       UUID REFERENCES profiles(id),
  created_by     UUID REFERENCES profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monitoring_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title       TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  owner_id    UUID REFERENCES profiles(id),
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_data JSONB,
  after_data  JSONB,
  user_id     UUID REFERENCES profiles(id),
  user_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields         ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_files        ENABLE ROW LEVEL SECURITY;
ALTER TABLE covenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE covenant_annotations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_statements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_tapes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutional_liabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_periods    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_tables            ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_mapping_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_review_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_line_item_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualitative_factors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events            ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_approved_user()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() IN ('manager', 'analyst'), false)
$$;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = 'manager', false)
$$;

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_current_org(target_org_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    public.is_approved_user()
    AND target_org_id IS NOT NULL
    AND target_org_id = public.current_user_org_id(),
    false
  )
$$;

CREATE OR REPLACE FUNCTION public.client_in_current_org(target_client_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM clients c
    WHERE c.id = target_client_id
      AND public.is_current_org(c.org_id)
  ), false)
$$;

CREATE OR REPLACE FUNCTION public.transaction_in_current_org(target_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM transactions t
    JOIN clients c ON c.id = t.client_id
    WHERE t.id = target_transaction_id
      AND public.is_current_org(c.org_id)
  ), false)
$$;

CREATE OR REPLACE FUNCTION public.covenant_in_current_org(target_covenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM covenants cov
    JOIN clients c ON c.id = cov.client_id
    WHERE cov.id = target_covenant_id
      AND public.is_current_org(c.org_id)
  ), false)
$$;

CREATE POLICY "profile_read_self_or_manager" ON profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (
      public.is_manager()
      AND org_id = public.current_user_org_id()
    )
  );
CREATE POLICY "profile_update_manager" ON profiles
  FOR UPDATE TO authenticated
  USING (
    public.is_manager()
    AND org_id = public.current_user_org_id()
  )
  WITH CHECK (org_id = public.current_user_org_id());

CREATE POLICY "org_scoped_all" ON organizations
  FOR ALL TO authenticated
  USING (public.is_current_org(id))
  WITH CHECK (public.is_current_org(id));

CREATE POLICY "client_org_scoped_all" ON clients
  FOR ALL TO authenticated
  USING (public.is_current_org(org_id))
  WITH CHECK (public.is_current_org(org_id));

CREATE POLICY "org_scoped_all" ON org_settings
  FOR ALL TO authenticated
  USING (public.is_current_org(org_id))
  WITH CHECK (public.is_current_org(org_id));

CREATE POLICY "client_child_org_scoped_all" ON custom_fields
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON client_settings
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON transactions
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON contract_files
  FOR ALL TO authenticated
  USING (
    public.client_in_current_org(client_id)
    AND public.transaction_in_current_org(transaction_id)
  )
  WITH CHECK (
    public.client_in_current_org(client_id)
    AND public.transaction_in_current_org(transaction_id)
  );

CREATE POLICY "client_child_org_scoped_all" ON covenants
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "covenant_child_org_scoped_all" ON covenant_annotations
  FOR ALL TO authenticated
  USING (public.covenant_in_current_org(covenant_id))
  WITH CHECK (public.covenant_in_current_org(covenant_id));

CREATE POLICY "client_child_org_scoped_all" ON financial_statements
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON loan_tapes
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON institutional_liabilities
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "document_org_scoped_all" ON documents
  FOR ALL TO authenticated
  USING (public.is_current_org(org_id))
  WITH CHECK (public.is_current_org(org_id));

CREATE POLICY "document_run_org_scoped_all" ON document_extraction_runs
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ));

CREATE POLICY "document_page_org_scoped_all" ON document_pages
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ));

CREATE POLICY "document_table_org_scoped_all" ON document_tables
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM documents d
    WHERE d.id = document_id AND public.is_current_org(d.org_id)
  ));

CREATE POLICY "mapping_rule_org_scoped_all" ON account_mapping_rules
  FOR ALL TO authenticated
  USING (public.is_current_org(org_id))
  WITH CHECK (public.is_current_org(org_id));

CREATE POLICY "review_item_org_scoped_all" ON extraction_review_items
  FOR ALL TO authenticated
  USING (public.is_current_org(org_id))
  WITH CHECK (public.is_current_org(org_id));

CREATE POLICY "line_item_source_org_scoped_all" ON financial_line_item_sources
  FOR ALL TO authenticated
  USING (
    (document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    OR
    (financial_statement_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM financial_statements fs
      WHERE fs.id = financial_statement_id
        AND public.client_in_current_org(fs.client_id)
    ))
  )
  WITH CHECK (
    (document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    OR
    (financial_statement_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM financial_statements fs
      WHERE fs.id = financial_statement_id
        AND public.client_in_current_org(fs.client_id)
    ))
  );

CREATE POLICY "company_profile_client_scoped_all" ON company_profiles
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "qualitative_factor_client_scoped_all" ON qualitative_factors
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "ai_usage_org_scoped_all" ON ai_usage_events
  FOR ALL TO authenticated
  USING (org_id IS NOT NULL AND public.is_current_org(org_id))
  WITH CHECK (org_id IS NOT NULL AND public.is_current_org(org_id));

CREATE POLICY "client_child_org_scoped_all" ON monitoring_periods
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON document_requirements
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON crm_contacts
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON crm_activities
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON monitoring_alerts
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON audit_events
  FOR ALL TO authenticated
  USING (client_id IS NOT NULL AND public.client_in_current_org(client_id))
  WITH CHECK (client_id IS NOT NULL AND public.client_in_current_org(client_id));

-- ── Private Supabase Storage Bucket ─────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'financial-documents',
  'financial-documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "financial_document_storage_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'financial-documents'
    AND public.is_current_org(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "financial_document_storage_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'financial-documents'
    AND public.is_current_org(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "financial_document_storage_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'financial-documents'
    AND public.is_current_org(((storage.foldername(name))[1])::uuid)
  )
  WITH CHECK (
    bucket_id = 'financial-documents'
    AND public.is_current_org(((storage.foldername(name))[1])::uuid)
  );

CREATE POLICY "financial_document_storage_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'financial-documents'
    AND public.is_current_org(((storage.foldername(name))[1])::uuid)
  );
