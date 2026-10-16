-- Guardrail agents: a confirmed Work Map answers AI agents (and people) asking "would the expert stop here?".
-- Additive only.

-- One key per connected agent, scoped to ONE confirmed Work Map. Only its SHA-256 is stored; it is shown once.
CREATE TABLE agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  work_map_id uuid NOT NULL REFERENCES work_maps(id),
  label text NOT NULL DEFAULT '',
  key_hash text NOT NULL UNIQUE,
  key_hint text NOT NULL,                 -- last 4 characters, to recognise a key in the list
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX agent_keys_map_idx ON agent_keys (org_id, work_map_id);

-- Every check an agent made: the verdict and the step, with the proposed action redacted and truncated.
CREATE TABLE agent_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  work_map_id uuid NOT NULL REFERENCES work_maps(id),
  agent_key_id uuid REFERENCES agent_keys(id),
  via text NOT NULL DEFAULT 'rest' CHECK (via IN ('rest','mcp','app')),
  action text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('STOP','ASK','PROCEED','NOT_COVERED','UNAVAILABLE')),
  step_id text,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_checks_map_idx ON agent_checks (org_id, work_map_id, created_at DESC);

ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_keys USING (org_id = app_org()) WITH CHECK (org_id = app_org());
CREATE POLICY tenant_isolation ON agent_checks USING (org_id = app_org()) WITH CHECK (org_id = app_org());
GRANT SELECT, INSERT, UPDATE ON agent_keys, agent_checks TO app_rw;
