-- Terminate a session; request access to knowledge. Additive only.

-- A session started by accident can be terminated by its expert. Terminated is final: a background job that finishes
-- later must never move the session back into another state, so the database enforces it.
ALTER TABLE expert_sessions DROP CONSTRAINT IF EXISTS expert_sessions_status_check;
ALTER TABLE expert_sessions ADD CONSTRAINT expert_sessions_status_check CHECK (status IN
  ('awaiting_consent','capturing','processing','analyzing','asking','extracting','validating','done','no_judgment','failed','mapping','debrief','mapped','terminated'));

CREATE OR REPLACE FUNCTION keep_terminated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'terminated' THEN NEW.status := 'terminated'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS expert_sessions_keep_terminated ON expert_sessions;
CREATE TRIGGER expert_sessions_keep_terminated BEFORE UPDATE ON expert_sessions FOR EACH ROW EXECUTE FUNCTION keep_terminated();

-- "Not shared with you" → ask for it. For one item (artifact_id) its contributor decides; a general request ("please
-- share something with me", artifact_id NULL) goes to the space's experts, who choose what to share. Nothing is shared
-- until someone with the right to share decides.
CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  artifact_id uuid REFERENCES knowledge_artifacts(id),
  requester_person_id uuid NOT NULL REFERENCES people(id),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','declined','withdrawn')),
  decided_by uuid REFERENCES people(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests (org_id, COALESCE(artifact_id, '00000000-0000-0000-0000-000000000000'::uuid), requester_person_id) WHERE status = 'pending';
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_requests USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON access_requests TO app_rw;
