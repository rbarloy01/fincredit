-- Document AI ingestion warehouse for Google Drive backed source files.
-- Run after the base FinMonitor schema and org-scoped RLS helpers.

CREATE TABLE IF NOT EXISTS documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES clients(id) ON DELETE SET NULL,
  drive_file_id       TEXT,
  drive_parent_id     TEXT,
  drive_path          TEXT DEFAULT '',
  source_uri          TEXT,
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
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, drive_file_id)
);

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

CREATE INDEX IF NOT EXISTS documents_org_client_idx ON documents(org_id, client_id);
CREATE INDEX IF NOT EXISTS documents_type_status_idx ON documents(document_type, extraction_status);
CREATE INDEX IF NOT EXISTS document_pages_document_idx ON document_pages(document_id);
CREATE INDEX IF NOT EXISTS document_tables_document_idx ON document_tables(document_id);
CREATE INDEX IF NOT EXISTS review_items_status_idx ON extraction_review_items(org_id, status, item_type);
CREATE INDEX IF NOT EXISTS qualitative_factors_client_idx ON qualitative_factors(client_id, category);

ALTER TABLE extraction_review_items ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE financial_line_item_sources ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE qualitative_factors ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS review_items_source_key_idx
  ON extraction_review_items(org_id, document_id, item_type, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS line_item_sources_source_key_idx
  ON financial_line_item_sources(financial_statement_id, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS qualitative_factors_source_key_idx
  ON qualitative_factors(client_id, document_id, source_key);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_mapping_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_line_item_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualitative_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;

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
