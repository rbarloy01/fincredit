-- FinMonitor organization-scoped RLS.
-- Safe to run more than once after 20260610_production_access_hardening.sql.
-- Replaces broad "approved_all" policies with policies constrained to the
-- authenticated user's organization.

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
    'monitoring_periods',
    'document_requirements',
    'monitoring_alerts',
    'audit_events'
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
        'covenant_child_org_scoped_all'
      ]
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_name, target_table);
      END LOOP;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
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
  END IF;

  IF to_regclass('public.organizations') IS NOT NULL THEN
    CREATE POLICY "org_scoped_all" ON public.organizations
      FOR ALL TO authenticated
      USING (public.is_current_org(id))
      WITH CHECK (public.is_current_org(id));
  END IF;

  IF to_regclass('public.clients') IS NOT NULL THEN
    CREATE POLICY "client_org_scoped_all" ON public.clients
      FOR ALL TO authenticated
      USING (public.is_current_org(org_id))
      WITH CHECK (public.is_current_org(org_id));
  END IF;

  IF to_regclass('public.org_settings') IS NOT NULL THEN
    CREATE POLICY "org_scoped_all" ON public.org_settings
      FOR ALL TO authenticated
      USING (public.is_current_org(org_id))
      WITH CHECK (public.is_current_org(org_id));
  END IF;

  IF to_regclass('public.custom_fields') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.custom_fields
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.client_settings') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.client_settings
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.transactions') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.transactions
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.contract_files') IS NOT NULL THEN
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
  END IF;

  IF to_regclass('public.covenants') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.covenants
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.covenant_annotations') IS NOT NULL THEN
    CREATE POLICY "covenant_child_org_scoped_all" ON public.covenant_annotations
      FOR ALL TO authenticated
      USING (public.covenant_in_current_org(covenant_id))
      WITH CHECK (public.covenant_in_current_org(covenant_id));
  END IF;

  IF to_regclass('public.financial_statements') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.financial_statements
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.loan_tapes') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.loan_tapes
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.monitoring_periods') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.monitoring_periods
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.document_requirements') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.document_requirements
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.monitoring_alerts') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.monitoring_alerts
      FOR ALL TO authenticated
      USING (public.client_in_current_org(client_id))
      WITH CHECK (public.client_in_current_org(client_id));
  END IF;

  IF to_regclass('public.audit_events') IS NOT NULL THEN
    CREATE POLICY "client_child_org_scoped_all" ON public.audit_events
      FOR ALL TO authenticated
      USING (client_id IS NOT NULL AND public.client_in_current_org(client_id))
      WITH CHECK (client_id IS NOT NULL AND public.client_in_current_org(client_id));
  END IF;
END $$;
