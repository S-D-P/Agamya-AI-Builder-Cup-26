// Knowledge layer: judgments (per-session claims with versions) → knowledge artifacts (org-level, versioned,
// validated, retrievable). Truth model: status comes from evidence and human validation, never from model confidence.
import { requirePermission, can } from "../platform/authz.mjs";
import { deleteUnreferenced } from "../platform/blobs.mjs";
import { notifyAssessmentReady } from "./missions.mjs";
import { httpError } from "../platform/security.mjs";
import { enqueue } from "../platform/jobs.mjs";
import { audit } from "../platform/audit.mjs";
import { assertUpdated } from "../platform/db.mjs";
import { embed, withAiContext } from "../ai/gemini.mjs";
import { toRule } from "../ai/context.mjs";
import { CHAIN_FIELDS } from "../ai/validators.mjs";
import { reconcileExperts } from "../ai/ops/judgment.mjs";

export const STALE_DAYS = Number(process.env.STALE_DAYS || 180);
const EDITABLE = ["title", ...CHAIN_FIELDS];

/**
 * Knowledge levels (badges), computed from facts in the database:
 *   OBSERVED                extracted, not yet approved by its expert
 *   EXPERT_CONFIRMED        approved by the expert who taught it
 *   MULTI_EXPERT_CONFIRMED  confirmed by ≥2 different experts
 *   LEARNER_VALIDATED       ≥1 successful transfer AND ≥1 counterfactual boundary pass
 *   CONFLICTED              an open expert disagreement involves it
 *   STALE                   not validated for STALE_DAYS
 *   INSUFFICIENT_EVIDENCE   decision, reason or condition lacks evidence: cannot be safely applied
 */
export function levelsOf({ status, validations = [], openConflicts = 0, lastValidatedAt, fields }) {
  if (status === "rejected") return { primary: "REJECTED", badges: ["REJECTED"] };
  const badges = [];
  const confirmers = new Set(validations.filter((v) => ["EXPERT_CONFIRMED", "PEER_CONFIRMED"].includes(v.kind)).map((v) => v.actor_person_id));
  if (status !== "approved") badges.push("OBSERVED");
  else badges.push(confirmers.size >= 2 ? "MULTI_EXPERT_CONFIRMED" : "EXPERT_CONFIRMED");
  if (validations.some((v) => v.kind === "LEARNER_TRANSFER") && validations.some((v) => v.kind === "LEARNER_BOUNDARY_PASS")) badges.push("LEARNER_VALIDATED");
  if (openConflicts) badges.push("CONFLICTED");
  if (status === "approved" && lastValidatedAt && Date.now() - new Date(lastValidatedAt).getTime() > STALE_DAYS * 86400000) badges.push("STALE");
  if (fields && ["decision", "reason", "condition"].some((f) => fields[f]?.status === "INSUFFICIENT_EVIDENCE")) badges.push("INSUFFICIENT_EVIDENCE");
  const order = ["CONFLICTED", "INSUFFICIENT_EVIDENCE", "STALE", "LEARNER_VALIDATED", "MULTI_EXPERT_CONFIRMED", "EXPERT_CONFIRMED", "OBSERVED"];
  return { primary: order.find((o) => badges.includes(o)), badges };
}

