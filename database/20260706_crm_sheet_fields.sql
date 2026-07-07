-- Align CRM activities with the operating tracker sheet columns.

ALTER TABLE crm_activities
  ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS record_type TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_stage TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS analyst_name TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS quick_note TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS next_step TEXT DEFAULT '';
