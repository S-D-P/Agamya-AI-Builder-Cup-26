-- 001: core schema.
-- Conventions: uuid primary keys (gen_random_uuid), timestamptz everywhere, org_id on every tenant-owned row,
-- soft deletion (deleted_at) where users can delete and history matters, `version` for optimistic concurrency.

CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN CREATE ROLE app_rw NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN EXECUTE format('GRANT app_rw TO %I', current_user); EXCEPTION WHEN others THEN NULL; END $$;

CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ============================================================ identity (platform scope, not visible to app_rw)
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text,                       -- scrypt; NULL for SSO-only accounts
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE user_identities (            -- external identities (OIDC); password lives on users
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,   -- retention, AI budget, SSO domain
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,           -- sha256 of the opaque cookie token; the token itself is never stored
  csrf_hash text NOT NULL,
  active_org_id uuid REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- ============================================================ tenancy
CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  roles text[] NOT NULL CHECK (roles <@ ARRAY['ORG_ADMIN','WORKFLOW_OWNER','EXPERT','LEARNER','REVIEWER']::text[] AND cardinality(roles) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  roles text[] NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- People are the domain view of humans in an org (experts, learners). A person may or may not have a login.
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid REFERENCES users(id),
  display_name text NOT NULL,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

-- ============================================================ policy + consent
CREATE TABLE policy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),          -- NULL = platform default; an org may publish its own version
  policy_type text NOT NULL CHECK (policy_type IN ('TERMS_OF_SERVICE','PRIVACY_POLICY','AI_USAGE_POLICY','RECORDING_CONSENT_POLICY','ACCEPTABLE_USE_POLICY')),
  version text NOT NULL,
  title text NOT NULL,
  content_md text NOT NULL,
  content_sha256 text NOT NULL,
  is_template boolean NOT NULL DEFAULT true,          -- true = placeholder text, NOT legal advice
  required boolean NOT NULL DEFAULT true,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX policy_documents_uq ON policy_documents (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), policy_type, version);

CREATE TABLE policy_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  policy_document_id uuid NOT NULL REFERENCES policy_documents(id),
  policy_type text NOT NULL,
  policy_version text NOT NULL,
  content_sha256 text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent text,
  UNIQUE (org_id, user_id, policy_document_id)
);

-- ============================================================ workflows
CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  key text,                                          -- stable key for demo workflows (e.g. 'payments')
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('software','physical','document','hybrid')),
  modalities jsonb NOT NULL,                          -- {screen,camera,microphone,documents,app_events}
  capture_sources text[] NOT NULL DEFAULT '{}',
  owner_user_id uuid REFERENCES users(id),
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('demo','user')),
  profile jsonb,                                      -- Gemini's domain understanding (L3-ish, regenerable)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('learning','active','archived')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (org_id, key)
);
CREATE INDEX workflows_org_idx ON workflows (org_id) WHERE deleted_at IS NULL;

