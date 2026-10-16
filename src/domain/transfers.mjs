// Agamya for Work: knowledge-transfer plans and learner progress.
// A manager arranges for an expert to pass a workflow's judgment to a learner. The expert sees exactly what will be
// captured, why, and who will see the result, then starts the capture from the plan. Progress is measured by what the
// learner demonstrated on new and counterfactual cases, never by content consumed. A simulated exercise is reported
// as "demonstrated in simulation", not as verified real-world proficiency.
import { requirePermission, can } from "../platform/authz.mjs";
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { unresolvedOf, visibleSql, viewerOf } from "./knowledge.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GAP_COPY = {
  false_confidence: "Acted confidently where the deciding information was missing",
  unnecessary_escalation: "Stopped to ask although the facts were enough to decide",
  missed_condition: "Missed the deciding condition",
  overgeneralization: "Applied the rule where it does not apply",
  undergeneralization: "Fell back to the default where the exception applied",
  wrong_reason: "Right choice, but for the wrong reason",
  other: "Incorrect reasoning",
};

/** Per-knowledge status for one learner, from their latest completed attempts on the apply and counterfactual cases. */
export function masteryOf(apply, counterfactual, { boundary = null, insufficient = null } = {}) {
  if (!apply && !counterfactual && !boundary && !insufficient) return "not_started";
  // Acting confidently where the deciding information was missing is a supervision issue, even if corrected afterwards.
  if (insufficient && !insufficient.initialCorrect) return "needs_supervision";
  if (counterfactual?.overgeneralized || (apply && !apply.finalCorrect) || (counterfactual && !counterfactual.initialCorrect) || (boundary && !boundary.finalCorrect)) return "needs_supervision";
  if (apply?.finalCorrect && counterfactual?.initialCorrect && (!boundary || boundary.initialCorrect)) return "demonstrated_in_simulation";
  return "in_progress";
}

