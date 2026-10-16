-- Live Moti (Gemini Live), Work Maps and live tutoring. Additive only.

-- Session states for the live flow: capturing (live conversation) → mapping (building the Work Map) → debrief
-- (short spoken debrief + teach-back) → mapped (expert confirmed). Existing states are unchanged.
ALTER TABLE expert_sessions DROP CONSTRAINT IF EXISTS expert_sessions_status_check;
ALTER TABLE expert_sessions ADD CONSTRAINT expert_sessions_status_check CHECK (status IN
  ('awaiting_consent','capturing','processing','analyzing','asking','extracting','validating','done','no_judgment','failed','mapping','debrief','mapped'));
ALTER TABLE expert_sessions
  ADD COLUMN mode text NOT NULL DEFAULT 'classic' CHECK (mode IN ('classic','live')),
  ADD COLUMN off_record jsonb NOT NULL DEFAULT '[]'::jsonb;      -- [{from, to}] periods the expert took off the record (nothing captured)

-- The Work Map: every step with its screen moment, decision, reason in the expert's words, and guardrails.
-- Stored in English (the shared base); the expert's original speech remains in the recording for its retention period.
CREATE TABLE work_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  expert_person_id uuid NOT NULL REFERENCES people(id),
  version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','debriefed','confirmed','withdrawn')),
  title text NOT NULL DEFAULT '',
  map jsonb NOT NULL,                     -- {steps:[...], guardrails:[...]} (see src/ai/ops/workmap.mjs)
  unclear jsonb NOT NULL DEFAULT '[]'::jsonb,
  teach_back text,
  source_language text NOT NULL DEFAULT 'en',
  visibility text NOT NULL DEFAULT 'organization' CHECK (visibility IN ('private','named','organization')),
  shared_with uuid[] NOT NULL DEFAULT '{}',
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id)
);
CREATE INDEX work_maps_wf_idx ON work_maps (org_id, workflow_id, created_at DESC);

-- A new hire practising on their own screen with Moti as tutor.
CREATE TABLE tutor_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  work_map_id uuid NOT NULL REFERENCES work_maps(id),
  learner_person_id uuid NOT NULL REFERENCES people(id),
  language text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done')),
  interventions jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{at, stepId, guardrail, said}]
  result jsonb,                                       -- {mastered:[stepIds], practise:[stepIds], summary}
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

ALTER TABLE work_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tutor_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_maps USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON tutor_runs USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON work_maps, tutor_runs TO app_rw;