CREATE TABLE workflow_participants (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  person_id uuid NOT NULL REFERENCES people(id),
  participation text NOT NULL CHECK (participation IN ('EXPERT','LEARNER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, person_id, participation)
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid REFERENCES workflows(id),
  session_id uuid,                                   -- FK added after expert_sessions
  kind text NOT NULL CHECK (kind IN ('frame','audio_chunk','video_chunk','document','rendered_frame')),
  modality text NOT NULL CHECK (modality IN ('SCREEN','CAMERA','MICROPHONE','DOCUMENT','APP_EVENT','TEXT')),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  captured_at timestamptz,
  duration_ms int,
  consent_id uuid,
  retention_class text NOT NULL CHECK (retention_class IN ('raw_media','transcript','semantic','knowledge','audit')),
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','processed','failed','purged','deleted')),
  security_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX media_assets_idem_uq ON media_assets (org_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid), sha256, kind);
CREATE INDEX media_assets_session_idx ON media_assets (session_id, captured_at);
CREATE INDEX media_assets_expiry_idx ON media_assets (expires_at) WHERE status IN ('uploaded','processed');

CREATE TABLE workflow_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  title text NOT NULL,
  mime_type text NOT NULL,
  media_asset_id uuid REFERENCES media_assets(id),
  text_content text,                                -- bounded extracted text (untrusted external content)
  sha256 text NOT NULL,
  injection_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_procedures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  document_id uuid REFERENCES workflow_documents(id),
  key text NOT NULL,
  title text NOT NULL,
  applies_when text NOT NULL DEFAULT '',
  steps jsonb NOT NULL,
  default_decision text NOT NULL DEFAULT '',
  resolution_actions text[] NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK (source IN ('document','curated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, key)
);

-- ============================================================ capture
CREATE TABLE expert_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  expert_person_id uuid NOT NULL REFERENCES people(id),
  started_by uuid NOT NULL REFERENCES users(id),
  capture_source text NOT NULL,
  case_ref text,
  status text NOT NULL CHECK (status IN ('awaiting_consent','capturing','processing','analyzing','asking','extracting','validating','done','no_judgment','failed')),
  privacy jsonb NOT NULL,                            -- {paused, excluded:{SCREEN,CAMERA,MICROPHONE}, retainRaw}
  sim_state jsonb,
  procedure_id uuid REFERENCES workflow_procedures(id),
  detection jsonb,                                   -- bounded: labels + candidates for this episode
  gate jsonb,
  candidate jsonb,
  question jsonb,
  draft jsonb,
  judgment_id uuid,
  budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_clock_offset_ms int NOT NULL DEFAULT 0,
  obs_seq int NOT NULL DEFAULT 0,                    -- per-session observation sequence (ordering + short model aliases)
  last_error text,
  version int NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expert_sessions_wf_idx ON expert_sessions (org_id, workflow_id, started_at DESC);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_session_fk FOREIGN KEY (session_id) REFERENCES expert_sessions(id);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  modalities text[] NOT NULL,                        -- what the person agreed to be captured
  policy_document_id uuid REFERENCES policy_documents(id),
  policy_version text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_consent_fk FOREIGN KEY (consent_id) REFERENCES consent_records(id);

CREATE TABLE observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  seq int NOT NULL,
  modality text NOT NULL CHECK (modality IN ('SCREEN','CAMERA','MICROPHONE','DOCUMENT','APP_EVENT','TEXT')),
  source text NOT NULL,                             -- sim | live | voice | typed | narrated | upload
  captured_at timestamptz NOT NULL,
  text text NOT NULL DEFAULT '',                     -- L1 event text (bounded)
  structured jsonb,
  readings jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan jsonb,                                        -- context budget decision for this observation
  change_type text,
  confidence real,
  level smallint NOT NULL DEFAULT 1,
  dropped boolean NOT NULL DEFAULT false,
  media_asset_id uuid REFERENCES media_assets(id),
  linked_observation_id uuid REFERENCES observations(id),
  consent_id uuid REFERENCES consent_records(id),
  retention_class text NOT NULL DEFAULT 'semantic',
  security_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (session_id, seq)
);
CREATE INDEX observations_time_idx ON observations (session_id, captured_at);
CREATE UNIQUE INDEX observations_asset_uq ON observations (media_asset_id) WHERE media_asset_id IS NOT NULL;

CREATE TABLE transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  media_asset_id uuid REFERENCES media_assets(id),
  observation_id uuid REFERENCES observations(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  text text NOT NULL,
  confidence real,
  speaker_person_id uuid REFERENCES people(id),
  retention_class text NOT NULL DEFAULT 'transcript',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX transcript_segments_time_idx ON transcript_segments (session_id, start_at);

CREATE TABLE session_dialogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  seq int NOT NULL,
  question text NOT NULL,
  intent text NOT NULL,
  question_source text NOT NULL,
  answer text,
  answer_observation_id uuid REFERENCES observations(id),
  asked_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  UNIQUE (session_id, seq)
);

-- ============================================================ judgments + knowledge
CREATE TABLE judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  session_id uuid NOT NULL REFERENCES expert_sessions(id),
  expert_person_id uuid NOT NULL REFERENCES people(id),
  procedure_id uuid REFERENCES workflow_procedures(id),
  case_ref text,
  status text NOT NULL CHECK (status IN ('observed','approved','rejected')),
  current_version int NOT NULL DEFAULT 1,
  title text NOT NULL,
  extraction_source text NOT NULL,
  evidence_window tstzrange,                         -- temporal span of the evidence
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX judgments_wf_idx ON judgments (org_id, workflow_id, created_at DESC);
ALTER TABLE expert_sessions ADD CONSTRAINT expert_sessions_judgment_fk FOREIGN KEY (judgment_id) REFERENCES judgments(id);

CREATE TABLE judgment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  judgment_id uuid NOT NULL REFERENCES judgments(id),
  version int NOT NULL,
  content jsonb NOT NULL,          -- chain fields, each {value,status,quote,eventIds}, boundary, documentation separation
  verification jsonb NOT NULL,     -- what the deterministic validators changed and why
  author_type text NOT NULL CHECK (author_type IN ('ai','expert')),
  author_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (judgment_id, version)
);

CREATE TABLE judgment_evidence (
  org_id uuid NOT NULL REFERENCES organizations(id),
  judgment_id uuid NOT NULL REFERENCES judgments(id),
  observation_id uuid NOT NULL REFERENCES observations(id),
  role text NOT NULL CHECK (role IN ('trigger','moment_frame','expert_answer','context')),
  PRIMARY KEY (judgment_id, observation_id, role)
);

CREATE TABLE knowledge_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  judgment_id uuid NOT NULL UNIQUE REFERENCES judgments(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  current_version int NOT NULL DEFAULT 1,
  last_validated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_artifacts_wf_idx ON knowledge_artifacts (org_id, workflow_id) WHERE status = 'active';

CREATE TABLE knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  artifact_id uuid NOT NULL REFERENCES knowledge_artifacts(id),
  version int NOT NULL,
  judgment_version int NOT NULL,
  rule text NOT NULL,              -- L4
  compact jsonb NOT NULL,          -- L5 (retrieval payload)
  embedding vector(768),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version)
);
CREATE INDEX knowledge_versions_embedding_idx ON knowledge_versions USING hnsw (embedding vector_cosine_ops);

