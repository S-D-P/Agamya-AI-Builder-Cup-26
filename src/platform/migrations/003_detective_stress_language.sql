-- Missing Knowledge Detective, Judgment Stress Test, language layer. Additive, safe defaults, backward compatible.

-- ============================================================ missing knowledge
-- A specific piece of knowledge an artifact needs but does not have, the question that would obtain it, and what
-- happened. Proposals from AI are never applied without the contributor's approval.
CREATE TABLE knowledge_gaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  judgment_id uuid NOT NULL REFERENCES judgments(id),
  kind text NOT NULL CHECK (kind IN ('prerequisite','signal','rationale','exception','contradiction','assumption','escalation','unexplained_action')),
  field text,                                         -- chain field it concerns, when there is one
  missing text NOT NULL,                              -- what is missing
  why_it_matters text NOT NULL,
  evidence_observation_ids uuid[] NOT NULL DEFAULT '{}',
  basis text NOT NULL CHECK (basis IN ('AI_INFERRED','RULE')),   -- proposed by the model, or by a deterministic rule
  question text NOT NULL,
  question_language text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','resolved','accepted_unresolved','deferred','not_applicable')),
  answer_text text,                                   -- the answer as it counts (typed, or a transcript the expert confirmed)
  answer_original text,                               -- machine transcript before the expert's correction, when spoken
  answer_language text,
  answer_source text CHECK (answer_source IN ('typed','voice','voice_corrected')),
  answered_by uuid REFERENCES people(id),
  answered_at timestamptz,
  proposal jsonb,                                     -- proposed change to the artifact (field, value, quote), pending approval
  proposal_source text,                               -- 'gemini' | 'fallback'
  applied_version int,                                -- judgment version created when the expert approved the change
  decided_by uuid REFERENCES people(id),
  decided_at timestamptz,
  decision_note text,
  dedupe_key text NOT NULL,                           -- idempotency: re-running detection never duplicates a gap
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (judgment_id, dedupe_key)
);
CREATE INDEX knowledge_gaps_judgment_idx ON knowledge_gaps (org_id, judgment_id, status);
ALTER TABLE knowledge_gaps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_gaps USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON knowledge_gaps TO app_rw;

-- ============================================================ judgment stress test
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_kind_check;
ALTER TABLE scenarios ADD CONSTRAINT scenarios_kind_check CHECK (kind IN ('apply','counterfactual','boundary','insufficient'));
-- Learners are only ever assessed against approved scenarios. Curated (designer-authored) tests are approved by
-- construction and labelled SYNTHETIC; generated ones start as drafts until the contributor approves them.
ALTER TABLE scenarios ADD COLUMN review_status text NOT NULL DEFAULT 'approved' CHECK (review_status IN ('draft','approved','rejected'));
ALTER TABLE scenarios ADD COLUMN criteria jsonb NOT NULL DEFAULT '[]'::jsonb;    -- decision criteria the reasoning should show
ALTER TABLE scenarios ADD COLUMN language text NOT NULL DEFAULT 'en';
UPDATE scenarios SET review_status = 'draft' WHERE source = 'generated' AND reviewed_at IS NULL;

-- ============================================================ language layer
ALTER TABLE users ADD COLUMN preferred_language text;                             -- interface + default content language
ALTER TABLE expert_sessions ADD COLUMN language text NOT NULL DEFAULT 'en';       -- language Agamya asks and records in
ALTER TABLE expert_sessions ADD COLUMN answer_draft jsonb;                        -- spoken answer awaiting the expert's check
ALTER TABLE session_dialogue ADD COLUMN question_language text;
ALTER TABLE session_dialogue ADD COLUMN answer_language text;
ALTER TABLE session_dialogue ADD COLUMN answer_original text;                     -- machine transcript before correction
ALTER TABLE session_dialogue ADD COLUMN answer_source text;                       -- typed | voice | voice_corrected

-- Criteria-based feedback for the stress test: which approved criteria the reasoning showed, and what it understood / missed.
ALTER TABLE learner_evaluations ADD COLUMN criteria_met jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE learner_evaluations ADD COLUMN understood text NOT NULL DEFAULT '';
ALTER TABLE learner_evaluations ADD COLUMN missing text NOT NULL DEFAULT '';
ALTER TABLE learner_evaluations ADD COLUMN language text NOT NULL DEFAULT 'en';
