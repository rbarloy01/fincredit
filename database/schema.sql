-- FinMonitor v2 — Supabase Schema
-- Run this in the Supabase SQL Editor or via Management API

-- ── Profiles (extends Supabase Auth) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('manager', 'analyst')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Clients ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  name           TEXT NOT NULL,
  file_name      TEXT,
  tape_type      TEXT DEFAULT 'credito',
  extracted_data JSONB,
  upload_date    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
ALTER TABLE clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_files        ENABLE ROW LEVEL SECURITY;
ALTER TABLE covenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE covenant_annotations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_statements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_tapes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_periods    ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events          ENABLE ROW LEVEL SECURITY;

-- Authenticated users have full access (tighten per-role later if needed)
CREATE POLICY "auth_all" ON profiles             FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON clients              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON custom_fields        FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON transactions         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON contract_files       FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON covenants            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON covenant_annotations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON financial_statements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON loan_tapes           FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON monitoring_periods   FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON document_requirements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON monitoring_alerts    FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all" ON audit_events         FOR ALL TO authenticated USING (true) WITH CHECK (true);