CREATE TABLE knowledge_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  artifact_id uuid NOT NULL REFERENCES knowledge_artifacts(id),
  knowledge_version int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXPERT_CONFIRMED','PEER_CONFIRMED','LEARNER_TRANSFER','LEARNER_BOUNDARY_PASS','LEARNER_OVERGENERALIZED','REVALIDATED','RETIRED')),
  actor_person_id uuid REFERENCES people(id),
  actor_user_id uuid REFERENCES users(id),
  ground_truth_source text CHECK (ground_truth_source IN ('EXPERT','REVIEWER','MODEL_DERIVED','SYNTHETIC')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_validations_artifact_idx ON knowledge_validations (artifact_id, created_at);

CREATE TABLE documentation_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  judgment_id uuid NOT NULL REFERENCES judgments(id),
  procedure_id uuid REFERENCES workflow_procedures(id),
  gap_type text NOT NULL CHECK (gap_type IN ('undocumented_exception','incomplete_procedure','obsolete_procedure','contradicts_procedure')),
  documented_procedure text NOT NULL,     -- copied from workflow_procedures, never written by the model
  observed_behavior text NOT NULL,
  expert_explanation text NOT NULL,
  analysis text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed','confirmed','dismissed')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expert_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  judgment_a uuid NOT NULL REFERENCES judgments(id),
  judgment_b uuid NOT NULL REFERENCES judgments(id),
  relation text NOT NULL CHECK (relation IN ('disagreement','compatible_refinement')),
  shared_situation text NOT NULL,
  hidden_variable text NOT NULL DEFAULT '',
  distinguishing_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  question text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text NOT NULL DEFAULT '',
  resolved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (judgment_a, judgment_b)
);

CREATE TABLE expert_conflict_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  conflict_id uuid NOT NULL REFERENCES expert_conflicts(id),
  person_id uuid NOT NULL REFERENCES people(id),
  answer text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ apprentice + evaluation
CREATE TABLE scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  judgment_id uuid REFERENCES judgments(id),
  case_ref text,                                    -- curated tests attach to a demo case
  curated_key text,
  kind text NOT NULL CHECK (kind IN ('apply','counterfactual')),
  title text NOT NULL,
  facts jsonb NOT NULL,
  narrative text NOT NULL,
  options jsonb NOT NULL,
  answer_key text NOT NULL,
  rule_action text,
  visual jsonb,
  source text NOT NULL CHECK (source IN ('curated','generated','expert_authored')),
  ground_truth_source text NOT NULL CHECK (ground_truth_source IN ('EXPERT','REVIEWER','MODEL_DERIVED','SYNTHETIC')),
  flipped_condition text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, curated_key)
);

CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  name text NOT NULL,
  hypothesis text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','closed')),
  retest_after_days int NOT NULL DEFAULT 14,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE experiment_arms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  experiment_id uuid NOT NULL REFERENCES experiments(id),
  key text NOT NULL CHECK (key IN ('SOP_ONLY','SOP_PLUS_JUDGMENT')),
  description text NOT NULL,
  UNIQUE (experiment_id, key)
);
CREATE TABLE experiment_assignments (
  org_id uuid NOT NULL REFERENCES organizations(id),
  experiment_id uuid NOT NULL REFERENCES experiments(id),
  person_id uuid NOT NULL REFERENCES people(id),
  arm_id uuid NOT NULL REFERENCES experiment_arms(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, person_id)
);

CREATE TABLE learner_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workflow_id uuid NOT NULL REFERENCES workflows(id),
  scenario_id uuid NOT NULL REFERENCES scenarios(id),
  judgment_id uuid NOT NULL REFERENCES judgments(id),
  learner_person_id uuid NOT NULL REFERENCES people(id),
  user_id uuid NOT NULL REFERENCES users(id),
  experiment_arm_id uuid REFERENCES experiment_arms(id),
  phase text NOT NULL DEFAULT 'immediate' CHECK (phase IN ('immediate','retest')),
  kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('deciding','reconsider','complete')),
  result jsonb,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX learner_attempts_idx ON learner_attempts (org_id, workflow_id, learner_person_id, created_at DESC);

