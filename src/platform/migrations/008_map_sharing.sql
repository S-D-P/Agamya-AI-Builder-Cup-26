-- Sharing Work Maps like any other knowledge: with everyone in the space, with groups, or with named people.
-- Additive only.
ALTER TABLE work_maps ADD COLUMN shared_groups uuid[] NOT NULL DEFAULT '{}';
-- Whether the owner has made a sharing choice yet (the "who should learn from this?" step after confirming).
ALTER TABLE work_maps ADD COLUMN sharing_chosen_at timestamptz;

-- Access requests can be for a Work Map as well as for a knowledge item.
ALTER TABLE access_requests ADD COLUMN work_map_id uuid REFERENCES work_maps(id);
DROP INDEX IF EXISTS access_requests_one_pending;
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests (org_id,
  COALESCE(artifact_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(work_map_id, '00000000-0000-0000-0000-000000000000'::uuid),
  requester_person_id) WHERE status = 'pending';
