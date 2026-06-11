-- FinMonitor production hardening.
-- Run this once in Supabase SQL Editor.
-- It creates missing settings tables, gates Google/OAuth users as pending,
-- and blocks pending users from application data with RLS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id);

ALTER TABLE public.profiles
  ALTER COLUMN role SET DEFAULT 'pending';

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('manager', 'analyst', 'pending'));

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id);

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

-- Keep the known initial admin able to approve users.
UPDATE public.profiles
SET role = 'manager'
WHERE LOWER(email) = 'admin@finmonitor.mx'
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

DO $$
DECLARE
  target_table TEXT;
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
    'monitoring_periods',
    'document_requirements',
    'monitoring_alerts',
    'audit_events'
  ]
  LOOP
    IF to_regclass('public.' || target_table) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
      EXECUTE format('DROP POLICY IF EXISTS "auth_all" ON public.%I', target_table);
      EXECUTE format('DROP POLICY IF EXISTS "approved_all" ON public.%I', target_table);
    END IF;
  END LOOP;
END $$;

DROP POLICY IF EXISTS "profile_read_self_or_manager" ON public.profiles;
DROP POLICY IF EXISTS "profile_update_manager" ON public.profiles;

CREATE POLICY "profile_read_self_or_manager" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_manager());

CREATE POLICY "profile_update_manager" ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_manager())
  WITH CHECK (true);

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
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
    'monitoring_periods',
    'document_requirements',
    'monitoring_alerts',
    'audit_events'
  ]
  LOOP
    IF to_regclass('public.' || target_table) IS NOT NULL THEN
      EXECUTE format(
        'CREATE POLICY "approved_all" ON public.%I FOR ALL TO authenticated USING (public.is_approved_user()) WITH CHECK (public.is_approved_user())',
        target_table
      );
    END IF;
  END LOOP;
END $$;