CREATE TABLE learner_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  attempt_id uuid NOT NULL REFERENCES learner_attempts(id),
  seq int NOT NULL,
  type text NOT NULL CHECK (type IN ('decision','intervention')),
  choice text,
  reasoning text,
  correct boolean,
  level int,
  technique text,
  message text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, seq)
);

CREATE TABLE learner_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  attempt_id uuid NOT NULL REFERENCES learner_attempts(id),
  step_id uuid NOT NULL REFERENCES learner_steps(id),
  named_condition boolean NOT NULL,
  named_reason boolean NOT NULL,
  error_type text NOT NULL,
  boundary_understood boolean NOT NULL,
  feedback text NOT NULL DEFAULT '',
  evaluator text NOT NULL,                           -- 'gemini' | 'fallback' | 'human'
  ground_truth_source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ AI accounting, jobs, audit
CREATE TABLE ai_inferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  request_id text,
  session_id uuid,
  workflow_id uuid,
  op text NOT NULL,
  model text NOT NULL,
  pipeline text NOT NULL DEFAULT 'live',
  input_types text[] NOT NULL DEFAULT '{}',
  media_items int NOT NULL DEFAULT 0,
  media_resolution text,
  context_chars int NOT NULL DEFAULT 0,
  context_manifest jsonb,                           -- which context levels the budget manager supplied
  prompt_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  thought_tokens int NOT NULL DEFAULT 0,
  tokens_by_modality jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  latency_ms int NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('ok','error','skipped_budget')),
  error_category text,
  confidence real,
  result_summary text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_inferences_org_time_idx ON ai_inferences (org_id, created_at DESC);
CREATE INDEX ai_inferences_session_idx ON ai_inferences (session_id);

CREATE TABLE ai_usage_daily (             -- AIUsageRecord: rollup for budgets and dashboards (bounded size)
  org_id uuid NOT NULL REFERENCES organizations(id),
  day date NOT NULL,
  op text NOT NULL,
  calls int NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  image_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, day, op)
);

CREATE TABLE benchmark_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  model text NOT NULL,
  ground_truth_source text NOT NULL CHECK (ground_truth_source IN ('EXPERT','REVIEWER','MODEL_DERIVED','SYNTHETIC')),
  summary jsonb NOT NULL,
  rows jsonb NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 4,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, idempotency_key)
);
CREATE INDEX jobs_ready_idx ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX jobs_session_idx ON jobs ((payload->>'sessionId'), status);

CREATE TABLE audit_events (                -- append-only for the application role
  id bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  outcome text NOT NULL CHECK (outcome IN ('success','denied','error')),
  request_id text,
  ip_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time_idx ON audit_events (org_id, created_at DESC);

-- ============================================================ row-level security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','invitations','workspaces','people','policy_acceptances','workflows','workflow_participants',
    'media_assets','workflow_documents','workflow_procedures','expert_sessions','consent_records','observations','transcript_segments',
    'session_dialogue','judgments','judgment_versions','judgment_evidence','knowledge_artifacts','knowledge_versions','knowledge_validations',
    'documentation_conflicts','expert_conflicts','expert_conflict_answers','scenarios','experiments','experiment_arms','experiment_assignments',
    'learner_attempts','learner_steps','learner_evaluations','ai_usage_daily','jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;

-- Tables whose org_id may be NULL (platform rows) or that are read-mostly for tenants.
ALTER TABLE policy_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON policy_documents FOR SELECT USING (org_id IS NULL OR org_id = app_org());
ALTER TABLE ai_inferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_inferences USING (org_id = app_org()) WITH CHECK (org_id = app_org());
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_events FOR SELECT USING (org_id = app_org());
CREATE POLICY tenant_append ON audit_events FOR INSERT WITH CHECK (org_id = app_org());
ALTER TABLE benchmark_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON benchmark_runs FOR SELECT USING (org_id IS NULL OR org_id = app_org());
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_org ON organizations FOR SELECT USING (id = app_org());

-- Grants: the application role gets data access only through RLS; identity tables are not visible to it at all.
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
REVOKE ALL ON users, user_identities, auth_sessions, invitations, schema_migrations FROM app_rw;
REVOKE UPDATE, DELETE ON audit_events, ai_inferences, policy_documents, benchmark_runs, organizations FROM app_rw;
REVOKE INSERT ON organizations, policy_documents, benchmark_runs FROM app_rw;
REVOKE UPDATE, DELETE ON knowledge_validations, judgment_versions, policy_acceptances FROM app_rw;
