// Groups: application-level sets of people inside one space (no directory or IAM synchronisation exists).
// Enterprise: owners, administrators and KT coordinators manage groups. Personal: any member creates groups and manages
// the ones they created (owners and administrators can manage all). Membership alone grants nothing: a group only gives
// access to what someone explicitly shared with it, or to missions it was explicitly assigned to (resolved at assignment).
import { requirePermission, can } from "../platform/authz.mjs";
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { notifyPerson } from "./notifications.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Active members of active groups, de-duplicated: Map(personId → [groupIds]). Never trusts client-supplied membership. */
export async function resolveGroupMembers(q, groupIds) {
  const ids = [...new Set((groupIds ?? []).filter((x) => UUID.test(String(x))))];
  if (!ids.length) return new Map();
  const rows = await q(`SELECT gm.group_id, gm.person_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
                        WHERE gm.group_id = ANY($1::uuid[]) AND gm.removed_at IS NULL AND g.archived_at IS NULL`, [ids]);
  const out = new Map();
  for (const r of rows) out.set(r.person_id, [...(out.get(r.person_id) ?? []), r.group_id]);
  return out;
}

export function createGroups({ db }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const experienceOf = async (q) => (await q("SELECT experience FROM organizations WHERE id = app_org()"))[0]?.experience ?? "work";
  const manager = (ctx) => ctx.roles.some((r) => ["ORG_OWNER", "ORG_ADMIN"].includes(r));

  function canManage(ctx, g, experience) {
    if (experience === "living") return manager(ctx) || g.created_by_person_id === ctx.personId;
    return can(ctx, "groups.manage");
  }
  async function load(q, ctx, id) {
    if (!UUID.test(String(id))) throw httpError(404, "group not found");
    const [g] = await q("SELECT * FROM groups WHERE id = $1 AND archived_at IS NULL", [id]);
    if (!g) throw httpError(404, "group not found");
    const experience = await experienceOf(q);
    const member = (await q("SELECT 1 FROM group_members WHERE group_id = $1 AND person_id = $2 AND removed_at IS NULL", [id, ctx.personId ?? null])).length > 0;
    const mayManage = canManage(ctx, g, experience);
    // Seeing a group (and its members) requires managing it or belonging to it.
    if (!mayManage && !member && !(experience === "work" && can(ctx, "mission.read.any"))) throw httpError(404, "group not found");
    return { g, experience, mayManage, member };
  }

  async function list(ctx) {
    requirePermission(ctx, "space.member");
    return T(ctx, async (q) => {
      const experience = await experienceOf(q);
      const rows = await q(`SELECT g.*, (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id AND gm.removed_at IS NULL) AS members,
                                   EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.person_id = $1 AND gm.removed_at IS NULL) AS is_member
                            FROM groups g WHERE g.archived_at IS NULL ORDER BY lower(g.name)`, [ctx.personId ?? null]);
      return {
        kind: experience === "living" ? "personal" : "enterprise",
        canCreate: experience === "living" ? true : can(ctx, "groups.manage"),
        groups: rows.filter((g) => canManage(ctx, g, experience) || g.is_member || (experience === "work" && can(ctx, "mission.read.any")))
          .map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.members, isMember: g.is_member, canManage: canManage(ctx, g, experience) })),
      };
    });
  }

  async function get(ctx, id) {
    requirePermission(ctx, "space.member");
    return T(ctx, async (q) => {
      const { g, mayManage, experience } = await load(q, ctx, id);
      const members = await q(`SELECT p.id, p.display_name, p.title, gm.added_at FROM group_members gm JOIN people p ON p.id = gm.person_id
                               WHERE gm.group_id = $1 AND gm.removed_at IS NULL ORDER BY p.display_name`, [g.id]);
      // What membership currently grants (so a manager understands the effect of adding someone). Titles only for managers.
      const missions = await q(`SELECT m.id, m.name FROM mission_groups mg JOIN kt_missions m ON m.id = mg.mission_id WHERE mg.group_id = $1 AND mg.removed_at IS NULL`, [g.id]);
      const [{ n: shared }] = await q("SELECT count(*)::int AS n FROM knowledge_artifacts WHERE status = 'active' AND visibility = 'named' AND $1 = ANY(shared_groups)", [g.id]);
      return {
        id: g.id, name: g.name, description: g.description, canManage: mayManage, kind: experience === "living" ? "personal" : "enterprise",
        members: members.map((m) => ({ id: m.id, name: m.display_name, title: m.title, addedAt: m.added_at })),
        grants: { sharedKnowledge: shared, missions: mayManage ? missions.map((m) => ({ id: m.id, name: m.name })) : [] },
        note: "Missions resolve group members when the group is assigned; later changes to the group do not change existing missions unless someone re-syncs them. Knowledge shared with the group follows current membership.",
      };
    });
  }

  async function create(ctx, { name, description = "" }, requestId) {
    requirePermission(ctx, "space.member");
    name = String(name ?? "").trim().slice(0, 80);
    if (!name) throw httpError(400, "give the group a name");
    return T(ctx, async (q) => {
      const experience = await experienceOf(q);
      if (experience === "work") requirePermission(ctx, "groups.manage");
      const [dup] = await q("SELECT 1 FROM groups WHERE lower(name) = lower($1) AND archived_at IS NULL", [name]);
      if (dup) throw httpError(409, "a group with this name already exists");
      const [g] = await q("INSERT INTO groups (org_id, name, description, created_by_person_id) VALUES ($1,$2,$3,$4) RETURNING id", [ctx.orgId, name, String(description).slice(0, 300), ctx.personId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "group.create", targetType: "group", targetId: g.id, requestId, metadata: { name } });
      return { id: g.id };
    });
  }

  async function update(ctx, id, { name, description, archive = false }, requestId) {
    requirePermission(ctx, "space.member");
    return T(ctx, async (q) => {
      const { g, mayManage } = await load(q, ctx, id);
      if (!mayManage) throw httpError(403, "you cannot manage this group");
      if (archive) {
        await q("UPDATE groups SET archived_at = now(), updated_at = now() WHERE id = $1", [g.id]);
        await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "group.archive", targetType: "group", targetId: g.id, requestId });
        return { archived: true };
      }
      const newName = name !== undefined ? String(name).trim().slice(0, 80) : g.name;
      if (!newName) throw httpError(400, "give the group a name");
      if (newName.toLowerCase() !== g.name.toLowerCase() && (await q("SELECT 1 FROM groups WHERE lower(name) = lower($1) AND archived_at IS NULL", [newName])).length) throw httpError(409, "a group with this name already exists");
      await q("UPDATE groups SET name = $2, description = $3, updated_at = now() WHERE id = $1", [g.id, newName, description !== undefined ? String(description).slice(0, 300) : g.description]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "group.update", targetType: "group", targetId: g.id, requestId, metadata: { from: g.name, to: newName } });
      return { id: g.id };
    });
  }

  async function addMembers(ctx, id, personIds, requestId) {
    requirePermission(ctx, "space.member");
    const ids = [...new Set((Array.isArray(personIds) ? personIds : []).filter((x) => UUID.test(String(x))))].slice(0, 200);
    if (!ids.length) throw httpError(400, "choose at least one person");
    return T(ctx, async (q) => {
      const { g, mayManage } = await load(q, ctx, id);
      if (!mayManage) throw httpError(403, "you cannot manage this group");
      const found = await q(`SELECT p.id FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active' WHERE p.id = ANY($1::uuid[])`, [ids]);
      if (found.length !== ids.length) throw httpError(400, "every member must already belong to this space");
      let added = 0;
      for (const pid of ids) {
        const r = await q(`INSERT INTO group_members (group_id, org_id, person_id, added_by) VALUES ($1,$2,$3,$4)
                           ON CONFLICT (group_id, person_id) DO UPDATE SET removed_at = NULL, added_by = EXCLUDED.added_by, added_at = now() WHERE group_members.removed_at IS NOT NULL RETURNING person_id`, [g.id, ctx.orgId, pid, ctx.userId]);
        if (r.length) {
          added++;
          await notifyPerson(q, { orgId: ctx.orgId, personId: pid, kind: "group.added", title: `You were added to the group "${g.name}"`, link: "#/groups", dedupeKey: `group:${g.id}:added:${pid}:${Math.floor(Date.now() / 3600000)}` });
        }
      }
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "group.members_add", targetType: "group", targetId: g.id, requestId, metadata: { personIds: ids, added } });
      return { added };
    });
  }

  async function removeMember(ctx, id, personId, requestId) {
    requirePermission(ctx, "space.member");
    return T(ctx, async (q) => {
      const { g, mayManage } = await load(q, ctx, id);
      // A member may always leave a group; otherwise only a manager removes people.
      if (!mayManage && personId !== ctx.personId) throw httpError(403, "you cannot manage this group");
      const r = await q("UPDATE group_members SET removed_at = now() WHERE group_id = $1 AND person_id = $2 AND removed_at IS NULL RETURNING person_id", [g.id, personId]);
      if (!r.length) throw httpError(404, "not a member");
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "group.members_remove", targetType: "group", targetId: g.id, requestId, metadata: { personId } });
      return { removed: true };
    });
  }

  return { list, get, create, update, addMembers, removeMember };
}
