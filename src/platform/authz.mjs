// Server-side authorization. Identity (who you are) is resolved by identity.mjs; this module decides what you may do.
// Roles are per-organization memberships. Never derived from client input.
import { httpError } from "./security.mjs";

export const ROLES = ["ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR", "WORKFLOW_OWNER", "EXPERT", "LEARNER", "REVIEWER", "AUDITOR"];
/** Roles that only the space owner may grant or remove (ownership is distinct from day-to-day administration). */
export const OWNER_GRANTED = ["ORG_OWNER", "ORG_ADMIN"];
/** Roles a KT coordinator may invite people into (subject matter experts and receivers only). */
export const COORDINATOR_INVITABLE = ["EXPERT", "LEARNER"];

const OWN = "ORG_OWNER", A = "ORG_ADMIN", C = "KT_COORDINATOR", O = "WORKFLOW_OWNER", E = "EXPERT", L = "LEARNER", R = "REVIEWER", AU = "AUDITOR";
export const PERMISSIONS = {
  "org.manage": [OWN, A],
  "members.manage": [OWN, A],
  "members.invite": [OWN, A, C],      // coordinators: experts and receivers only (checked in the service)
  "policy.manage": [OWN, A],
  "audit.read": [OWN, A, R, AU],
  "workflow.read": [OWN, A, C, O, E, L, R, AU],
  "workflow.create": [A, C, O],
  "workflow.manage": [A, C, O],
  "session.capture": [E, O],
  "session.read.any": [A, O, R],
  "session.read.own": [E],
  "evidence.read": [A, O, R, E],
  "knowledge.read": [A, O, R, E],
  "knowledge.validate": [E, O],       // plus: must be the person the judgment belongs to (checked in service)
  "knowledge.peer_confirm": [E],      // plus: must NOT be the authoring expert
  "conflict.answer": [E, O],
  "conflict.decide": [E, O, A],
  "scenario.review": [E, R, O],
  "learn.attempt": [L, O, A],
  "attempt.read.any": [A, O, R],
  "analytics.read": [OWN, A, C, O, R, AU],
  "ai.cost.read": [OWN, A, O, R, AU],
  "experiment.manage": [A, O],
  "retention.manage": [OWN, A],
  "mission.create": [A, C],
  "mission.manage.any": [A],          // coordinators manage the missions they coordinate (checked in the service)
  "mission.read.any": [OWN, A, AU],   // participants and the coordinator read their own missions (checked in the service)
  "groups.manage": [OWN, A, C],       // in Personal spaces any member manages the groups they created (checked in the service)
  "space.member": [OWN, A, C, O, E, L, R, AU],
};

export function can(ctx, permission) {
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`unknown permission ${permission}`);
  return Boolean(ctx?.roles?.some((r) => allowed.includes(r)));
}

export function requirePermission(ctx, permission) {
  if (!ctx?.userId) throw httpError(401, "sign in required");
  if (!ctx.orgId) throw httpError(403, "no active organization");
  if (!can(ctx, permission)) throw httpError(403, `missing permission: ${permission}`, { permission });
}

/** Resource-level check for things owned by a person (sessions, attempts). */
export function requireOwnOrAny(ctx, ownerPersonId, ownPerm, anyPerm) {
  if (can(ctx, anyPerm)) return;
  if (can(ctx, ownPerm) && ctx.personId && ctx.personId === ownerPersonId) return;
  throw httpError(403, "not allowed to access this resource");
}
