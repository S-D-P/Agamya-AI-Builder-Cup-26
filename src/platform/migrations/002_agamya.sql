-- Agamya: two experiences on one engine, knowledge governance, and knowledge-transfer plans.

-- A space is either a workplace ('work') or a family / community space ('living'). Same engine, different defaults and UI.
ALTER TABLE organizations ADD COLUMN experience text NOT NULL DEFAULT 'work' CHECK (experience IN ('work', 'living'));
-- Per-visitor sample spaces created from the public landing page (always is_demo = true).
ALTER TABLE organizations ADD COLUMN sample_kind text CHECK (sample_kind IN ('work', 'living'));
CREATE INDEX organizations_sample_idx ON organizations (created_at) WHERE sample_kind IS NOT NULL;

-- Knowledge governance. Consent to record is NOT consent to share: sharing is a separate, contributor-controlled choice.
--   private       only the contributor
--   named         the contributor and the people listed in shared_with
--   organization  everyone in the space (workplace default, disclosed before capture)
-- Public publication and use for AI model training are not offered: no column, no code path.
ALTER TABLE knowledge_artifacts
  ADD COLUMN contributor_person_id uuid REFERENCES people(id),
  ADD COLUMN visibility text NOT NULL DEFAULT 'organization' CHECK (visibility IN ('private', 'named', 'organization')),
  ADD COLUMN shared_with uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN restricted boolean NOT NULL DEFAULT false,
  ADD COLUMN restriction_note text NOT NULL DEFAULT '',
  ADD COLUMN attribution text NOT NULL DEFAULT '',
  ADD COLUMN craft_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN withdrawn_at timestamptz;
-- Restricted knowledge can only be shared with named people.
ALTER TABLE knowledge_artifacts ADD CONSTRAINT knowledge_restricted_scope CHECK (NOT (restricted AND visibility = 'organization'));
UPDATE knowledge_artifacts a SET contributor_person_id = j.expert_person_id FROM judgments j WHERE j.id = a.judgment_id AND a.contributor_person_id IS NULL;

-- Knowledge-transfer plans (Agamya for Work): a manager arranges for an expert to pass a workflow's judgment to a learner.
CREATE TABLE transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  expert_person_id uuid NOT NULL REFERENCES people(id),
  learner_person_id uuid NOT NULL REFERENCES people(id),
  scheduled_for timestamptz,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'closed')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expert_person_id <> learner_person_id)
);
CREATE INDEX transfers_org_idx ON transfers (org_id, created_at DESC);
ALTER TABLE expert_sessions ADD COLUMN transfer_id uuid REFERENCES transfers(id);
CREATE INDEX expert_sessions_transfer_idx ON expert_sessions (transfer_id) WHERE transfer_id IS NOT NULL;

ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transfers USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON transfers TO app_rw;