export function compactFor(content) {
  const f = content.fields;
  return {
    rule: content.rule, decision: f.decision.value, reason: f.reason.value, condition: f.condition.value, exception: f.exception.value,
    boundary: content.boundary?.boundaryCondition ?? f.boundary.value, default: content.boundary?.default ?? null, observation: f.observation.value, risk: f.risk.value,
    quotes: CHAIN_FIELDS.map((k) => f[k].quote).filter(Boolean).slice(0, 4),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const VISIBILITY = ["private", "named", "organization"];

/**
 * Who may see a judgment and its knowledge, as one SQL predicate used by every read path (lists, detail, lessons,
 * attempts, scenario visuals, AI retrieval). RLS already confines everything to the space; this adds the contributor's
 * sharing choice inside the space:
 *   - the contributor (the expert / teacher who taught it) always;
 *   - approved, active knowledge: everyone if 'organization', listed people if 'named', nobody else if 'private';
 *   - not-yet-approved or rejected judgments: reviewers in a workplace (to supervise capture), never in a living space.
 * personId is server-derived; it is validated and inlined so the predicate composes with any parameter list.
 */
export function visibleSql(viewer, j = "j", a = "a") {
  const me = viewer.personId && UUID.test(viewer.personId) ? `'${viewer.personId}'::uuid` : "NULL::uuid";
  // Shared with a group: resolved now, from active membership of a non-archived group (removal revokes immediately).
  const viaGroup = `EXISTS (SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id AND g.archived_at IS NULL
                     WHERE gm.person_id = ${me} AND gm.removed_at IS NULL AND gm.group_id = ANY(${a}.shared_groups))`;
  const shared = `(${a}.id IS NOT NULL AND ${a}.status = 'active' AND (${a}.visibility = 'organization' OR (${a}.visibility = 'named' AND (${me} = ANY(${a}.shared_with) OR ${viaGroup}))))`;
  return `(${j}.expert_person_id = ${me} OR ${shared}${viewer.reviewer ? ` OR (${a}.id IS NULL)` : ""})`;
}

/** The viewer's governance-relevant facts inside a tenant transaction. */
export async function viewerOf(q, ctx) {
  const [o] = await q("SELECT experience FROM organizations WHERE id = app_org()");
  const experience = o?.experience ?? "work";
  return { personId: ctx.personId ?? null, experience, reviewer: experience === "work" && can(ctx, "session.read.any") };
}

/** Knowledge used as AI context for someone's session: theirs, or shared with the whole space. Never another person's private knowledge. */
const aiUsableSql = (forPersonId, j = "j", a = "a") =>
  `(${a}.visibility = 'organization' ${forPersonId && UUID.test(forPersonId) ? `OR ${j}.expert_person_id = '${forPersonId}'::uuid` : ""})`;

/** Open questions an honest artifact must show: what is inferred, unconfirmed, contested or missing. */
export function unresolvedOf(content, { conflicts = [], docConflicts = [], expertName = "the expert" } = {}) {
  const label = { context: "the situation", observation: "the signal to watch", decision: "the decision", reason: "the reason", condition: "when it applies", exception: "the exception", boundary: "what flips the decision", risk: "the risk", expectedOutcome: "the expected outcome" };
  const out = [];
  for (const [k, f] of Object.entries(content.fields ?? {})) {
    if (f?.status === "AI_INFERRED") out.push(`${label[k] ?? k} was inferred by AI, not stated by ${expertName}`);
    if (f?.status === "INSUFFICIENT_EVIDENCE") out.push(`No evidence yet for ${label[k] ?? k}`);
  }
  if (content.boundary && content.boundary.status !== "confirmed") out.push("When this stops applying has not been confirmed");
  for (const c of conflicts.filter((x) => x.status === "open")) out.push(`Experts disagree; possible deciding factor: ${c.hidden_variable || "not identified"}`);
  for (const d of docConflicts.filter((x) => x.status === "unconfirmed")) out.push("Whether the written procedure should change is undecided");
  return out;
}

export function createKnowledge({ db, storage, cfg }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function latestVersion(q, judgmentId) {
    const [v] = await q("SELECT * FROM judgment_versions WHERE judgment_id = $1 ORDER BY version DESC LIMIT 1", [judgmentId]);
    return v;
  }

  // ---------------------------------------------------------------- retrieval (L5)
  async function retrieveForSession(ctx, workflowId, queryText, k, { forPersonId = null } = {}) {
    const usable = aiUsableSql(forPersonId);
    const rows = await T(ctx, (q) => q(`SELECT a.id AS artifact_id, a.judgment_id, j.expert_person_id, kv.rule, kv.embedding IS NOT NULL AS embedded
                                        FROM knowledge_artifacts a JOIN knowledge_versions kv ON kv.artifact_id = a.id AND kv.version = a.current_version
                                        JOIN judgments j ON j.id = a.judgment_id WHERE a.workflow_id = $1 AND a.status = 'active' AND ${usable}`, [workflowId]));
    if (!rows.length || k === 0) return [];
    if (!Number.isFinite(k) || rows.length <= k) return rows;
    const vec = await withAiContext({ orgId: ctx.orgId }, () => embed([queryText]));
    if (vec?.[0] && rows.some((r) => r.embedded)) {
      return T(ctx, (q) => q(`SELECT a.id AS artifact_id, a.judgment_id, j.expert_person_id, kv.rule
                              FROM knowledge_artifacts a JOIN knowledge_versions kv ON kv.artifact_id = a.id AND kv.version = a.current_version
                              JOIN judgments j ON j.id = a.judgment_id WHERE a.workflow_id = $1 AND a.status = 'active' AND ${usable} AND kv.embedding IS NOT NULL
                              ORDER BY kv.embedding <=> $2::vector LIMIT $3`, [workflowId, `[${vec[0].join(",")}]`, k]));
    }
    const words = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{M}\p{N}-]{3,}/gu) ?? []);
    const qw = words(queryText);
    return rows.map((r) => ({ r, s: [...words(r.rule)].filter((w) => qw.has(w)).length })).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.r);
  }

  // ---------------------------------------------------------------- multi-expert reconciliation
  async function checkOtherExperts(ctx, { judgmentId, workflowId, procedure }) {
    const { j, v, wf } = await T(ctx, async (q) => ({
      j: (await q("SELECT j.*, p.display_name FROM judgments j JOIN people p ON p.id = j.expert_person_id WHERE j.id = $1", [judgmentId]))[0],
      v: await latestVersion(q, judgmentId),
      wf: (await q("SELECT * FROM workflows WHERE id = $1", [workflowId]))[0],
    }));
    const candidates = (await retrieveForSession(ctx, workflowId, `${v.content.title}. ${v.content.rule}`, 3, { forPersonId: j.expert_person_id })).filter((r) => r.expert_person_id !== j.expert_person_id);
    const nearest = candidates[0];
    if (!nearest) return null;
    const other = await T(ctx, async (q) => ({
      j: (await q("SELECT j.*, p.display_name FROM judgments j JOIN people p ON p.id = j.expert_person_id WHERE j.id = $1", [nearest.judgment_id]))[0],
      v: await latestVersion(q, nearest.judgment_id),
    }));
    const view = (jj, vv) => ({ expertName: jj.display_name, situationFacts: vv.content.situationFacts, decision: vv.content.fields.decision.value, reason: vv.content.fields.reason.value, condition: vv.content.fields.condition.value, boundaryCondition: vv.content.boundary?.boundaryCondition, boundaryStated: vv.content.boundary?.status === "confirmed" });
    const r = await withAiContext({ orgId: ctx.orgId, workflowId, sessionId: j.session_id }, () => reconcileExperts({ wf, procedure, a: view(other.j, other.v), b: view(j, v) }));
    if (!["disagreement", "compatible_refinement"].includes(r.relation)) return null;
    return T(ctx, async (q) => {
      const [c] = await q(`INSERT INTO expert_conflicts (org_id, workflow_id, judgment_a, judgment_b, relation, shared_situation, hidden_variable, distinguishing_facts, question, status, resolution, resolved_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (judgment_a, judgment_b) DO NOTHING RETURNING *`,
        [ctx.orgId, workflowId, other.j.id, j.id, r.relation, r.sharedSituation, r.hiddenVariableHypothesis, JSON.stringify(r.distinguishingFacts), r.questionForExperts,
          r.resolved ? "resolved" : "open", r.resolution, r.resolved ? "experts' own explanations" : null]);
      return c;
    });
  }

  async function answerConflict(ctx, conflictId, answerText) {
    requirePermission(ctx, "conflict.answer");
    const text = String(answerText ?? "").trim().slice(0, 2000);
    if (!text) throw httpError(400, "answer required");
    const { c, a, b, wf, procedure, answers } = await T(ctx, async (q) => {
      const [c] = await q("SELECT * FROM expert_conflicts WHERE id = $1", [conflictId]);
      if (!c) throw httpError(404, "conflict not found");
      await q("INSERT INTO expert_conflict_answers (org_id, conflict_id, person_id, answer) VALUES ($1,$2,$3,$4)", [ctx.orgId, c.id, ctx.personId, text]);
      const load = async (id) => ({ j: (await q("SELECT j.*, p.display_name FROM judgments j JOIN people p ON p.id = j.expert_person_id WHERE j.id = $1", [id]))[0], v: await latestVersion(q, id) });
      const a = await load(c.judgment_a), b = await load(c.judgment_b);
      const answers = await q("SELECT p.display_name AS \"expertName\", x.answer FROM expert_conflict_answers x JOIN people p ON p.id = x.person_id WHERE x.conflict_id = $1 ORDER BY x.created_at", [c.id]);
      const wf = (await q("SELECT * FROM workflows WHERE id = $1", [c.workflow_id]))[0];
      const procedure = a.j.procedure_id ? (await q("SELECT * FROM workflow_procedures WHERE id = $1", [a.j.procedure_id]))[0] : null;
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.conflict_answer", targetType: "expert_conflict", targetId: c.id, requestId: ctx.requestId });
      return { c, a, b, wf, procedure, answers };
    });
    const view = (x) => ({ expertName: x.j.display_name, situationFacts: x.v.content.situationFacts, decision: x.v.content.fields.decision.value, reason: x.v.content.fields.reason.value, condition: x.v.content.fields.condition.value, boundaryCondition: x.v.content.boundary?.boundaryCondition, boundaryStated: x.v.content.boundary?.status === "confirmed" });
    const r = await withAiContext({ orgId: ctx.orgId, workflowId: c.workflow_id }, () => reconcileExperts({ wf, procedure, a: view(a), b: view(b), answers }));
    return T(ctx, async (q) => (await q(`UPDATE expert_conflicts SET hidden_variable = COALESCE(NULLIF($2,''), hidden_variable), distinguishing_facts = CASE WHEN $3::jsonb = '[]'::jsonb THEN distinguishing_facts ELSE $3::jsonb END,
                                         status = $4, resolution = $5, resolved_by = $6, question = $7 WHERE id = $1 RETURNING *`,
      [c.id, r.hiddenVariableHypothesis, JSON.stringify(r.distinguishingFacts ?? []), r.resolved ? "resolved" : "open", r.resolution ?? "", r.resolved ? "expert answer" : null, r.questionForExperts]))[0]);
  }

  /** Named sharing targets must be people in this space (RLS) and not the contributor. */
  async function validGroups(q, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && UUID.test(x)))].slice(0, 20);
    if (!list.length) return [];
    const found = await q("SELECT id FROM groups WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [list]); // RLS: this space only
    if (found.length !== list.length) throw httpError(400, "unknown group");
    return list;
  }

  /** Who would be able to see this knowledge with the given sharing settings (shown before the contributor confirms). */
  async function resolveAudience(q, { contributorId, visibility, people = [], groups = [] }) {
    if (visibility === "private") return { everyone: false, people: [], groups: [] };
    if (visibility === "organization") {
      const [{ n }] = await q("SELECT count(*)::int AS n FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active'");
      return { everyone: true, count: n, people: [], groups: [] };
    }
    const direct = people.length ? await q("SELECT id, display_name FROM people WHERE id = ANY($1::uuid[]) ORDER BY display_name", [people]) : [];
    const viaGroups = groups.length ? await q(`SELECT g.id AS group_id, g.name, p.id, p.display_name FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.removed_at IS NULL
                                               JOIN people p ON p.id = gm.person_id WHERE g.id = ANY($1::uuid[]) AND g.archived_at IS NULL ORDER BY g.name, p.display_name`, [groups]) : [];
    const seen = new Map();
    for (const p of direct) seen.set(p.id, { id: p.id, name: p.display_name, via: ["individually"] });
    for (const r of viaGroups) { if (r.id === contributorId) continue; const e = seen.get(r.id) ?? { id: r.id, name: r.display_name, via: [] }; e.via.push(r.name); seen.set(r.id, e); }
    const gs = groups.length ? await q("SELECT id, name FROM groups WHERE id = ANY($1::uuid[])", [groups]) : [];
    return { everyone: false, people: [...seen.values()], groups: gs.map((g) => ({ id: g.id, name: g.name })) };
  }

  async function accessPreview(ctx, artifactId, input = {}) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [a] = await q(`SELECT a.*, j.expert_person_id FROM knowledge_artifacts a JOIN judgments j ON j.id = a.judgment_id WHERE a.id = $1 AND ${visibleSql(viewer)}`, [artifactId]);
      if (!a) throw httpError(404, "knowledge not found");
      if (a.contributor_person_id !== ctx.personId) throw httpError(403, "only the contributor can review who may see this");
      const vis = VISIBILITY.includes(input.visibility) ? input.visibility : a.visibility;
      const people = input.sharedWith !== undefined ? (Array.isArray(input.sharedWith) ? input.sharedWith.filter((x) => UUID.test(x) && x !== ctx.personId).slice(0, 50) : []) : a.shared_with;
      const groups = input.sharedGroups !== undefined ? await validGroups(q, input.sharedGroups) : a.shared_groups;
      return resolveAudience(q, { contributorId: ctx.personId, visibility: vis, people, groups });
    });
  }

  async function validPeople(q, ids, selfId) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && UUID.test(x) && x !== selfId))].slice(0, 50);
    if (!list.length) throw httpError(400, "choose at least one person to share with");
    const found = await q("SELECT id FROM people WHERE id = ANY($1::uuid[])", [list]);
    if (found.length !== list.length) throw httpError(400, "unknown person");
    return list;
  }

  // ---------------------------------------------------------------- expert validation
  async function validate(ctx, judgmentId, { decision, edits = {}, confirmBoundary = false, expectedVersion, visibility, sharedWith }) {
    requirePermission(ctx, "knowledge.validate");
    if (!["approve", "edit", "reject"].includes(decision)) throw httpError(400, "invalid decision");
    if (visibility !== undefined && !VISIBILITY.includes(visibility)) throw httpError(400, "invalid visibility");
    const out = await T(ctx, async (q) => {
      const [j] = await q("SELECT * FROM judgments WHERE id = $1", [judgmentId]);
      if (!j) throw httpError(404, "judgment not found");
      if (j.expert_person_id !== ctx.personId) throw httpError(403, "only the expert who taught this can approve, edit or reject it");
      if (j.status !== "observed") throw httpError(409, "already validated");
      const v = await latestVersion(q, j.id);
      let content = v.content;
      let version = v.version;
      if (decision === "edit") {
        content = structuredClone(v.content);
        for (const f of EDITABLE) {
          if (typeof edits[f] !== "string") continue;
          if (f === "title") content.title = edits.title.trim().slice(0, 200);
          else content.fields[f] = { value: edits[f].trim().slice(0, 2000), status: "EXPERT_STATED", quote: edits[f].trim().slice(0, 2000), eventIds: [] };
        }
        if (typeof edits.boundaryCondition === "string") content.boundary.boundaryCondition = edits.boundaryCondition.trim();
        if (typeof edits.defaultWhen === "string") content.boundary.default.when = edits.defaultWhen.trim();
        if (typeof edits.defaultDecision === "string") content.boundary.default = { ...content.boundary.default, decision: edits.defaultDecision.trim(), source: "EXPERT_STATED" };
        content.rule = toRule({ ...Object.fromEntries(CHAIN_FIELDS.map((k) => [k, content.fields[k].value])), boundary: content.boundary });
        version += 1;
        await q("INSERT INTO judgment_versions (org_id, judgment_id, version, content, verification, author_type, author_user_id) VALUES ($1,$2,$3,$4,$5,'expert',$6)",
          [ctx.orgId, j.id, version, JSON.stringify(content), JSON.stringify({ notes: ["edited by the expert; edited fields are EXPERT_STATED"] }), ctx.userId]);
      }
      if (decision !== "reject" && (confirmBoundary || decision === "edit") && content.boundary.status !== "confirmed") {
        content = structuredClone(content);
        content.boundary.status = "confirmed"; content.boundary.confirmedByExpert = true;
        version += 1;
        await q("INSERT INTO judgment_versions (org_id, judgment_id, version, content, verification, author_type, author_user_id) VALUES ($1,$2,$3,$4,$5,'expert',$6)",
          [ctx.orgId, j.id, version, JSON.stringify(content), JSON.stringify({ notes: ["boundary explicitly confirmed by the expert"] }), ctx.userId]);
      }
      const status = decision === "reject" ? "rejected" : "approved";
      assertUpdated(await q("UPDATE judgments SET status = $2, current_version = $3, title = $4, version = version + 1, updated_at = now() WHERE id = $1 AND ($5::int IS NULL OR version = $5) RETURNING id", [j.id, status, version, content.title, expectedVersion ?? null]), "judgment");
      let artifactId = null;
      if (status === "approved") {
        // Saving is not sharing: living spaces default to private; workplaces default to the space (disclosed before capture).
        const viewer = await viewerOf(q, ctx);
        const vis = visibility ?? (viewer.experience === "living" ? "private" : "organization");
        const named = vis === "named" ? await validPeople(q, sharedWith, ctx.personId) : [];
        const [me] = await q("SELECT display_name FROM people WHERE id = $1", [ctx.personId]);
        const [a] = await q(`INSERT INTO knowledge_artifacts (org_id, workflow_id, judgment_id, title, contributor_person_id, visibility, shared_with, attribution)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [ctx.orgId, j.workflow_id, j.id, content.title, ctx.personId, vis, named, me?.display_name ?? ""]);
        artifactId = a.id;
        await q("INSERT INTO knowledge_versions (org_id, artifact_id, version, judgment_version, rule, compact) VALUES ($1,$2,1,$3,$4,$5)", [ctx.orgId, a.id, version, content.rule, JSON.stringify(compactFor(content))]);
        await q("INSERT INTO knowledge_validations (org_id, artifact_id, knowledge_version, kind, actor_person_id, actor_user_id, ground_truth_source) VALUES ($1,$2,1,'EXPERT_CONFIRMED',$3,$4,'EXPERT')", [ctx.orgId, a.id, ctx.personId, ctx.userId]);
        await enqueue(q, { orgId: ctx.orgId, kind: "compile_knowledge", key: `${a.id}:1`, payload: { artifactId: a.id, version: 1 } });
        await enqueue(q, { orgId: ctx.orgId, kind: "generate_scenarios", key: j.id, payload: { judgmentId: j.id } });
        // Curated cases are approved by construction: receivers of a mission can start right away.
        if (j.case_ref && (await q("SELECT 1 FROM scenarios WHERE workflow_id = $1 AND case_ref = $2 AND source = 'curated' AND review_status = 'approved' LIMIT 1", [j.workflow_id, j.case_ref])).length) await notifyAssessmentReady(q, j.id);
      }
      await q("UPDATE expert_sessions SET status = 'done', ended_at = COALESCE(ended_at, now()) WHERE id = $1", [j.session_id]);
      await enqueue(q, { orgId: ctx.orgId, kind: "retention_session", key: `${j.session_id}:retention`, payload: { sessionId: j.session_id } });
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: `knowledge.${decision}`, targetType: "judgment", targetId: j.id, requestId: ctx.requestId, metadata: { version } });
      return { status, artifactId };
    });
    return out;
  }

  async function peerConfirm(ctx, artifactId) {
    requirePermission(ctx, "knowledge.peer_confirm");
    return T(ctx, async (q) => {
      const [a] = await q("SELECT a.*, j.expert_person_id FROM knowledge_artifacts a JOIN judgments j ON j.id = a.judgment_id WHERE a.id = $1", [artifactId]);
      if (!a) throw httpError(404, "knowledge not found");
      if (a.expert_person_id === ctx.personId) throw httpError(409, "the authoring expert cannot peer-confirm their own knowledge");
      const [dup] = await q("SELECT 1 FROM knowledge_validations WHERE artifact_id = $1 AND kind = 'PEER_CONFIRMED' AND actor_person_id = $2", [a.id, ctx.personId]);
      if (dup) throw httpError(409, "already confirmed by you");
      await q("INSERT INTO knowledge_validations (org_id, artifact_id, knowledge_version, kind, actor_person_id, actor_user_id, ground_truth_source) VALUES ($1,$2,$3,'PEER_CONFIRMED',$4,$5,'EXPERT')", [ctx.orgId, a.id, a.current_version, ctx.personId, ctx.userId]);
      await q("UPDATE knowledge_artifacts SET last_validated_at = now() WHERE id = $1", [a.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.peer_confirm", targetType: "knowledge_artifact", targetId: a.id, requestId: ctx.requestId });
      return { confirmed: true };
    });
  }

  async function decideDocConflict(ctx, conflictId, decision) {
    requirePermission(ctx, "conflict.decide");
    if (!["confirm", "dismiss"].includes(decision)) throw httpError(400, "invalid decision");
    return T(ctx, async (q) => {
      const [c] = await q("SELECT d.*, j.expert_person_id FROM documentation_conflicts d JOIN judgments j ON j.id = d.judgment_id WHERE d.id = $1", [conflictId]);
      if (!c) throw httpError(404, "not found");
      if (ctx.roles.includes("EXPERT") && !ctx.roles.some((r) => ["ORG_ADMIN", "WORKFLOW_OWNER"].includes(r)) && c.expert_person_id !== ctx.personId) throw httpError(403, "only the expert or a workflow owner can decide this");
      await q("UPDATE documentation_conflicts SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [c.id, decision === "confirm" ? "confirmed" : "dismissed", ctx.userId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.doc_gap_decision", targetType: "documentation_conflict", targetId: c.id, requestId: ctx.requestId, metadata: { decision } });
      return { status: decision };
    });
  }

  // ---------------------------------------------------------------- views
  /** Knowledge readers: experts, owners, reviewers, admins; in a living space also learners (only what is shared with them). */
  function requireKnowledgeRead(ctx, viewer) {
    if (can(ctx, "knowledge.read")) return;
    if (viewer.experience === "living" && can(ctx, "learn.attempt")) return;
    requirePermission(ctx, "knowledge.read");
  }

  async function listForWorkflow(ctx, workflowId, { limit = 50 } = {}) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      requireKnowledgeRead(ctx, viewer);
      const [wf] = await q("SELECT id FROM workflows WHERE id = $1 AND deleted_at IS NULL", [workflowId]);
      if (!wf) throw httpError(404, "workflow not found");
      const rows = await q(`SELECT j.id, j.title, j.status, j.created_at, j.current_version, j.expert_person_id, p.display_name AS expert_name, a.id AS artifact_id, a.last_validated_at,
                                   a.visibility, a.restricted, a.status AS artifact_status, v.content->'fields' AS fields,
                                   (SELECT count(*)::int FROM expert_conflicts c WHERE c.status = 'open' AND (c.judgment_a = j.id OR c.judgment_b = j.id)) AS open_conflicts
                            FROM judgments j JOIN people p ON p.id = j.expert_person_id
                            LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id
                            JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                            WHERE j.workflow_id = $1 AND ${visibleSql(viewer)} ORDER BY j.created_at DESC LIMIT $2`, [workflowId, Math.min(limit, 200)]);
      const vals = rows.some((r) => r.artifact_id) ? await q("SELECT artifact_id, kind, actor_person_id FROM knowledge_validations WHERE artifact_id = ANY($1)", [rows.filter((r) => r.artifact_id).map((r) => r.artifact_id)]) : [];
      return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at, expertName: r.expert_name, artifactId: r.artifact_id,
        isMine: r.expert_person_id === ctx.personId, visibility: r.visibility ?? null, restricted: Boolean(r.restricted), withdrawn: r.artifact_status === "retired",
        levels: levelsOf({ status: r.status, validations: vals.filter((v) => v.artifact_id === r.artifact_id), openConflicts: r.open_conflicts, lastValidatedAt: r.last_validated_at, fields: r.fields }) }));
    });
  }

  async function detail(ctx, judgmentId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      requireKnowledgeRead(ctx, viewer);
      const [j] = await q(`SELECT j.*, p.display_name AS expert_name, w.name AS workflow_name FROM judgments j JOIN people p ON p.id = j.expert_person_id JOIN workflows w ON w.id = j.workflow_id
                           LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id WHERE j.id = $1 AND ${visibleSql(viewer)}`, [judgmentId]);
      if (!j) throw httpError(404, "judgment not found");
      const versions = await q("SELECT version, author_type, created_at, verification, content FROM judgment_versions WHERE judgment_id = $1 ORDER BY version", [j.id]);
      const current = versions.at(-1);
      const evidence = await q(`SELECT e.role, o.id, o.seq, o.modality, o.captured_at, o.text, o.media_asset_id, o.deleted_at, m.kind, m.mime_type, m.status AS media_status
                                FROM judgment_evidence e JOIN observations o ON o.id = e.observation_id LEFT JOIN media_assets m ON m.id = o.media_asset_id
                                WHERE e.judgment_id = $1 ORDER BY o.captured_at`, [j.id]);
      const [artifact] = await q("SELECT * FROM knowledge_artifacts WHERE judgment_id = $1", [j.id]);
      const validations = artifact ? await q(`SELECT v.kind, v.created_at, v.ground_truth_source, p.display_name FROM knowledge_validations v LEFT JOIN people p ON p.id = v.actor_person_id WHERE v.artifact_id = $1 ORDER BY v.created_at`, [artifact.id]) : [];
      const kv = artifact ? (await q("SELECT version, rule, embedding IS NOT NULL AS embedded FROM knowledge_versions WHERE artifact_id = $1 ORDER BY version DESC LIMIT 1", [artifact.id]))[0] : null;
      const docConflicts = await q("SELECT * FROM documentation_conflicts WHERE judgment_id = $1", [j.id]);
      const conflicts = await q(`SELECT c.*, pa.display_name AS expert_a, pb.display_name AS expert_b FROM expert_conflicts c
                                 JOIN judgments ja ON ja.id = c.judgment_a JOIN people pa ON pa.id = ja.expert_person_id
                                 JOIN judgments jb ON jb.id = c.judgment_b JOIN people pb ON pb.id = jb.expert_person_id
                                 WHERE c.judgment_a = $1 OR c.judgment_b = $1`, [j.id]);
      for (const c of conflicts) c.answers = await q("SELECT p.display_name, x.answer, x.created_at FROM expert_conflict_answers x JOIN people p ON p.id = x.person_id WHERE x.conflict_id = $1 ORDER BY x.created_at", [c.id]);
      const [srcDoc] = j.procedure_id ? await q("SELECT d.title FROM workflow_procedures p LEFT JOIN workflow_documents d ON d.id = p.document_id WHERE p.id = $1", [j.procedure_id]) : [];
      const [{ n: attempts }] = artifact ? await q("SELECT count(*)::int AS n FROM learner_attempts WHERE judgment_id = $1 AND status = 'complete'", [j.id]) : [{ n: 0 }];
      const isMine = ctx.personId === j.expert_person_id;
      const sharedNames = artifact?.shared_with?.length ? await q("SELECT id, display_name FROM people WHERE id = ANY($1::uuid[])", [artifact.shared_with]) : [];
      const sharedGroupNames = artifact?.shared_groups?.length ? await q("SELECT id, name, archived_at IS NOT NULL AS archived FROM groups WHERE id = ANY($1::uuid[])", [artifact.shared_groups]) : [];
      return {
        id: j.id, title: current.content.title, status: j.status, version: j.version, currentVersion: j.current_version, expertName: j.expert_name, expertPersonId: j.expert_person_id,
        isMine, sessionId: j.session_id, workflowId: j.workflow_id, workflowName: j.workflow_name, createdAt: j.created_at, extractionSource: j.extraction_source, experience: viewer.experience,
        content: current.content, verification: current.verification, versions: versions.map((v) => ({ version: v.version, authorType: v.author_type, createdAt: v.created_at, notes: v.verification?.notes ?? [] })),
        evidence, artifact: artifact ? {
          id: artifact.id, lastValidatedAt: artifact.last_validated_at, rule: kv?.rule, embedded: kv?.embedded, version: kv?.version, status: artifact.status, withdrawnAt: artifact.withdrawn_at,
          governance: { visibility: artifact.visibility, sharedWith: sharedNames.map((p) => ({ id: p.id, name: p.display_name })), sharedGroups: isMine ? sharedGroupNames.map((g) => ({ id: g.id, name: g.name, archived: g.archived })) : [], restricted: artifact.restricted, restrictionNote: artifact.restriction_note,
            attribution: artifact.attribution, craftContext: artifact.craft_context, publicPublication: "not offered", modelTraining: "not offered", canEdit: isMine && artifact.status === "active" },
        } : null,
        validations, docConflicts, conflicts, unresolved: unresolvedOf(current.content, { conflicts, docConflicts, expertName: j.expert_name }),
        provenance: { sourceDocument: srcDoc?.title ?? null, learnerAttempts: attempts },
        levels: levelsOf({ status: j.status, validations: validations.map((v) => ({ ...v, actor_person_id: v.display_name })), openConflicts: conflicts.filter((c) => c.status === "open").length, lastValidatedAt: artifact?.last_validated_at, fields: current.content.fields }),
      };
    });
  }

  // ---------------------------------------------------------------- governance (contributor-controlled)
  const CRAFT_KEYS = ["materials", "tools", "conditions", "terms", "sensoryCues", "timing"];

  async function updateSharing(ctx, artifactId, input = {}) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [a] = await q(`SELECT a.*, j.expert_person_id FROM knowledge_artifacts a JOIN judgments j ON j.id = a.judgment_id WHERE a.id = $1 AND ${visibleSql(viewer)}`, [artifactId]);
      if (!a) throw httpError(404, "knowledge not found");
      if (a.contributor_person_id !== ctx.personId) throw httpError(403, "only the person who contributed this knowledge can change how it is shared");
      if (a.status !== "active") throw httpError(409, "this knowledge was withdrawn");
      const vis = input.visibility ?? a.visibility;
      if (!VISIBILITY.includes(vis)) throw httpError(400, "invalid visibility");
      const restricted = input.restricted ?? a.restricted;
      if (restricted && vis === "organization") throw httpError(400, "restricted knowledge can only be shared with named people");
      const groups = vis === "named" ? (input.sharedGroups !== undefined ? await validGroups(q, input.sharedGroups) : a.shared_groups) : [];
      const named = vis === "named" ? (input.sharedWith !== undefined ? (Array.isArray(input.sharedWith) && input.sharedWith.length ? await validPeople(q, input.sharedWith, ctx.personId) : []) : a.shared_with) : [];
      if (vis === "named" && !named.length && !groups.length) throw httpError(400, "choose at least one person or group to share with");
      const craft = { ...a.craft_context };
      for (const k of CRAFT_KEYS) if (typeof input.craftContext?.[k] === "string") craft[k] = input.craftContext[k].trim().slice(0, 1000);
      await q(`UPDATE knowledge_artifacts SET visibility = $2, shared_with = $3, restricted = $4, restriction_note = $5, attribution = $6, craft_context = $7, shared_groups = $8, updated_at = now() WHERE id = $1`,
        [a.id, vis, named, restricted, typeof input.restrictionNote === "string" ? input.restrictionNote.trim().slice(0, 500) : a.restriction_note,
          typeof input.attribution === "string" ? input.attribution.trim().slice(0, 300) : a.attribution, JSON.stringify(craft), groups]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.sharing", targetType: "knowledge_artifact", targetId: a.id, requestId: ctx.requestId,
        metadata: { from: a.visibility, to: vis, named: named.length, groups: groups.length, restricted } });
      return { visibility: vis, sharedWith: named, sharedGroups: groups, restricted };
    });
  }

  /** The contributor withdraws knowledge: it leaves lessons, retrieval and other people's views; evidence media is deleted. */
  async function withdraw(ctx, artifactId) {
    requirePermission(ctx, "workflow.read");
    const purged = await T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [a] = await q(`SELECT a.*, j.expert_person_id FROM knowledge_artifacts a JOIN judgments j ON j.id = a.judgment_id WHERE a.id = $1 AND ${visibleSql(viewer)}`, [artifactId]);
      if (!a) throw httpError(404, "knowledge not found");
      const adminInWork = viewer.experience === "work" && can(ctx, "org.manage");
      if (a.contributor_person_id !== ctx.personId && !adminInWork) throw httpError(403, "only the contributor can withdraw this knowledge");
      if (a.status !== "active") throw httpError(409, "already withdrawn");
      await q("UPDATE knowledge_artifacts SET status = 'retired', withdrawn_at = now(), visibility = 'private', shared_with = '{}', shared_groups = '{}', restricted = false, updated_at = now() WHERE id = $1", [a.id]);
      await q("UPDATE knowledge_versions SET embedding = NULL WHERE artifact_id = $1", [a.id]);
      await q("INSERT INTO knowledge_validations (org_id, artifact_id, knowledge_version, kind, actor_person_id, actor_user_id) VALUES ($1,$2,$3,'RETIRED',$4,$5)", [ctx.orgId, a.id, a.current_version, ctx.personId, ctx.userId]);
      const media = await q(`UPDATE media_assets SET status = 'purged' WHERE id IN (SELECT o.media_asset_id FROM judgment_evidence e JOIN observations o ON o.id = e.observation_id
                              WHERE e.judgment_id = $1 AND o.media_asset_id IS NOT NULL) AND status NOT IN ('purged','deleted') RETURNING storage_key`, [a.judgment_id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.withdraw", targetType: "knowledge_artifact", targetId: a.id, requestId: ctx.requestId, metadata: { mediaPurged: media.length } });
      return media;
    });
    await deleteUnreferenced(T, ctx, storage, purged.map((m) => m.storage_key));
    return { withdrawn: true, mediaPurged: purged.length };
  }

  /** Living spaces: what I contributed and what others shared with me, across skills. */
  async function mine(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const rows = await q(`SELECT j.id, j.title, j.status, j.created_at, j.workflow_id, w.name AS workflow_name, p.display_name AS expert_name, j.expert_person_id,
                                   a.id AS artifact_id, a.visibility, a.restricted, a.status AS artifact_status, cardinality(a.shared_with) AS shared_count
                            FROM judgments j JOIN people p ON p.id = j.expert_person_id JOIN workflows w ON w.id = j.workflow_id
                            LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id
                            WHERE ${visibleSql({ ...viewer, reviewer: false })} AND j.status <> 'rejected' ORDER BY j.created_at DESC LIMIT 200`);
      const view = (r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at, workflowId: r.workflow_id, workflowName: r.workflow_name, expertName: r.expert_name,
        artifactId: r.artifact_id, visibility: r.visibility, restricted: Boolean(r.restricted), sharedCount: r.shared_count ?? 0, withdrawn: r.artifact_status === "retired" });
      return { mine: rows.filter((r) => r.expert_person_id === ctx.personId).map(view), sharedWithMe: rows.filter((r) => r.expert_person_id !== ctx.personId && r.artifact_id).map(view) };
    });
  }

  // ---------------------------------------------------------------- jobs
  async function compileKnowledge({ artifactId, version }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const [kv] = await T(ctx, (q) => q("SELECT kv.*, a.title FROM knowledge_versions kv JOIN knowledge_artifacts a ON a.id = kv.artifact_id WHERE kv.artifact_id = $1 AND kv.version = $2", [artifactId, version]));
    if (!kv || kv.embedding) return { skipped: true };
    const vec = await withAiContext({ orgId: ctx.orgId }, () => embed([`${kv.title}. ${kv.rule}`]));
    if (!vec?.[0]) return { embedded: false };
    await T(ctx, (q) => q("UPDATE knowledge_versions SET embedding = $3::vector WHERE artifact_id = $1 AND version = $2", [artifactId, version, `[${vec[0].join(",")}]`]));
    return { embedded: true };
  }

  /** Raw evidence retention for one finished session: keep only raw that backs knowledge (default), all, or none. */
  async function retentionSession({ sessionId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const purged = await T(ctx, async (q) => {
      const [s] = await q("SELECT privacy FROM expert_sessions WHERE id = $1", [sessionId]);
      if (!s || s.privacy.retainRaw === "all") return [];
      const keep = s.privacy.retainRaw === "none" ? [] : (await q(`SELECT DISTINCT o.media_asset_id FROM judgment_evidence e JOIN observations o ON o.id = e.observation_id
                                                                   JOIN judgments j ON j.id = e.judgment_id WHERE j.session_id = $1 AND j.status <> 'rejected' AND o.media_asset_id IS NOT NULL`, [sessionId])).map((r) => r.media_asset_id);
      // Evidence behind knowledge follows the knowledge's lifetime, not the short raw-media clock.
      if (keep.length) await q("UPDATE media_assets SET retention_class = 'knowledge', expires_at = NULL WHERE id = ANY($1::uuid[]) AND status NOT IN ('purged','deleted')", [keep]);
      return q(`UPDATE media_assets SET status = 'purged' WHERE session_id = $1 AND status NOT IN ('purged','deleted') AND NOT (id = ANY($2::uuid[])) RETURNING storage_key, bytes`, [sessionId, keep]);
    });
    await deleteUnreferenced(T, ctx, storage, purged.map((p) => p.storage_key));
    const bytes = purged.reduce((n, p) => n + Number(p.bytes), 0);
    await T(ctx, (q) => q(`UPDATE expert_sessions SET budget = jsonb_set(budget, '{rawBytesPurged}', to_jsonb(COALESCE((budget->>'rawBytesPurged')::bigint, 0) + $2)) WHERE id = $1`, [sessionId, bytes]));
    return { purged: purged.length, bytes };
  }

  /** Organization-wide lifecycle: expire raw media / transcripts past their retention class. Knowledge and audit stay. */
  async function lifecycleSweep(_payload, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const expired = await T(ctx, (q) => q("UPDATE media_assets SET status = 'purged' WHERE expires_at < now() AND status IN ('uploaded','processed','failed') RETURNING storage_key"));
    await deleteUnreferenced(T, ctx, storage, expired.map((e) => e.storage_key));
    const [t] = await T(ctx, (q) => q("WITH x AS (UPDATE transcript_segments SET text = '', deleted_at = now() WHERE expires_at < now() AND deleted_at IS NULL RETURNING 1) SELECT count(*)::int AS n FROM x"));
    // Semantic class: observation text older than the org's retention, unless it is evidence behind a judgment.
    const [o] = await T(ctx, async (q) => {
      const [org] = await q("SELECT settings FROM organizations WHERE id = app_org()");
      const days = Number(org?.settings?.retention?.semantic);
      if (!(days > 0)) return [{ n: 0 }];
      return q(`WITH x AS (UPDATE observations SET text = '', readings = '[]'::jsonb, structured = NULL, deleted_at = now()
                 WHERE deleted_at IS NULL AND created_at < now() - make_interval(days => $1::int)
                   AND NOT EXISTS (SELECT 1 FROM judgment_evidence e WHERE e.observation_id = observations.id) RETURNING 1)
                SELECT count(*)::int AS n FROM x`, [Math.floor(days)]);
    });
    return { mediaPurged: expired.length, transcriptsExpired: t.n, observationsExpired: o.n };
  }

  return {
    retrieveForSession, checkOtherExperts, answerConflict, validate, peerConfirm, decideDocConflict, listForWorkflow, detail, updateSharing, accessPreview, withdraw, mine,
    handlers: { compile_knowledge: compileKnowledge, retention_session: retentionSession, lifecycle_sweep: lifecycleSweep },
  };
}
