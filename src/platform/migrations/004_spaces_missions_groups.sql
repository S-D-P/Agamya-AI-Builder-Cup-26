-- Personal + Enterprise spaces, groups, KT missions, notifications, invitations, storage reuse.
-- Additive only: no column or table is dropped, existing rows keep their meaning, every new column has a safe default.
-- A "space" remains an organizations row: experience 'living' = Agamya Personal, 'work' = Agamya Enterprise.

-- ============================================================ roles (widened, never narrowed)
-- ORG_OWNER manages the space itself (settings, membership, policies, who administers); KT_COORDINATOR runs missions;
-- AUDITOR is read-only for explicitly authorised records.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_roles_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_roles_check CHECK (
  roles <@ ARRAY['ORG_OWNER','ORG_ADMIN','KT_COORDINATOR','WORKFLOW_OWNER','EXPERT','LEARNER','REVIEWER','AUDITOR']::text[] AND cardinality(roles) > 0);
-- Existing spaces: the earliest administrator becomes the owner (ownership was implicit before).
UPDATE memberships m SET roles = array_append(m.roles, 'ORG_OWNER')
WHERE 'ORG_ADMIN' = ANY(m.roles) AND NOT ('ORG_OWNER' = ANY(m.roles)) AND m.status = 'active'
  AND m.user_id = (SELECT m2.user_id FROM memberships m2 WHERE m2.org_id = m.org_id AND 'ORG_ADMIN' = ANY(m2.roles) AND m2.status = 'active' ORDER BY m2.created_at, m2.user_id LIMIT 1);

-- ============================================================ invitations: explicit states
ALTER TABLE invitations
  ADD COLUMN status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid REFERENCES users(id);
UPDATE invitations SET status = 'accepted' WHERE accepted_at IS NOT NULL;
CREATE INDEX invitations_email_idx ON invitations (lower(email)) WHERE status = 'pending';

-- ============================================================ groups (application-level; no directory sync)
CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  created_by_person_id uuid REFERENCES people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX groups_name_uq ON groups (org_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL REFERENCES people(id),
  added_by uuid REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (group_id, person_id)
);
CREATE INDEX group_members_person_idx ON group_members (person_id) WHERE removed_at IS NULL;

-- Knowledge shared with groups (resolved at read time; membership removal revokes access immediately).
ALTER TABLE knowledge_artifacts ADD COLUMN shared_groups uuid[] NOT NULL DEFAULT '{}';

