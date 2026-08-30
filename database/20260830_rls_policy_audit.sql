-- RLS policy audit for FinMonitor production.
-- Run this in Supabase SQL Editor after the strict repair migration. It returns
-- the policies that remain on the sensitive tables and should show only the
-- strict org-scoped policies from 20260830_strict_authenticated_rls_repair.sql.

SELECT
  schemaname,
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'profiles',
    'organizations',
    'clients',
    'financial_statements',
    'loan_tapes',
    'documents',
    'extraction_review_items'
  )
ORDER BY tablename, policyname;

SELECT
  n.nspname AS schemaname,
  c.relname AS tablename,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'profiles',
    'organizations',
    'clients',
    'financial_statements',
    'loan_tapes',
    'documents',
    'extraction_review_items'
  )
ORDER BY c.relname;
