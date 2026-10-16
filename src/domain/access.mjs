// Access requests: the way out of "not shared with you".
//   One item: the requester asks; only that knowledge's contributor can grant (adds the requester to its named sharing)
//   or decline. A general request ("please share something with me") goes to the space's experts; each chooses which of
//   their own knowledge to share. Requests never reveal private titles to the requester, and nothing is shared until a
//   person with the right to share decides. Every decision is audited and the requester is told the outcome.
import { requirePermission } from "../platform/authz.mjs";
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { notifyPerson } from "./notifications.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAccess({ db }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const nameOf = async (q, personId) => (await q("SELECT display_name FROM people WHERE id = $1", [personId]))[0]?.display_name ?? "Someone";

  const MANAGERS = ["ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR"];
  const isManager = (ctx) => Boolean(ctx.roles?.some((r) => MANAGERS.includes(r)));
  const managersOf = async (q, exclude) => (await q(`SELECT p.id FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id
                                                     WHERE m.status = 'active' AND m.roles && $1::text[] AND p.id <> $2`, [MANAGERS, exclude])).map((r) => r.id);

  async function request(ctx, { artifactId = null, workMapId = null, note = "" } = {}) {
    requirePermission(ctx, "workflow.read");
    if (!ctx.personId) throw httpError(403, "join this space first");
    if (artifactId && !UUID.test(String(artifactId))) throw httpError(404, "knowledge not found");
    if (workMapId && !UUID.test(String(workMapId))) throw httpError(404, "work map not found");
    return T(ctx, async (q) => {
      const who = await nameOf(q, ctx.personId);
      let owners = [];
      if (workMapId) {
        const [m] = await q("SELECT id, title, status, visibility, shared_with, expert_person_id FROM work_maps WHERE id = $1", [workMapId]);
        if (!m || m.status !== "confirmed") throw httpError(404, "work map not found");
        if (m.expert_person_id === ctx.personId) throw httpError(409, "this is your own Work Map");
        if (m.visibility === "organization" || (m.shared_with ?? []).includes(ctx.personId) || isManager(ctx)) throw httpError(409, "you can already open this Work Map");
        // The expert decides; space admins and coordinators can decide too.
        owners = [...new Set([m.expert_person_id, ...(await managersOf(q, ctx.personId))])];
      } else if (artifactId) {
        const [a] = await q("SELECT id, contributor_person_id, status, visibility, shared_with FROM knowledge_artifacts WHERE id = $1", [artifactId]);
        if (!a || a.status !== "active") throw httpError(404, "knowledge not found");
        if (a.contributor_person_id === ctx.personId) throw httpError(409, "this is your own knowledge");
        if (a.visibility === "organization" || (a.shared_with ?? []).includes(ctx.personId)) throw httpError(409, "this is already shared with you");
        owners = [a.contributor_person_id];
      } else {
        owners = (await q(`SELECT p.id FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id
                           WHERE m.status = 'active' AND 'EXPERT' = ANY(m.roles) AND p.id <> $1`, [ctx.personId])).map((r) => r.id);
        if (!owners.length) throw httpError(409, "there is no teacher or expert in this space yet");
      }
      const [existing] = await q("SELECT id FROM access_requests WHERE requester_person_id = $1 AND status = 'pending' AND artifact_id IS NOT DISTINCT FROM $2 AND work_map_id IS NOT DISTINCT FROM $3",
        [ctx.personId, artifactId, workMapId]);
      if (existing) return { id: existing.id, status: "pending", alreadyRequested: true };
      const [r] = await q("INSERT INTO access_requests (org_id, artifact_id, work_map_id, requester_person_id, note) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [ctx.orgId, artifactId, workMapId, ctx.personId, String(note).trim().slice(0, 500)]);
      for (const o of owners) {
        await notifyPerson(q, { orgId: ctx.orgId, personId: o, kind: "access.request", link: "#/inbox", dedupeKey: `access:${r.id}:${o}`,
          title: workMapId ? `${who} asked to open a Work Map` : artifactId ? `${who} asked to see one of your pieces of knowledge` : `${who} would like to learn from you`,
          body: note ? String(note).slice(0, 200) : "Open your inbox to share or decline." });
      }
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "access.request", targetType: workMapId ? "work_map" : artifactId ? "knowledge_artifact" : "space", targetId: workMapId ?? artifactId, requestId: ctx.requestId });
      return { id: r.id, status: "pending" };
    });
  }

  /** Requests I can decide (incoming) and my own (outgoing). Incoming items show their titles only to their contributor. */
  async function list(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const expert = ctx.roles?.includes("EXPERT");
      const incoming = await q(`SELECT r.id, r.artifact_id, r.work_map_id, r.note, r.created_at, p.display_name AS requester, COALESCE(a.title, w.title) AS title
                                FROM access_requests r JOIN people p ON p.id = r.requester_person_id LEFT JOIN knowledge_artifacts a ON a.id = r.artifact_id
                                LEFT JOIN work_maps w ON w.id = r.work_map_id
                                WHERE r.status = 'pending' AND r.requester_person_id <> $1
                                  AND ((r.artifact_id IS NOT NULL AND a.contributor_person_id = $1)
                                    OR (r.work_map_id IS NOT NULL AND (w.expert_person_id = $1 OR $3::boolean))
                                    OR (r.artifact_id IS NULL AND r.work_map_id IS NULL AND ($2::boolean OR $3::boolean)))
                                ORDER BY r.created_at`, [ctx.personId, Boolean(expert), isManager(ctx)]);
      const myMaps = await q(`SELECT id, title FROM work_maps WHERE status = 'confirmed' AND ${isManager(ctx) ? "TRUE" : "expert_person_id = $1"} ORDER BY confirmed_at DESC LIMIT 50`, isManager(ctx) ? [] : [ctx.personId]);
      const mine = await q(`SELECT id, title, visibility FROM knowledge_artifacts WHERE contributor_person_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 50`, [ctx.personId]);
      const outgoing = await q(`SELECT r.id, r.artifact_id, r.work_map_id, r.status, r.created_at, r.decided_at FROM access_requests r WHERE r.requester_person_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [ctx.personId]);
      return {
        incoming: incoming.map((r) => ({ id: r.id, requester: r.requester, note: r.note, createdAt: r.created_at,
          item: r.artifact_id ? { id: r.artifact_id, title: r.title, kind: "knowledge" } : r.work_map_id ? { id: r.work_map_id, title: r.title, kind: "workmap" } : null })),
        myKnowledge: [...myMaps.map((m) => ({ id: `wm:${m.id}`, title: `Work Map: ${m.title}` })), ...mine.map((m) => ({ id: m.id, title: m.title, visibility: m.visibility }))],
        outgoing: outgoing.map((r) => ({ id: r.id, artifactId: r.artifact_id, workMapId: r.work_map_id, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at })),
      };
    });
  }

  /** Grant (share the item, or the chosen items of mine for a general request) or decline. */
  async function decide(ctx, id, { grant, artifactIds = [] } = {}) {
    requirePermission(ctx, "workflow.read");
    if (!UUID.test(String(id))) throw httpError(404, "request not found");
    return T(ctx, async (q) => {
      const [r] = await q("SELECT * FROM access_requests WHERE id = $1", [id]);
      if (!r || r.status !== "pending") throw httpError(404, "request not found");
      let targets = [], mapTargets = [];
      const addTo = async (ids) => q(`UPDATE work_maps SET visibility = CASE WHEN visibility = 'private' THEN 'named' ELSE visibility END,
                 shared_with = CASE WHEN visibility = 'organization' OR $2 = ANY(shared_with) THEN shared_with ELSE array_append(shared_with, $2) END, sharing_chosen_at = COALESCE(sharing_chosen_at, now()), updated_at = now()
               WHERE id = ANY($1::uuid[]) AND status = 'confirmed'`, [ids, r.requester_person_id]);
      if (r.work_map_id) {
        const [m] = await q("SELECT id, expert_person_id FROM work_maps WHERE id = $1", [r.work_map_id]);
        if (!m || (m.expert_person_id !== ctx.personId && !isManager(ctx))) throw httpError(403, "only the expert who recorded this Work Map, or a space admin or coordinator, can decide");
        mapTargets = [m.id];
      } else if (r.artifact_id) {
        const [a] = await q("SELECT id, contributor_person_id FROM knowledge_artifacts WHERE id = $1", [r.artifact_id]);
        if (a?.contributor_person_id !== ctx.personId) throw httpError(403, "only the person who contributed this knowledge can decide");
        targets = [a.id];
      } else {
        if (!ctx.roles?.includes("EXPERT") && !isManager(ctx)) throw httpError(403, "only experts, teachers, admins and coordinators in this space can answer this");
        if (grant) {
          const all = Array.isArray(artifactIds) ? artifactIds.map(String) : [];
          const ids = all.filter((x) => UUID.test(x)).slice(0, 50);
          const mapIds = all.filter((x) => x.startsWith("wm:")).map((x) => x.slice(3)).filter((x) => UUID.test(x)).slice(0, 50);
          targets = (await q("SELECT id FROM knowledge_artifacts WHERE id = ANY($1::uuid[]) AND contributor_person_id = $2 AND status = 'active'", [ids, ctx.personId])).map((x) => x.id);
          mapTargets = (await q(`SELECT id FROM work_maps WHERE id = ANY($1::uuid[]) AND status = 'confirmed' AND ${isManager(ctx) ? "TRUE" : "expert_person_id = $2"}`, isManager(ctx) ? [mapIds] : [mapIds, ctx.personId])).map((x) => x.id);
          if (!targets.length && !mapTargets.length) throw httpError(400, "choose at least one thing to share");
        }
      }
      if (grant && mapTargets.length) await addTo(mapTargets);
      if (grant && targets.length) {
        // Private → shared with this person by name; named → this person added; organization-wide → already visible.
        await q(`UPDATE knowledge_artifacts SET visibility = CASE WHEN visibility = 'private' THEN 'named' ELSE visibility END,
                   shared_with = CASE WHEN visibility = 'organization' OR $2 = ANY(shared_with) THEN shared_with ELSE array_append(shared_with, $2) END, updated_at = now()
                 WHERE id = ANY($1::uuid[]) AND contributor_person_id = $3`, [targets, r.requester_person_id, ctx.personId]);
      }
      await q("UPDATE access_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [r.id, grant ? "granted" : "declined", ctx.personId]);
      const who = await nameOf(q, ctx.personId);
      const shared = targets.length + mapTargets.length;
      await notifyPerson(q, { orgId: ctx.orgId, personId: r.requester_person_id, kind: "access.decision", link: grant ? "#/learn" : "#/inbox", dedupeKey: `access-decided:${r.id}`,
        title: grant ? `${who} shared ${shared === 1 ? "something" : `${shared} things`} with you` : `${who} declined your request`,
        body: grant ? "It is now in your Learning page." : "You can ask again later or ask someone else." });
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: grant ? "access.grant" : "access.decline", targetType: "access_request", targetId: r.id, requestId: ctx.requestId, metadata: { shared: targets.length + mapTargets.length } });
      return { status: grant ? "granted" : "declined", shared: targets.length + mapTargets.length };
    });
  }

  return { request, list, decide };
}
