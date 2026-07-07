-- CRM relationship layer: contacts, activities, tasks, and timeline source data

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

CREATE TABLE IF NOT EXISTS crm_contacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  title          TEXT DEFAULT '',
  department     TEXT DEFAULT '',
  email          TEXT DEFAULT '',
  phone          TEXT DEFAULT '',
  influence      TEXT NOT NULL DEFAULT 'medium' CHECK (influence IN ('low', 'medium', 'high', 'decision_maker')),
  relationship   TEXT NOT NULL DEFAULT 'neutral' CHECK (relationship IN ('champion', 'neutral', 'risk')),
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT DEFAULT '',
  created_by     UUID REFERENCES profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_activities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id     UUID REFERENCES crm_contacts(id) ON DELETE SET NULL,
  type           TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('call', 'meeting', 'email', 'task', 'note', 'review')),
  phase          TEXT DEFAULT '',
  record_type    TEXT DEFAULT '',
  next_stage     TEXT DEFAULT '',
  contact_name   TEXT DEFAULT '',
  analyst_name   TEXT DEFAULT '',
  subject        TEXT NOT NULL,
  quick_note     TEXT DEFAULT '',
  next_step      TEXT DEFAULT '',
  detail         TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'canceled')),
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  due_at         TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  owner_id       UUID REFERENCES profiles(id),
  created_by     UUID REFERENCES profiles(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "client_child_org_scoped_all" ON crm_contacts;
CREATE POLICY "client_child_org_scoped_all" ON crm_contacts
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

DROP POLICY IF EXISTS "client_child_org_scoped_all" ON crm_activities;
CREATE POLICY "client_child_org_scoped_all" ON crm_activities
  FOR ALL TO authenticated
  USING (public.client_in_current_org(client_id))
  WITH CHECK (public.client_in_current_org(client_id));

CREATE INDEX IF NOT EXISTS crm_contacts_client_id_idx ON crm_contacts(client_id);
CREATE INDEX IF NOT EXISTS crm_activities_client_id_due_at_idx ON crm_activities(client_id, due_at);
CREATE INDEX IF NOT EXISTS crm_activities_client_id_status_idx ON crm_activities(client_id, status);
