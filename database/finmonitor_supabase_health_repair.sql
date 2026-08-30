-- FinMonitor Supabase health repair.
-- Use in Supabase SQL Editor for an existing FinMonitor database that is missing
-- newer tables/columns such as documents, source_document_id, CRM, liabilities,
-- company default assessments, lifecycle status, and org-scoped RLS helpers.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id);
    ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'pending';
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('manager', 'analyst', 'pending'));
  END IF;

  IF to_regclass('public.clients') IS NOT NULL THEN
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id);
    ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'activo';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check') THEN
      ALTER TABLE public.clients
        ADD CONSTRAINT clients_status_check
        CHECK (status IN ('activo', 'dormant', 'cerrado'));
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.client_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, key)
);

CREATE TABLE IF NOT EXISTS public.org_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, key)
);

CREATE INDEX IF NOT EXISTS profiles_org_id_idx ON public.profiles(org_id);
CREATE INDEX IF NOT EXISTS clients_org_id_idx ON public.clients(org_id);
CREATE INDEX IF NOT EXISTS client_settings_client_id_idx ON public.client_settings(client_id);
CREATE INDEX IF NOT EXISTS org_settings_org_id_idx ON public.org_settings(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique_idx
  ON public.profiles(LOWER(email))
  WHERE email IS NOT NULL AND email <> '';

INSERT INTO public.organizations (name, slug)
VALUES ('Syscap', 'syscap')
ON CONFLICT (slug) DO NOTHING;

UPDATE public.profiles
SET org_id = (SELECT id FROM public.organizations WHERE slug = 'syscap' LIMIT 1)
WHERE org_id IS NULL;

UPDATE public.clients
SET org_id = (SELECT id FROM public.organizations WHERE slug = 'syscap' LIMIT 1)
WHERE org_id IS NULL;

UPDATE public.clients SET status = 'activo' WHERE status IS NULL;

UPDATE public.profiles
SET role = 'manager'
WHERE LOWER(COALESCE(email, '')) = 'admin@finmonitor.mx'
   OR id = '0c0a6ff1-66b0-4af7-9151-373e75c6a147';

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_approved_user()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() IN ('manager', 'analyst'), false);
$$;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_user_role() = 'manager', false);
$$;

CREATE OR REPLACE FUNCTION public.current_user_org_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT org_id FROM public.profiles WHERE id = auth.uid();
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
  );
$$;

CREATE OR REPLACE FUNCTION public.client_in_current_org(target_client_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM public.clients c
    WHERE c.id = target_client_id
      AND public.is_current_org(c.org_id)
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.transaction_in_current_org(target_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM public.transactions t
    JOIN public.clients c ON c.id = t.client_id
    WHERE t.id = target_transaction_id
      AND public.is_current_org(c.org_id)
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.covenant_in_current_org(target_covenant_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM public.covenants cov
    JOIN public.clients c ON c.id = cov.client_id
    WHERE cov.id = target_covenant_id
      AND public.is_current_org(c.org_id)
  ), false);
$$;

CREATE TABLE IF NOT EXISTS public.documents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES public.clients(id) ON DELETE SET NULL,
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
  source_kind         TEXT NOT NULL DEFAULT 'external',
  storage_bucket      TEXT,
  storage_path        TEXT,
  uploaded_by         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  raw_metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, drive_file_id)
);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.document_extraction_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  processor           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',
  pages_processed     INTEGER DEFAULT 0,
  tables_found        INTEGER DEFAULT 0,
  error               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.document_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  extraction_run_id   UUID REFERENCES public.document_extraction_runs(id) ON DELETE SET NULL,
  page_number         INTEGER NOT NULL,
  raw_text            TEXT DEFAULT '',
  ocr_used            BOOLEAN DEFAULT FALSE,
  layout              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, page_number)
);

