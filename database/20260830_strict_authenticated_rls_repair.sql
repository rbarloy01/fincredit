-- Strict authenticated RLS repair for production.
-- Run this after older bootstrap migrations. It removes any lingering permissive
-- public-table policies, then recreates only the org-scoped approved-user rules.

DO $$
DECLARE
  target_table TEXT;
  existing_policy TEXT;
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

      FOR existing_policy IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = target_table
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', existing_policy, target_table);
      END LOOP;
    END IF;
  END LOOP;
END $$;

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
  USING (
    (document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    OR
    (financial_statement_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.financial_statements fs
      WHERE fs.id = financial_statement_id
        AND public.client_in_current_org(fs.client_id)
    ))
  )
  WITH CHECK (
    (document_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND public.is_current_org(d.org_id)
    ))
    OR
    (financial_statement_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.financial_statements fs
      WHERE fs.id = financial_statement_id
        AND public.client_in_current_org(fs.client_id)
    ))
  );

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
  USING (org_id IS NOT NULL AND public.is_current_org(org_id))
  WITH CHECK (org_id IS NOT NULL AND public.is_current_org(org_id));

CREATE POLICY "client_child_org_scoped_all" ON public.crm_contacts
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE POLICY "client_child_org_scoped_all" ON public.crm_activities
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));
