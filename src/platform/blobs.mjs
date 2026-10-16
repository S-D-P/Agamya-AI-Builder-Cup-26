// Content-addressed reuse of stored media inside ONE space. Identical bytes (same SHA-256, same kind) uploaded again, in
// another session of the same space, reuse the stored object instead of writing a second copy. Each upload still gets its
// own media_assets row (its own session, consent, retention and deletion state), linked by dedup_of.
// Deleting or purging a row removes the stored object only when no other live row still references it, so one person
// deleting their moment never deletes another person's evidence, and a deleted moment's own row is always marked deleted.
// Never across spaces: object keys are namespaced by space and reuse is looked up under the space's row-level security.

export async function findReusable(q, { orgId, sha256, kind }) {
  const [hit] = await q(`SELECT id, storage_key FROM media_assets WHERE org_id = $1 AND sha256 = $2 AND kind = $3 AND status NOT IN ('purged','deleted') AND deleted_at IS NULL
                         ORDER BY created_at LIMIT 1`, [orgId, sha256, kind]);
  return hit ?? null;
}

/** Delete stored objects whose every row is purged or deleted. Call after marking the rows. */
export async function deleteUnreferenced(T, ctx, storage, keys) {
  let deleted = 0, kept = 0;
  for (const key of new Set(keys.filter(Boolean))) {
    const [live] = await T(ctx, (q) => q("SELECT 1 FROM media_assets WHERE storage_key = $1 AND status NOT IN ('purged','deleted') LIMIT 1", [key]));
    if (live) { kept++; continue; }
    await storage.delete(key);
    deleted++;
  }
  return { deleted, kept };
}