CREATE TABLE IF NOT EXISTS public.document_tables (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  extraction_run_id   UUID REFERENCES public.document_extraction_runs(id) ON DELETE SET NULL,
  page_number         INTEGER,
  sheet_name          TEXT,
  table_index         INTEGER NOT NULL DEFAULT 0,
  raw_table           JSONB NOT NULL,
  detected_periods    TEXT[] DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.account_mapping_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_pattern      TEXT NOT NULL,
  normalized_pattern  TEXT NOT NULL,
  statement_type      TEXT DEFAULT 'any',
  target_metric       TEXT NOT NULL,
  confidence          NUMERIC NOT NULL DEFAULT 0.8,
  rule_source         TEXT NOT NULL DEFAULT 'manual',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.extraction_review_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  document_id         UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  item_type           TEXT NOT NULL,
  source_key          TEXT,
  raw_value           JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggested_value     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'pending',
  confidence_score    NUMERIC DEFAULT 0,
  reviewed_by         UUID REFERENCES public.profiles(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.financial_line_item_sources (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  financial_statement_id UUID REFERENCES public.financial_statements(id) ON DELETE CASCADE,
  document_id            UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  document_table_id      UUID REFERENCES public.document_tables(id) ON DELETE SET NULL,
  page_number            INTEGER,
  sheet_name             TEXT,
  row_number             INTEGER,
  source_key             TEXT,
  account_name           TEXT NOT NULL,
  value                  NUMERIC NOT NULL DEFAULT 0,
  source_excerpt         TEXT DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.company_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  legal_name            TEXT DEFAULT '',
  tax_id                TEXT DEFAULT '',
  business_model        TEXT DEFAULT '',
  geography             TEXT DEFAULT '',
  years_operating       TEXT DEFAULT '',
  ownership_structure   TEXT DEFAULT '',
  management_summary    TEXT DEFAULT '',
  source_document_id    UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id)
);

CREATE TABLE IF NOT EXISTS public.qualitative_factors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  document_id         UUID REFERENCES public.documents(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id           UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  document_id         UUID REFERENCES public.documents(id) ON DELETE SET NULL,
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

DO $$
BEGIN
  IF to_regclass('public.financial_statements') IS NOT NULL THEN
    ALTER TABLE public.financial_statements ADD COLUMN IF NOT EXISTS source_document_id UUID;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'financial_statements_source_document_id_fkey') THEN
      ALTER TABLE public.financial_statements
        ADD CONSTRAINT financial_statements_source_document_id_fkey
        FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE SET NULL NOT VALID;
    END IF;
  END IF;

  IF to_regclass('public.loan_tapes') IS NOT NULL THEN
    ALTER TABLE public.loan_tapes ADD COLUMN IF NOT EXISTS source_document_id UUID;
    ALTER TABLE public.loan_tapes ADD COLUMN IF NOT EXISTS analyst_state JSONB NOT NULL DEFAULT '{}'::jsonb;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loan_tapes_source_document_id_fkey') THEN
      ALTER TABLE public.loan_tapes
        ADD CONSTRAINT loan_tapes_source_document_id_fkey
        FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE SET NULL NOT VALID;
    END IF;
  END IF;

  IF to_regclass('public.contract_files') IS NOT NULL THEN
    ALTER TABLE public.contract_files ADD COLUMN IF NOT EXISTS source_document_id UUID;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_files_source_document_id_fkey') THEN
      ALTER TABLE public.contract_files
        ADD CONSTRAINT contract_files_source_document_id_fkey
        FOREIGN KEY (source_document_id) REFERENCES public.documents(id) ON DELETE SET NULL NOT VALID;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.institutional_liabilities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  source_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  lender_name        TEXT NOT NULL,
  liability_type     TEXT DEFAULT 'linea_credito',
  original_amount    NUMERIC,
  current_balance    NUMERIC,
  currency           TEXT DEFAULT 'MXN',
  interest_rate      NUMERIC,
  rate_description   TEXT,
  origination_date   DATE,
  maturity_date      DATE,
  amortization       TEXT,
  guarantee          TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.company_default_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL UNIQUE REFERENCES public.clients(id) ON DELETE CASCADE,
  z_score         NUMERIC,
  classification  TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,
  default_date    DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.monitoring_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,
  period_date DATE,
  frequency   TEXT DEFAULT 'mensual',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'approved', 'locked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, period)
);

CREATE TABLE IF NOT EXISTS public.document_requirements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('financial_statement', 'loan_tape', 'contract', 'other')),
  name           TEXT NOT NULL,
  periodicity    TEXT DEFAULT 'mensual',
  due_day        INTEGER DEFAULT 15,
  required       BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  title          TEXT DEFAULT '',
  department     TEXT DEFAULT '',
  email          TEXT DEFAULT '',
  phone          TEXT DEFAULT '',
  influence      TEXT NOT NULL DEFAULT 'medium' CHECK (influence IN ('low', 'medium', 'high', 'decision_maker')),
  relationship   TEXT NOT NULL DEFAULT 'neutral' CHECK (relationship IN ('champion', 'neutral', 'risk')),
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT DEFAULT '',
  created_by     UUID REFERENCES public.profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.crm_activities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
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
  owner_id       UUID REFERENCES public.profiles(id),
  created_by     UUID REFERENCES public.profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.crm_activities
  ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS record_type TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_stage TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS analyst_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS quick_note TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_step TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS public.monitoring_alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title       TEXT NOT NULL,
  detail      TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  owner_id    UUID REFERENCES public.profiles(id),
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_data JSONB,
  after_data  JSONB,
  user_id     UUID REFERENCES public.profiles(id),
  user_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.extraction_review_items ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE public.financial_line_item_sources ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE public.qualitative_factors ADD COLUMN IF NOT EXISTS source_key TEXT;

