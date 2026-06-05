CREATE TABLE IF NOT EXISTS client_settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, key)
);

ALTER TABLE client_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all" ON client_settings;
CREATE POLICY "auth_all" ON client_settings
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);