export function createTransfers({ db, capture }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function loadTransfer(q, ctx, id) {
    if (!UUID.test(String(id))) throw httpError(404, "transfer not found");
    const [t] = await q(`SELECT t.*, w.name AS workflow_name, w.modalities, pe.display_name AS expert_name, pl.display_name AS learner_name
                         FROM transfers t JOIN workflows w ON w.id = t.workflow_id JOIN people pe ON pe.id = t.expert_person_id JOIN people pl ON pl.id = t.learner_person_id
                         WHERE t.id = $1`, [id]);
    if (!t) throw httpError(404, "transfer not found");
    const party = ctx.personId && [t.expert_person_id, t.learner_person_id].includes(ctx.personId);
    if (!party && !can(ctx, "workflow.manage")) throw httpError(404, "transfer not found");
    return t;
  }

  /** What the expert is told before capture starts: inputs, purpose, who sees the result, retention. */
  async function disclosure(q, t) {
    const [o] = await q("SELECT name, settings FROM organizations WHERE id = app_org()");
    const inputs = Object.entries(t.modalities ?? {}).filter(([k, v]) => v && ["screen", "camera", "microphone"].includes(k)).map(([k]) => k);
    return {
      captured: inputs.length ? `Your ${inputs.join(", ")}, only during the session you start and only for the inputs you consent to. Frames are sent only when something changes; silence is never uploaded.` : "Only what you type or narrate.",
      purpose: t.purpose,
      access: `Knowledge you approve is shared with people in ${o.name} who learn "${t.workflow_name}", including ${t.learner_name}. Nothing becomes knowledge until you approve it, and you can correct or reject what Agamya proposes.`,
      retention: `Raw media is deleted after your approval except the frames that support the knowledge (default). Unprocessed raw media expires after ${o.settings?.retention?.raw_media ?? 30} days.`,
      controls: "You can pause, exclude an input, delete any moment, or stop answering at any time.",
    };
  }

  async function progressFor(q, t) {
    const sessions = await q("SELECT id, status, started_at AS created_at FROM expert_sessions WHERE transfer_id = $1 ORDER BY started_at", [t.id]);
    const judgments = sessions.length ? await q(`SELECT j.id, j.title, j.status, j.case_ref, j.workflow_id, a.id AS artifact_id, v.content, p.display_name AS expert_name
                                                  FROM judgments j JOIN people p ON p.id = j.expert_person_id LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active'
                                                  JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                                                  WHERE j.session_id = ANY($1::uuid[]) ORDER BY j.created_at`, [sessions.map((s) => s.id)]) : [];
    const items = [];
    for (const j of judgments.filter((x) => x.status === "approved" && x.artifact_id)) items.push(await learnerItem(q, j, t.learner_person_id));
    const pendingApproval = judgments.some((j) => j.status === "observed");
    const stage = !sessions.length ? "scheduled"
      : sessions.some((s) => ["awaiting_consent", "capturing", "processing", "analyzing", "asking", "extracting"].includes(s.status)) ? "capturing"
      : pendingApproval ? "awaiting_approval"
      : !items.length ? (sessions.every((s) => s.status === "no_judgment") ? "nothing_to_transfer" : "capturing")
      : items.every((i) => i.status === "demonstrated_in_simulation") ? "demonstrated_in_simulation"
      : items.some((i) => i.status === "needs_supervision") ? "needs_supervision"
      : items.some((i) => i.status !== "not_started") ? "learning" : "ready_for_learner";
    return { stage, sessions: sessions.map((s) => ({ id: s.id, status: s.status, createdAt: s.created_at })), knowledge: items, pendingApproval };
  }

  /** One learner against one approved piece of knowledge. */
  async function learnerItem(q, j, learnerPersonId) {
    const scenarios = await q(`SELECT id, kind FROM scenarios WHERE (judgment_id = $1) OR (case_ref IS NOT NULL AND case_ref = $2 AND workflow_id = $3 AND source = 'curated')`, [j.id, j.case_ref, j.workflow_id]);
    const latest = async (kind) => {
      const ids = scenarios.filter((s) => s.kind === kind).map((s) => s.id);
      if (!ids.length) return null;
      const [a] = await q(`SELECT id, result, completed_at FROM learner_attempts WHERE scenario_id = ANY($1::uuid[]) AND learner_person_id = $2 AND judgment_id = $3 AND status = 'complete'
                           ORDER BY completed_at DESC LIMIT 1`, [ids, learnerPersonId, j.id]);
      return a ? { ...a.result, attemptId: a.id, completedAt: a.completed_at } : null;
    };
    const apply = await latest("apply"), counterfactual = await latest("counterfactual"), boundary = await latest("boundary"), insufficient = await latest("insufficient");
    const evals = await q(`SELECT e.error_type, e.named_condition, e.evaluator FROM learner_evaluations e JOIN learner_attempts a ON a.id = e.attempt_id
                           WHERE a.learner_person_id = $1 AND a.judgment_id = $2 AND a.status = 'complete' ORDER BY e.created_at DESC LIMIT 6`, [learnerPersonId, j.id]);
    const gaps = new Set();
    for (const e of evals) {
      if (e.evaluator !== "gemini") { gaps.add("Reasoning not assessed (AI unavailable at the time)"); continue; }
      if (GAP_COPY[e.error_type]) gaps.add(GAP_COPY[e.error_type]);
    }
    if (counterfactual?.overgeneralized) gaps.add(GAP_COPY.overgeneralization);
    return {
      judgmentId: j.id, artifactId: j.artifact_id, title: j.title, expertName: j.expert_name, status: masteryOf(apply, counterfactual, { boundary, insufficient }),
      apply: apply && { initialCorrect: apply.initialCorrect, finalCorrect: apply.finalCorrect, hints: apply.interventions?.length ?? 0, groundTruth: apply.groundTruthSource },
      counterfactual: counterfactual && { boundaryUnderstood: counterfactual.initialCorrect, overgeneralized: counterfactual.overgeneralized, groundTruth: counterfactual.groundTruthSource },
      boundary: boundary && { correct: boundary.initialCorrect, finalCorrect: boundary.finalCorrect },
      insufficient: insufficient && { escalatedAppropriately: insufficient.initialCorrect, falseConfidence: !insufficient.initialCorrect },
      gaps: [...gaps], uncertain: unresolvedOf(j.content, { expertName: j.expert_name }),
    };
  }

  async function list(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const all = can(ctx, "workflow.manage");
      const rows = await q(`SELECT t.*, w.name AS workflow_name, pe.display_name AS expert_name, pl.display_name AS learner_name
                            FROM transfers t JOIN workflows w ON w.id = t.workflow_id JOIN people pe ON pe.id = t.expert_person_id JOIN people pl ON pl.id = t.learner_person_id
                            WHERE ${all ? "true" : "(t.expert_person_id = $1 OR t.learner_person_id = $1)"} ORDER BY t.status = 'scheduled' DESC, t.scheduled_for NULLS LAST, t.created_at DESC LIMIT 200`, all ? [] : [ctx.personId ?? null]);
      const out = [];
      for (const t of rows) {
        const p = t.status === "cancelled" ? { stage: "cancelled", knowledge: [] } : await progressFor(q, t);
        out.push({ ...view(ctx, t), stage: p.stage, knowledgeCount: p.knowledge.length, demonstrated: p.knowledge.filter((k) => k.status === "demonstrated_in_simulation").length });
      }
      return out;
    });
  }

  function view(ctx, t) {
    return {
      id: t.id, workflowId: t.workflow_id, workflowName: t.workflow_name, purpose: t.purpose, scheduledFor: t.scheduled_for, status: t.status, createdAt: t.created_at,
      expert: { id: t.expert_person_id, name: t.expert_name }, learner: { id: t.learner_person_id, name: t.learner_name },
      role: ctx.personId === t.expert_person_id ? "expert" : ctx.personId === t.learner_person_id ? "learner" : "manager",
    };
  }

  async function get(ctx, id) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const t = await loadTransfer(q, ctx, id);
      return { ...view(ctx, t), disclosure: await disclosure(q, t), progress: await progressFor(q, t) };
    });
  }

  async function create(ctx, { workflowId, expertPersonId, learnerPersonId, scheduledFor = null, purpose }) {
    requirePermission(ctx, "workflow.manage");
    const text = String(purpose ?? "").trim().slice(0, 500);
    if (!text) throw httpError(400, "describe the purpose of this transfer");
    if (expertPersonId === learnerPersonId) throw httpError(400, "the expert and the learner must be different people");
    const when = scheduledFor ? new Date(scheduledFor) : null;
    if (when && Number.isNaN(when.getTime())) throw httpError(400, "invalid date");
    return T(ctx, async (q) => {
      const [wf] = await q("SELECT id FROM workflows WHERE id = $1 AND deleted_at IS NULL", [workflowId]);
      if (!wf) throw httpError(404, "workflow not found");
      const people = await q(`SELECT p.id, m.roles FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active' WHERE p.id = ANY($1::uuid[])`, [[expertPersonId, learnerPersonId]]);
      const expert = people.find((p) => p.id === expertPersonId), learner = people.find((p) => p.id === learnerPersonId);
      if (!expert || !expert.roles.includes("EXPERT")) throw httpError(400, "the expert must be a member with the expert role");
      if (!learner || !learner.roles.includes("LEARNER")) throw httpError(400, "the learner must be a member with the learner role");
      await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'EXPERT') ON CONFLICT DO NOTHING", [ctx.orgId, wf.id, expertPersonId]);
      await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'LEARNER') ON CONFLICT DO NOTHING", [ctx.orgId, wf.id, learnerPersonId]);
      const [t] = await q(`INSERT INTO transfers (org_id, workflow_id, expert_person_id, learner_person_id, scheduled_for, purpose, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.orgId, wf.id, expertPersonId, learnerPersonId, when, text, ctx.userId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "transfer.create", targetType: "transfer", targetId: t.id, requestId: ctx.requestId });
      return { id: t.id };
    });
  }

  /** Only the expert named on the plan can start capture from it. */
  async function start(ctx, id, { source, caseRef } = {}) {
    requirePermission(ctx, "session.capture");
    const t = await T(ctx, (q) => loadTransfer(q, ctx, id));
    if (t.expert_person_id !== ctx.personId) throw httpError(403, "only the expert on this transfer can start the capture");
    return capture.startSession(ctx, { workflowId: t.workflow_id, source, caseRef, transferId: t.id });
  }

  async function setStatus(ctx, id, status) {
    requirePermission(ctx, "workflow.manage");
    if (!["cancelled", "closed", "scheduled"].includes(status)) throw httpError(400, "invalid status");
    return T(ctx, async (q) => {
      const t = await loadTransfer(q, ctx, id);
      await q("UPDATE transfers SET status = $2, updated_at = now() WHERE id = $1", [t.id, status]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: `transfer.${status}`, targetType: "transfer", targetId: t.id, requestId: ctx.requestId });
      return { status };
    });
  }

  /** Learner progress across a workflow's shared, approved knowledge. Managers see everyone; learners see themselves. */
  async function progress(ctx, workflowId) {
    requirePermission(ctx, "workflow.read");
    const all = can(ctx, "attempt.read.any");
    if (!all && !can(ctx, "learn.attempt")) throw httpError(403, "missing permission: progress");
    return T(ctx, async (q) => {
      const [wf] = await q("SELECT id, name FROM workflows WHERE id = $1 AND deleted_at IS NULL", [workflowId]);
      if (!wf) throw httpError(404, "workflow not found");
      const judgments = await q(`SELECT j.id, j.title, j.case_ref, j.workflow_id, a.id AS artifact_id, v.content, p.display_name AS expert_name
                                 FROM judgments j JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active' AND a.visibility = 'organization'
                                 JOIN people p ON p.id = j.expert_person_id JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                                 WHERE j.workflow_id = $1 ORDER BY j.created_at`, [wf.id]);
      const learners = all
        ? await q(`SELECT DISTINCT p.id, p.display_name FROM people p WHERE p.id IN (SELECT person_id FROM workflow_participants WHERE workflow_id = $1 AND participation = 'LEARNER')
                   OR p.id IN (SELECT learner_person_id FROM learner_attempts WHERE workflow_id = $1) ORDER BY p.display_name`, [wf.id])
        : await q("SELECT id, display_name FROM people WHERE id = $1", [ctx.personId]);
      const rows = [];
      for (const l of learners) {
        const items = [];
        for (const j of judgments) items.push(await learnerItem(q, j, l.id));
        rows.push({ learner: { id: l.id, name: l.display_name }, items });
      }
      return { workflow: { id: wf.id, name: wf.name }, knowledgeCount: judgments.length, learners: rows,
        note: "Status reflects decisions on simulated cases (a new case and a counterexample). It is evidence of understanding, not verified on-the-job proficiency." };
    });
  }

  // ---------------------------------------------------------------- Knowledge Loss Radar
  /**
   * Continuity view for managers. Status per workflow comes from explicit rules over real records (no scores, no predictions):
   *   insufficient_evidence  nothing captured or approved yet: we cannot say whether knowledge is safe
   *   at_risk                approved knowledge is held by one person AND no learner has demonstrated it in simulation,
   *                          or a critical exception / boundary is still missing from approved knowledge
   *   needs_attention        open knowledge gaps, knowledge awaiting approval, tests awaiting review, or learners needing supervision
   *   covered                none of the above, and every approved item has a learner who demonstrated it in simulation
   * Each finding lists the records behind it and the action that reduces it.
   */
  async function radar(ctx) {
    requirePermission(ctx, "analytics.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const wfs = await q("SELECT id, name, kind FROM workflows WHERE deleted_at IS NULL ORDER BY created_at");
      const out = [];
      for (const wf of wfs) {
        const [docs] = await q("SELECT count(*)::int AS docs, (SELECT count(*)::int FROM workflow_procedures WHERE workflow_id = $1) AS procedures FROM workflow_documents WHERE workflow_id = $1", [wf.id]);
        const [{ sessions }] = await q("SELECT count(*)::int AS sessions FROM expert_sessions WHERE workflow_id = $1", [wf.id]);
        const experts = await q("SELECT p.id, p.display_name FROM workflow_participants wp JOIN people p ON p.id = wp.person_id WHERE wp.workflow_id = $1 AND wp.participation = 'EXPERT'", [wf.id]);
        const learners = await q("SELECT p.id, p.display_name FROM workflow_participants wp JOIN people p ON p.id = wp.person_id WHERE wp.workflow_id = $1 AND wp.participation = 'LEARNER'", [wf.id]);
        const judgments = await q(`SELECT j.id, j.title, j.status, j.case_ref, j.workflow_id, j.expert_person_id, p.display_name AS expert_name, a.id AS artifact_id, a.status AS artifact_status, a.visibility,
                                          v.content, ${visibleSql(viewer)} AS visible
                                   FROM judgments j JOIN people p ON p.id = j.expert_person_id LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id
                                   JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version WHERE j.workflow_id = $1 AND j.status <> 'rejected'`, [wf.id]);
        const approved = judgments.filter((j) => j.status === "approved" && j.artifact_status === "active");
        const shown = (j) => (j.visible ? { judgmentId: j.id, title: j.title, expertName: j.expert_name } : { judgmentId: null, title: "Private knowledge (not shared with you)", expertName: j.expert_name });
        const findings = [];
        const add = (key, label, records, action) => { if (records.length) findings.push({ key, label, count: records.length, records: records.slice(0, 6), action }); };

        add("awaiting_approval", "Knowledge captured but not yet approved by the expert", judgments.filter((j) => j.status === "observed").map(shown),
          { type: "request_approval", label: "Ask the expert to review and approve", href: null });
        const fieldMissing = (j, k) => !["EXPERT_STATED", "OBSERVED"].includes(j.content.fields?.[k]?.status);
        add("rationale_missing", "Approved decisions whose reason is not stated by the expert", approved.filter((j) => fieldMissing(j, "reason")).map(shown),
          { type: "answer_gap", label: "Ask why: fill the missing rationale", href: "knowledge" });
        add("exception_missing", "Approved knowledge with no confirmed exception or boundary", approved.filter((j) => j.content.fields?.exception?.status !== "EXPERT_STATED" || j.content.boundary?.status !== "confirmed").map(shown),
          { type: "capture_exception", label: "Capture when this stops applying", href: "knowledge" });
        const gaps = judgments.length ? await q(`SELECT g.id, g.kind, g.status, g.missing, g.judgment_id FROM knowledge_gaps g WHERE g.judgment_id = ANY($1::uuid[]) AND g.status IN ('open','answered','deferred','accepted_unresolved')`, [judgments.map((j) => j.id)]) : [];
        const jById = new Map(judgments.map((j) => [j.id, j]));
        add("open_gaps", "Open knowledge gaps", gaps.filter((g) => g.status !== "accepted_unresolved").map((g) => ({ ...shown(jById.get(g.judgment_id)), detail: jById.get(g.judgment_id)?.visible ? g.missing : "(private)", kind: g.kind, status: g.status })),
          { type: "answer_gap", label: "Answer the follow-up questions", href: "knowledge" });
        add("accepted_unresolved", "Gaps the expert accepted as unresolved (known unknowns)", gaps.filter((g) => g.status === "accepted_unresolved").map((g) => ({ ...shown(jById.get(g.judgment_id)), detail: jById.get(g.judgment_id)?.visible ? g.missing : "(private)" })),
          { type: "supervise", label: "Keep supervision in place for these points", href: null });
        const drafts = approved.length ? await q("SELECT s.id, s.kind, s.judgment_id FROM scenarios s WHERE s.judgment_id = ANY($1::uuid[]) AND s.review_status = 'draft'", [approved.map((j) => j.id)]) : [];
        add("tests_unreviewed", "Learner tests waiting for the expert's approval", drafts.map((d) => ({ ...shown(jById.get(d.judgment_id)), detail: d.kind })),
          { type: "review_tests", label: "Review and approve the tests", href: "knowledge" });

        const items = [];
        for (const j of approved) for (const l of learners) items.push({ j, l, item: await learnerItem(q, j, l.id) });
        add("needs_supervision", "Learners who still require supervision", items.filter((x) => x.item.status === "needs_supervision").map((x) => ({ ...shown(x.j), learner: x.l.display_name, detail: x.item.gaps.join("; ") || "missed a case in simulation" })),
          { type: "schedule_assessment", label: "Coach and re-assess these concepts", href: "progress" });
        const demonstratedBy = new Map(approved.map((j) => [j.id, items.filter((x) => x.j.id === j.id && x.item.status === "demonstrated_in_simulation").length]));
        add("not_assessed", "Approved knowledge no learner has practised yet", approved.filter((j) => !items.some((x) => x.j.id === j.id && x.item.status !== "not_started")).map(shown),
          { type: "schedule_assessment", label: learners.length ? "Ask a learner to take the test" : "Add a learner to this workflow", href: "progress" });
        const holders = new Set(approved.map((j) => j.expert_person_id));
        const single = holders.size === 1 && approved.every((j) => !demonstratedBy.get(j.id));
        if (single) add("single_holder", "Only one person holds the approved knowledge, and no one else has demonstrated it", approved.map(shown),
          { type: "plan_transfer", label: "Plan a knowledge transfer", href: "transfers/new" });

        const keys = new Set(findings.map((f) => f.key));
        const status = !sessions && !judgments.length ? "insufficient_evidence"
          : !approved.length ? (judgments.length ? "needs_attention" : "insufficient_evidence")
          : keys.has("single_holder") || keys.has("exception_missing") ? "at_risk"
          : ["open_gaps", "awaiting_approval", "tests_unreviewed", "needs_supervision", "rationale_missing", "not_assessed"].some((k) => keys.has(k)) ? "needs_attention"
          : "covered";
        out.push({ workflow: wf, status, findings, facts: { documents: docs.docs, procedures: docs.procedures, sessions, experts: experts.length, learners: learners.length, approved: approved.length,
          holders: holders.size, privateApproved: approved.filter((j) => !j.visible).length } });
      }
      return { workflows: out, rules: "See docs/RADAR.md. Status comes from rules over real records; there is no score and no prediction." };
    });
  }

  return { list, get, create, start, setStatus, progress, radar, learnerResult: learnerItem };
}
