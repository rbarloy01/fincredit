-- Adds data needed for the three new "Reporte de Monitoreo" sections that have
-- no existing data model: structured eligibility criteria (evaluated against
-- loan-tape concentration metrics), manual fiscal/buró de crédito status, and
-- free-text operations notes alongside the existing Cobranza block.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS eligibility_criteria JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS fiscal_buro_status   JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS operations_notes     TEXT DEFAULT '';