CREATE INDEX IF NOT EXISTS documents_org_client_idx ON public.documents(org_id, client_id);
CREATE INDEX IF NOT EXISTS documents_type_status_idx ON public.documents(document_type, extraction_status);
CREATE INDEX IF NOT EXISTS documents_storage_idx ON public.documents(storage_bucket, storage_path);
CREATE INDEX IF NOT EXISTS document_pages_document_idx ON public.document_pages(document_id);
CREATE INDEX IF NOT EXISTS document_tables_document_idx ON public.document_tables(document_id);
CREATE INDEX IF NOT EXISTS review_items_status_idx ON public.extraction_review_items(org_id, status, item_type);
CREATE INDEX IF NOT EXISTS qualitative_factors_client_idx ON public.qualitative_factors(client_id, category);
CREATE INDEX IF NOT EXISTS financial_statements_source_document_idx ON public.financial_statements(source_document_id);
CREATE INDEX IF NOT EXISTS loan_tapes_source_document_idx ON public.loan_tapes(source_document_id);
CREATE INDEX IF NOT EXISTS contract_files_source_document_idx ON public.contract_files(source_document_id);
CREATE INDEX IF NOT EXISTS institutional_liabilities_client_id_idx ON public.institutional_liabilities(client_id);
CREATE INDEX IF NOT EXISTS company_default_assessments_client_id_idx ON public.company_default_assessments(client_id);
CREATE INDEX IF NOT EXISTS crm_contacts_client_id_idx ON public.crm_contacts(client_id);
CREATE INDEX IF NOT EXISTS crm_activities_client_id_due_at_idx ON public.crm_activities(client_id, due_at);
CREATE INDEX IF NOT EXISTS crm_activities_client_id_status_idx ON public.crm_activities(client_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS review_items_source_key_idx
  ON public.extraction_review_items(org_id, document_id, item_type, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS line_item_sources_source_key_idx
  ON public.financial_line_item_sources(financial_statement_id, source_key);

CREATE UNIQUE INDEX IF NOT EXISTS qualitative_factors_source_key_idx
  ON public.qualitative_factors(client_id, document_id, source_key);

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

DO $$
DECLARE
  target_table TEXT;
  policy_name TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'profiles',
    'organizations',
    'clients',
    'custom_fields',
    'client_settings',
    'org_settings',
    'transactions',
    'contract_files',
    'covenants',
    'covenant_annotations',
    'financial_statements',
    'loan_tapes',
    'institutional_liabilities',
    'company_default_assessments',
    'monitoring_periods',
    'document_requirements',
    'monitoring_alerts',
    'audit_events',
    'documents',
    'document_extraction_runs',
    'document_pages',
    'document_tables',
    'account_mapping_rules',
    'extraction_review_items',
    'financial_line_item_sources',
    'company_profiles',
    'qualitative_factors',
    'ai_usage_events',
    'crm_contacts',
    'crm_activities'
  ]
  LOOP
    IF to_regclass('public.' || target_table) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
      FOREACH policy_name IN ARRAY ARRAY[
        'auth_all',
        'approved_all',
        'profile_read_self_or_manager',
        'profile_update_manager',
        'org_scoped_all',
        'org_scoped_read',
        'org_scoped_update',
        'client_org_scoped_all',
        'client_child_org_scoped_all',
        'transaction_child_org_scoped_all',
        'covenant_child_org_scoped_all',
        'document_org_scoped_all',
        'document_run_org_scoped_all',
        'document_page_org_scoped_all',
        'document_table_org_scoped_all',
        'mapping_rule_org_scoped_all',
        'review_item_org_scoped_all',
        'line_item_source_org_scoped_all',
        'company_profile_client_scoped_all',
        'qualitative_factor_client_scoped_all',
        'ai_usage_org_scoped_all'
      ]
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, target_table);
      END LOOP;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  CREATE POLICY "profile_read_self_or_manager" ON public.profiles
    FOR SELECT TO authenticated
    USING (
      id = auth.uid()
      OR (
        public.is_manager()
        AND org_id = public.current_user_org_id()
      )
    );

  CREATE POLICY "profile_update_manager" ON public.profiles
    FOR UPDATE TO authenticated
    USING (
      public.is_manager()
      AND org_id = public.current_user_org_id()
    )
    WITH CHECK (
      org_id = public.current_user_org_id()
    );

  CREATE POLICY "org_scoped_all" ON public.organizations
    FOR ALL TO authenticated
    USING (public.is_current_org(id))
    WITH CHECK (public.is_current_org(id));

  CREATE POLICY "client_org_scoped_all" ON public.clients
    FOR ALL TO authenticated
    USING (public.is_current_org(org_id))
    WITH CHECK (public.is_current_org(org_id));

  CREATE POLICY "org_scoped_all" ON public.org_settings
    FOR ALL TO authenticated
    USING (public.is_current_org(org_id))
    WITH CHECK (public.is_current_org(org_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.custom_fields
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.client_settings
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.transactions
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.contract_files
    FOR ALL TO authenticated
    USING (
      public.client_in_current_org(client_id)
      AND public.transaction_in_current_org(transaction_id)
    )
    WITH CHECK (
      public.client_in_current_org(client_id)
      AND public.transaction_in_current_org(transaction_id)
    );

  CREATE POLICY "client_child_org_scoped_all" ON public.covenants
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "covenant_child_org_scoped_all" ON public.covenant_annotations
    FOR ALL TO authenticated
    USING (public.covenant_in_current_org(covenant_id))
    WITH CHECK (public.covenant_in_current_org(covenant_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.financial_statements
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.loan_tapes
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.institutional_liabilities
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.company_default_assessments
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.monitoring_periods
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.document_requirements
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.monitoring_alerts
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.audit_events
    FOR ALL TO authenticated
    USING (client_id IS NOT NULL AND public.client_in_current_org(client_id))
    WITH CHECK (client_id IS NOT NULL AND public.client_in_current_org(client_id));

  CREATE POLICY "document_org_scoped_all" ON public.documents
    FOR ALL TO authenticated
    USING (public.is_current_org(org_id))
    WITH CHECK (public.is_current_org(org_id));

  CREATE POLICY "document_run_org_scoped_all" ON public.document_extraction_runs
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ));

  CREATE POLICY "document_page_org_scoped_all" ON public.document_pages
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ));

  CREATE POLICY "document_table_org_scoped_all" ON public.document_tables
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ));

  CREATE POLICY "mapping_rule_org_scoped_all" ON public.account_mapping_rules
    FOR ALL TO authenticated
    USING (public.is_current_org(org_id))
    WITH CHECK (public.is_current_org(org_id));

  CREATE POLICY "review_item_org_scoped_all" ON public.extraction_review_items
    FOR ALL TO authenticated
    USING (public.is_current_org(org_id))
    WITH CHECK (public.is_current_org(org_id));

  CREATE POLICY "line_item_source_org_scoped_all" ON public.financial_line_item_sources
    FOR ALL TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.financial_statements fs
      JOIN public.clients c ON c.id = fs.client_id
      WHERE fs.id = financial_statement_id
        AND public.is_current_org(c.org_id)
    ))
    WITH CHECK (EXISTS (
      SELECT 1 FROM public.financial_statements fs
      JOIN public.clients c ON c.id = fs.client_id
      WHERE fs.id = financial_statement_id
        AND public.is_current_org(c.org_id)
    ));

  CREATE POLICY "company_profile_client_scoped_all" ON public.company_profiles
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "qualitative_factor_client_scoped_all" ON public.qualitative_factors
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "ai_usage_org_scoped_all" ON public.ai_usage_events
    FOR ALL TO authenticated
    USING (org_id IS NULL OR public.is_current_org(org_id))
    WITH CHECK (org_id IS NULL OR public.is_current_org(org_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.crm_contacts
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));

  CREATE POLICY "client_child_org_scoped_all" ON public.crm_activities
    FOR ALL TO authenticated
    USING (public.client_in_current_org(client_id))
    WITH CHECK (public.client_in_current_org(client_id));
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "financial_document_storage_select" ON storage.objects;
  DROP POLICY IF EXISTS "financial_document_storage_insert" ON storage.objects;
  DROP POLICY IF EXISTS "financial_document_storage_update" ON storage.objects;
  DROP POLICY IF EXISTS "financial_document_storage_delete" ON storage.objects;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

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