-- ============================================================ KT missions
CREATE TABLE kt_templates (               -- organisation-saved templates; built-in templates live in code
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  base_key text NOT NULL,
  config jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE kt_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid REFERENCES workflows(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 140),
  description text NOT NULL DEFAULT '',
  business_context text NOT NULL DEFAULT '',
  domain text NOT NULL DEFAULT '',
  template_key text NOT NULL DEFAULT 'general',
  template_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  coordinator_person_id uuid REFERENCES people(id),
  target_date date,
  language text NOT NULL DEFAULT 'en',
  -- explicit states only; the working stage (awaiting participants … transfer assessment) is derived from records
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','blocked','cancelled','completed','completed_with_exceptions')),
  brief jsonb NOT NULL DEFAULT '{}'::jsonb,
  brief_version int NOT NULL DEFAULT 1,
  brief_document_id uuid REFERENCES workflow_documents(id),
  brief_confirmed_at timestamptz,
  brief_confirmed_by uuid REFERENCES people(id),
  brief_confirmed_version int,
  capture_modalities text[] NOT NULL DEFAULT '{}',
  retention jsonb NOT NULL DEFAULT '{}'::jsonb,
  exception_note text,
  status_note text,
  invited_at timestamptz,
  completed_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kt_missions_org_idx ON kt_missions (org_id, created_at DESC);

CREATE TABLE mission_participants (
  mission_id uuid NOT NULL REFERENCES kt_missions(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL REFERENCES people(id),
  role text NOT NULL CHECK (role IN ('expert','receiver')),
  via_group_id uuid REFERENCES groups(id),          -- NULL = assigned individually
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','invited','accepted','declined','removed')),
  responded_at timestamptz,
  added_by uuid REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, person_id, role)
);
CREATE INDEX mission_participants_person_idx ON mission_participants (person_id);

CREATE TABLE mission_groups (
  mission_id uuid NOT NULL REFERENCES kt_missions(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  group_id uuid NOT NULL REFERENCES groups(id),
  resolved_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (mission_id, group_id)
);

CREATE TABLE mission_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES kt_missions(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('outcome','decision','blind_spot','question','acceptance')),
  text text NOT NULL,
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'unresolved' CHECK (status IN ('satisfied','partial','unresolved','not_applicable')),
  basis text NOT NULL DEFAULT 'NONE' CHECK (basis IN ('NONE','AI_VERIFIED','AI_INFERRED','PERSON')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{judgmentId, field, quote, verified}] or [{gapId}]
  explanation text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES people(id),
  decided_at timestamptz,
  position int NOT NULL DEFAULT 0,
  brief_version int NOT NULL DEFAULT 1,
  retired_at timestamptz,                            -- removed from the brief; kept for history
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_requirements_idx ON mission_requirements (mission_id, position);

ALTER TABLE expert_sessions ADD COLUMN mission_id uuid REFERENCES kt_missions(id);
CREATE INDEX expert_sessions_mission_idx ON expert_sessions (mission_id) WHERE mission_id IS NOT NULL;

-- ============================================================ notifications (in-app)
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  org_id uuid REFERENCES organizations(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ============================================================ storage reuse + derived cache
ALTER TABLE media_assets ADD COLUMN dedup_of uuid REFERENCES media_assets(id);   -- same bytes stored once per space
CREATE INDEX media_assets_sha_idx ON media_assets (org_id, sha256) WHERE deleted_at IS NULL;

CREATE TABLE derived_cache (
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  key_hash text NOT NULL,                  -- sha256 of (kind, input, language, model, sorted source versions)
  source_versions jsonb NOT NULL,          -- what it was derived from (authorisation context included in the key)
  language text,
  model text,
  payload jsonb NOT NULL,
  bytes int NOT NULL DEFAULT 0,
  hits int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_hit_at timestamptz,
  PRIMARY KEY (org_id, key_hash)
);

-- ============================================================ tenant isolation
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE kt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE kt_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE derived_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON groups USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON group_members USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON kt_templates USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON kt_missions USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON mission_participants USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON mission_groups USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON mission_requirements USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON derived_cache USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON groups, group_members, kt_templates, kt_missions, mission_participants, mission_groups, mission_requirements, derived_cache TO app_rw;
-- Notifications: any code inside a space may notify people of that space; only the recipient may read or mark them.
-- The cross-space inbox is read by platform code filtered by the signed-in user's id.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (org_id = app_org());
CREATE POLICY notifications_read ON notifications FOR SELECT USING (user_id = app_user());
CREATE POLICY notifications_update ON notifications FOR UPDATE USING (user_id = app_user());
GRANT SELECT, INSERT, UPDATE ON notifications TO app_rw;
-- Notifying someone else must not require reading their notifications (ON CONFLICT applies the SELECT policy), so inserts
-- go through this function: it only notifies an active member of the CURRENT space, and is idempotent per dedupe key.
CREATE OR REPLACE FUNCTION app_notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text, p_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH ins AS (
    INSERT INTO notifications (user_id, org_id, kind, title, body, link, dedupe_key)
    SELECT p_user, app_org(), p_kind, left(p_title, 200), left(p_body, 500), p_link, p_key
    WHERE app_org() IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = app_org() AND m.user_id = p_user AND m.status = 'active')
    ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM ins)
$$;
REVOKE ALL ON FUNCTION app_notify(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_notify(uuid, text, text, text, text, text) TO app_rw;
