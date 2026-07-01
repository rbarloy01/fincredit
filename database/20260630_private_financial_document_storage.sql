-- Private financial source-file storage.
-- Run after database/20260626_document_ai_ingestion.sql.

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

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE financial_statements
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE loan_tapes
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

ALTER TABLE contract_files
  ADD COLUMN IF NOT EXISTS source_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_storage_idx ON documents(storage_bucket, storage_path);
CREATE INDEX IF NOT EXISTS financial_statements_source_document_idx ON financial_statements(source_document_id);
CREATE INDEX IF NOT EXISTS loan_tapes_source_document_idx ON loan_tapes(source_document_id);
CREATE INDEX IF NOT EXISTS contract_files_source_document_idx ON contract_files(source_document_id);

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
