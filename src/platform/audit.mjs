// Append-only audit trail. The application role can INSERT and SELECT (own org) but never UPDATE or DELETE.
export async function audit(q, { orgId, userId, action, targetType = null, targetId = null, outcome = "success", requestId = null, ipHash = null, metadata = {} }) {
  await q(
    `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, outcome, request_id, ip_hash, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId ?? null, userId ?? null, action, targetType, targetId ? String(targetId) : null, outcome, requestId, ipHash, JSON.stringify(metadata)],
  );
}
