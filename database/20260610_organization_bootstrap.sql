-- Organization bootstrap support for OAuth users and first client creation.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS profiles_org_id_idx ON profiles(org_id);
CREATE INDEX IF NOT EXISTS clients_org_id_idx ON clients(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique_idx ON profiles(LOWER(email)) WHERE email IS NOT NULL AND email <> '';

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all" ON organizations;
CREATE POLICY "auth_all" ON organizations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
