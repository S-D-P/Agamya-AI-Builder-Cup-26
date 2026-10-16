// Apprentice engine: novel case → counterfactual, Socratic tutoring, deterministic scoring, ground-truth provenance,
// and controlled experiments (SOP only vs SOP + captured judgment).
import { requirePermission, can } from "../platform/authz.mjs";
import { missionCriteriaFor, notifyAssessmentReady } from "./missions.mjs";
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { generateScenarios, tutor, evaluateLearner, ESCALATE, SCENARIO_KINDS } from "../ai/ops/teaching.mjs";
import { normalizeLanguage } from "../ai/language.mjs";
import { compactFor, visibleSql, viewerOf } from "./knowledge.mjs";
import { render } from "../sim/render.mjs";

const MAX_HINTS = 3;
export const GROUND_TRUTH = ["EXPERT", "REVIEWER", "MODEL_DERIVED", "SYNTHETIC"];

export function leaksAnswer(message, answerKey) {
  const norm = (s) => String(s).normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
  return norm(message).includes(norm(answerKey));
}

export function resultOf(steps, scenario, status) {
  const d = steps.filter((x) => x.type === "decision");
  const first = d[0], last = d.at(-1);
  const initialCorrect = Boolean(first?.correct);
  const finalCorrect = Boolean(last?.correct) && status === "complete";
  const overgeneralized = scenario.kind === "counterfactual" && Boolean(scenario.rule_action) && first?.choice === scenario.rule_action;
  return {
    kind: scenario.kind, initialDecision: first?.choice ?? null, initialCorrect, finalDecision: last?.choice ?? null, finalCorrect,
    interventions: steps.filter((x) => x.type === "intervention").map((x) => x.technique),
    transfer: initialCorrect ? "Not needed" : finalCorrect ? "Successful" : "Did not transfer",
    overgeneralized, boundaryUnderstood: scenario.kind === "counterfactual" ? initialCorrect : null,
    escalatedAppropriately: scenario.kind === "insufficient" ? first?.choice === ESCALATE : null,
    falseConfidence: scenario.kind === "insufficient" && Boolean(first) && first.choice !== ESCALATE,
    status: statusOf({ initialCorrect, finalCorrect }),
    groundTruthSource: scenario.ground_truth_source,
  };
}

/** Truthful labels. Simulation results are never certification or authorisation for real work. */
export function statusOf({ initialCorrect, finalCorrect }) {
  return initialCorrect ? "demonstrated_in_simulation" : finalCorrect ? "needs_further_practice" : "requires_supervision";
}
const KIND_ORDER = Object.fromEntries(SCENARIO_KINDS.map((k, i) => [k, i]));

export function createApprentice({ db, cfg }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function knowledgeFor(q, judgmentId) {
    const [v] = await q("SELECT v.content FROM judgments j JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version WHERE j.id = $1", [judgmentId]);
    return v ? compactFor(v.content) : null;
  }

  /** Scenarios for a piece of knowledge. Learners only ever see APPROVED ones (onlyApproved); reviewers also see drafts. */
  async function scenariosForJudgment(q, j, { onlyApproved = true } = {}) {
    const filter = onlyApproved ? "AND review_status = 'approved'" : "AND review_status <> 'rejected'";
    const curated = j.case_ref ? await q(`SELECT * FROM scenarios WHERE workflow_id = $1 AND case_ref = $2 AND source = 'curated' ${filter}`, [j.workflow_id, j.case_ref]) : [];
    const rows = curated.length ? curated : await q(`SELECT * FROM scenarios WHERE judgment_id = $1 ${filter}`, [j.id]);
    return rows.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  }

  async function lessons(ctx, workflowId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const [wf] = await q("SELECT id FROM workflows WHERE id = $1 AND deleted_at IS NULL", [workflowId]);
      if (!wf) throw httpError(404, "workflow not found");
      const viewer = await viewerOf(q, ctx);
      // Lessons exist only for approved knowledge the learner is allowed to see (sharing is the contributor's choice).
      const js = await q(`SELECT j.*, p.display_name AS expert_name, a.restricted, a.restriction_note FROM judgments j JOIN people p ON p.id = j.expert_person_id
                          JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active' WHERE j.workflow_id = $1 AND ${visibleSql(viewer)} ORDER BY j.created_at`, [workflowId]);
      const out = [];
      for (const j of js) {
        const sc = await scenariosForJudgment(q, j);
        const withAttempts = [];
        for (const s of sc) {
          const [at] = ctx.personId ? await q("SELECT id, status, result FROM learner_attempts WHERE scenario_id = $1 AND learner_person_id = $2 ORDER BY created_at DESC LIMIT 1", [s.id, ctx.personId]) : [];
          withAttempts.push({ id: s.id, kind: s.kind, title: s.title, source: s.source, groundTruthSource: s.ground_truth_source, reviewed: Boolean(s.reviewed_at), attempt: at ?? null });
        }
        const [job] = await q("SELECT status FROM jobs WHERE kind = 'generate_scenarios' AND idempotency_key = $1", [j.id]);
        const [{ n: drafts }] = await q("SELECT count(*)::int AS n FROM scenarios WHERE judgment_id = $1 AND review_status = 'draft'", [j.id]);
        out.push({ judgment: { id: j.id, title: j.title, expertName: j.expert_name, restricted: j.restricted, restrictionNote: j.restriction_note }, scenarios: withAttempts,
          generating: !withAttempts.length && ["queued", "running"].includes(job?.status), generationFailed: !withAttempts.length && job?.status === "dead",
          awaitingReview: !withAttempts.length && drafts > 0 });
      }
      return out;
    });
  }

  async function armFor(q, ctx, workflowId) {
    const [exp] = await q("SELECT * FROM experiments WHERE workflow_id = $1 AND status = 'running' ORDER BY created_at DESC LIMIT 1", [workflowId]);
    if (!exp) return null;
    const [existing] = await q("SELECT a.* FROM experiment_assignments x JOIN experiment_arms a ON a.id = x.arm_id WHERE x.experiment_id = $1 AND x.person_id = $2", [exp.id, ctx.personId]);
    if (existing) return existing;
    const arms = await q("SELECT a.*, (SELECT count(*) FROM experiment_assignments x WHERE x.arm_id = a.id)::int AS n FROM experiment_arms a WHERE a.experiment_id = $1 ORDER BY n, key", [exp.id]);
    await q("INSERT INTO experiment_assignments (org_id, experiment_id, person_id, arm_id) VALUES ($1,$2,$3,$4)", [ctx.orgId, exp.id, ctx.personId, arms[0].id]);
    return arms[0];
  }

  async function startAttempt(ctx, scenarioId) {
    requirePermission(ctx, "learn.attempt");
    if (!ctx.personId) throw httpError(400, "no learner profile");
    return T(ctx, async (q) => {
      const [s] = await q("SELECT * FROM scenarios WHERE id = $1", [scenarioId]);
      if (!s) throw httpError(404, "scenario not found");
      if (s.review_status !== "approved") throw httpError(409, "this scenario is waiting for the expert's approval");
      const visible = visibleSql(await viewerOf(q, ctx));
      const [j] = s.judgment_id
        ? await q(`SELECT j.* FROM judgments j JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active' WHERE j.id = $1 AND ${visible}`, [s.judgment_id])
        : await q(`SELECT j.* FROM judgments j JOIN knowledge_artifacts a ON a.judgment_id = j.id AND a.status = 'active'
                   WHERE j.workflow_id = $1 AND j.case_ref = $2 AND ${visible} ORDER BY j.created_at DESC LIMIT 1`, [s.workflow_id, s.case_ref]);
      if (!j) throw httpError(409, "no approved expert knowledge for this lesson yet");
      const arm = await armFor(q, ctx, s.workflow_id);
      const [prior] = await q("SELECT completed_at FROM learner_attempts WHERE scenario_id = $1 AND learner_person_id = $2 AND status = 'complete' ORDER BY completed_at LIMIT 1", [s.id, ctx.personId]);
      const [exp] = arm ? await q("SELECT retest_after_days FROM experiments WHERE id = $1", [arm.experiment_id]) : [];
      const phase = prior && exp && Date.now() - new Date(prior.completed_at).getTime() >= exp.retest_after_days * 86400000 ? "retest" : "immediate";
      const [at] = await q(`INSERT INTO learner_attempts (org_id, workflow_id, scenario_id, judgment_id, learner_person_id, user_id, experiment_arm_id, phase, kind, status)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'deciding') RETURNING id`, [ctx.orgId, s.workflow_id, s.id, j.id, ctx.personId, ctx.userId, arm?.id ?? null, phase, s.kind]);
      return attemptView(q, ctx, at.id);
    });
  }

  async function attemptView(q, ctx, id) {
    const [at] = await q("SELECT a.*, p.display_name AS learner_name, arm.key AS arm FROM learner_attempts a JOIN people p ON p.id = a.learner_person_id LEFT JOIN experiment_arms arm ON arm.id = a.experiment_arm_id WHERE a.id = $1", [id]);
    if (!at) throw httpError(404, "attempt not found");
    if (at.learner_person_id !== ctx.personId && !can(ctx, "attempt.read.any")) throw httpError(403, "not your attempt");
    const [s] = await q("SELECT * FROM scenarios WHERE id = $1", [at.scenario_id]);
    const steps = await q(`SELECT st.*, ev.named_condition, ev.named_reason, ev.error_type, ev.boundary_understood, ev.feedback, ev.evaluator, ev.criteria_met, ev.understood, ev.missing
                           FROM learner_steps st LEFT JOIN learner_evaluations ev ON ev.step_id = st.id WHERE st.attempt_id = $1 ORDER BY st.seq`, [id]);
    const complete = at.status === "complete";
    return {
      id: at.id, status: at.status, kind: at.kind, learnerName: at.learner_name, arm: at.arm, phase: at.phase, version: at.version,
      scenario: { id: s.id, kind: s.kind, title: s.title, facts: s.facts, narrative: s.narrative, options: s.options, escalateOption: ESCALATE, language: s.language, source: s.source, groundTruthSource: s.ground_truth_source, hasVisual: Boolean(s.visual), reviewStatus: s.review_status },
      criteria: complete ? s.criteria : undefined,
      steps: steps.map((x) => ({ seq: x.seq, type: x.type, choice: x.choice, reasoning: x.reasoning, correct: x.correct, level: x.level, technique: x.technique, message: x.message, source: x.source,
        evaluation: x.error_type ? { namedCondition: x.named_condition, namedReason: x.named_reason, errorType: x.error_type, boundaryUnderstood: x.boundary_understood, feedback: x.feedback, evaluator: x.evaluator, criteriaMet: x.criteria_met, understood: x.understood, missing: x.missing } : null })),
      answerKey: complete ? s.answer_key : undefined,
      result: complete ? at.result : null,
      // Evidence-grounded explanation shown once the attempt is complete: the expert's own words behind the decision.
      support: complete ? await supportFor(q, at.judgment_id) : null,
    };
  }

  async function supportFor(q, judgmentId) {
    const [v] = await q("SELECT v.content, p.display_name FROM judgments j JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version JOIN people p ON p.id = j.expert_person_id WHERE j.id = $1", [judgmentId]);
    if (!v) return null;
    const f = v.content.fields ?? {};
    const pick = ["observation", "condition", "reason", "exception"].map((k) => ({ field: k, value: f[k]?.value, quote: f[k]?.quote, status: f[k]?.status })).filter((x) => x.value && x.status === "EXPERT_STATED");
    return { expertName: v.display_name, rule: v.content.rule, statements: pick.slice(0, 3), boundary: v.content.boundary?.boundaryQuote ?? null };
  }

  async function getAttempt(ctx, id) { return T(ctx, (q) => attemptView(q, ctx, id)); }

  async function decide(ctx, attemptId, { choice, reasoning = "", expectedVersion }) {
    requirePermission(ctx, "learn.attempt");
    const prep = await T(ctx, async (q) => {
      const [at] = await q("SELECT a.*, arm.key AS arm FROM learner_attempts a LEFT JOIN experiment_arms arm ON arm.id = a.experiment_arm_id WHERE a.id = $1", [attemptId]);
      if (!at) throw httpError(404, "attempt not found");
      if (at.learner_person_id !== ctx.personId) throw httpError(403, "not your attempt");
      if (!["deciding", "reconsider"].includes(at.status)) throw httpError(409, "attempt is not awaiting a decision");
      if (expectedVersion && expectedVersion !== at.version) throw httpError(409, "attempt changed; reload");
      const [s] = await q("SELECT * FROM scenarios WHERE id = $1", [at.scenario_id]);
      if (!s.options.includes(choice) && choice !== ESCALATE) throw httpError(400, "unknown option");
      const knowledge = await knowledgeFor(q, at.judgment_id);
      const [j] = await q("SELECT procedure_id FROM judgments WHERE id = $1", [at.judgment_id]);
      const procedure = j.procedure_id ? (await q("SELECT * FROM workflow_procedures WHERE id = $1", [j.procedure_id]))[0] : null;
      const wf = (await q("SELECT * FROM workflows WHERE id = $1", [at.workflow_id]))[0];
      const steps = await q("SELECT * FROM learner_steps WHERE attempt_id = $1 ORDER BY seq", [at.id]);
      return { at, s, knowledge, procedure, wf, steps };
    });
    const { at, s, knowledge, procedure, wf, steps } = prep;
    const reason = String(reasoning).slice(0, 1000);
    const correct = choice === s.answer_key;
    const scenarioForAi = { kind: s.kind, title: s.title, facts: s.facts, narrative: s.narrative, options: s.options, answerKey: s.answer_key, ruleAction: s.rule_action };
    const language = normalizeLanguage(ctx.language ?? s.language);
    const hints = steps.filter((x) => x.type === "intervention").length;
    const willComplete = correct || hints >= MAX_HINTS;
    const history = steps.map((x) => (x.type === "decision" ? { learner: x.choice, why: x.reasoning } : { tutor: x.message }));
    const aiCtx = { orgId: ctx.orgId, workflowId: at.workflow_id, requestId: ctx.requestId };
    const [evaluation, hint] = await withAiContext(aiCtx, () => Promise.all([
      evaluateLearner({ wf, scenario: scenarioForAi, knowledge, choice, reasoning: reason, correct, criteria: s.criteria ?? [], language }),
      willComplete ? null : tutor({ wf, scenario: scenarioForAi, knowledge, procedure, level: hints + 1, history, choice, reasoning: reason, arm: at.arm ?? "SOP_PLUS_JUDGMENT", language }),
    ]));
    return T(ctx, async (q) => {
      const r = await q("UPDATE learner_attempts SET version = version + 1 WHERE id = $1 AND version = $2 RETURNING version", [at.id, at.version]);
      if (!r.length) throw httpError(409, "attempt changed; reload");
      let seq = steps.length;
      const [st] = await q("INSERT INTO learner_steps (org_id, attempt_id, seq, type, choice, reasoning, correct) VALUES ($1,$2,$3,'decision',$4,$5,$6) RETURNING id", [ctx.orgId, at.id, ++seq, choice, reason, correct]);
      await q(`INSERT INTO learner_evaluations (org_id, attempt_id, step_id, named_condition, named_reason, error_type, boundary_understood, feedback, evaluator, ground_truth_source, criteria_met, understood, missing, language)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [ctx.orgId, at.id, st.id, evaluation.namedCondition, evaluation.namedReason, evaluation.errorType, evaluation.boundaryUnderstood, evaluation.feedback, evaluation.evaluator, s.ground_truth_source,
          JSON.stringify((evaluation.criteriaMet ?? []).slice(0, (s.criteria ?? []).length)), evaluation.understood ?? "", evaluation.missing ?? "", language]);
      if (willComplete) {
        const allSteps = [...steps, { type: "decision", choice, correct }];
        const result = resultOf(allSteps, s, "complete");
        await q("UPDATE learner_attempts SET status = 'complete', result = $2, completed_at = now() WHERE id = $1", [at.id, JSON.stringify(result)]);
        const [a] = await q("SELECT id, current_version FROM knowledge_artifacts WHERE judgment_id = $1", [at.judgment_id]);
        const kinds = [];
        if (result.transfer === "Successful") kinds.push("LEARNER_TRANSFER");
        if (s.kind === "counterfactual") kinds.push(result.initialCorrect ? "LEARNER_BOUNDARY_PASS" : result.overgeneralized ? "LEARNER_OVERGENERALIZED" : null);
        for (const k of kinds.filter(Boolean)) await q("INSERT INTO knowledge_validations (org_id, artifact_id, knowledge_version, kind, actor_person_id, actor_user_id, ground_truth_source, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [ctx.orgId, a.id, a.current_version, k, ctx.personId, ctx.userId, s.ground_truth_source, JSON.stringify({ attemptId: at.id })]);
        if (result.finalCorrect) await q("UPDATE knowledge_artifacts SET last_validated_at = now() WHERE id = $1", [a.id]);
      } else {
        const level = hints + 1;
        const leaks = level < 3 && leaksAnswer(hint.message, s.answer_key);
        await q("INSERT INTO learner_steps (org_id, attempt_id, seq, type, level, technique, message, source) VALUES ($1,$2,$3,'intervention',$4,$5,$6,$7)",
          [ctx.orgId, at.id, ++seq, level, at.arm === "SOP_ONLY" ? "Documentation prompt" : ["", "Condition question", "Point to the expert", "Reveal reasoning"][level],
            leaks ? "Before choosing again: what is it about this specific situation that decides which way to go?" : hint.message, leaks ? "guard" : hint.source]);
        await q("UPDATE learner_attempts SET status = 'reconsider' WHERE id = $1", [at.id]);
      }
      return attemptView(q, ctx, at.id);
    });
  }

  /**
   * The contributor (or, in a workplace, a reviewer / workflow owner) checks a generated test: the situation, the expected
   * decision and the decision criteria. Only then can it be used to assess anyone, and only then does it count as human-validated.
   */
  async function reviewScenario(ctx, scenarioId, { approve, answerKey, criteria }) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const [s] = await q("SELECT s.*, j.expert_person_id FROM scenarios s LEFT JOIN judgments j ON j.id = s.judgment_id WHERE s.id = $1", [scenarioId]);
      if (!s) throw httpError(404, "scenario not found");
      const viewer = await viewerOf(q, ctx);
      const isContributor = s.expert_person_id && s.expert_person_id === ctx.personId;
      if (!isContributor && !(viewer.experience === "work" && can(ctx, "scenario.review"))) throw httpError(403, "only the contributor can approve tests of their knowledge");
      if (answerKey !== undefined && !s.options.includes(answerKey) && answerKey !== ESCALATE) throw httpError(400, "answer key must be one of the options");
      const crit = Array.isArray(criteria) ? criteria.map((c) => String(c).trim().slice(0, 300)).filter(Boolean).slice(0, 6) : null;
      const source = isContributor || ctx.roles.includes("EXPERT") ? "EXPERT" : "REVIEWER";
      if (approve) await q("UPDATE scenarios SET review_status = 'approved', ground_truth_source = $2, answer_key = COALESCE($3, answer_key), criteria = COALESCE($4, criteria), reviewed_by = $5, reviewed_at = now() WHERE id = $1",
        [s.id, source, answerKey ?? null, crit ? JSON.stringify(crit) : null, ctx.userId]);
      else await q("UPDATE scenarios SET review_status = 'rejected', reviewed_by = $2, reviewed_at = now() WHERE id = $1", [s.id, ctx.userId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "scenario.review", targetType: "scenario", targetId: s.id, requestId: ctx.requestId, metadata: { approve, source } });
      if (approve && s.judgment_id) await notifyAssessmentReady(q, s.judgment_id);
      return { reviewStatus: approve ? "approved" : "rejected", groundTruthSource: approve ? source : s.ground_truth_source };
    });
  }

  /** Tests for a piece of knowledge, with keys and criteria, for those who review them (never learners). */
  async function scenariosForReview(ctx, judgmentId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [j] = await q(`SELECT j.* FROM judgments j LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id WHERE j.id = $1 AND ${visibleSql(viewer)}`, [judgmentId]);
      if (!j) throw httpError(404, "judgment not found");
      if (j.expert_person_id !== ctx.personId && !(viewer.experience === "work" && can(ctx, "scenario.review"))) throw httpError(403, "tests are reviewed by the contributor");
      const rows = await scenariosForJudgment(q, j, { onlyApproved: false });
      const [job] = await q("SELECT status FROM jobs WHERE kind = 'generate_scenarios' AND idempotency_key = $1", [j.id]);
      return { generating: ["queued", "running"].includes(job?.status), failed: job?.status === "dead", scenarios: rows.map((s) => ({ id: s.id, kind: s.kind, title: s.title, facts: s.facts, narrative: s.narrative, options: s.options,
        answerKey: s.answer_key, escalate: s.answer_key === ESCALATE, criteria: s.criteria, reviewStatus: s.review_status, source: s.source, groundTruthSource: s.ground_truth_source, language: s.language })) };
    });
  }

  async function scenarioVisual(ctx, scenarioId) {
    requirePermission(ctx, "workflow.read");
    const [s] = await T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      // Generated tests are derived from someone's knowledge: only people who may see that knowledge may see them.
      return q(`SELECT s.visual, s.facts FROM scenarios s LEFT JOIN judgments j ON j.id = s.judgment_id LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id
                WHERE s.id = $1 AND (s.judgment_id IS NULL OR ${visibleSql(viewer)})`, [scenarioId]);
    });
    if (!s) throw httpError(404, "scenario not found");
    const v = s.visual;
    if (!v) return { svg: null };
    if (v.render === "loom" || v.render === "stove") return { svg: render(v.render, v.state) };
    if (v.render === "sheet") return { svg: render("sheet", v.view) };
    if (v.render === "console") return { svg: render("console", { status: `${s.facts.businessDate ?? ""} ${s.facts.time ?? ""} · ${s.facts.calendarFlag ?? ""}`, lines: Object.entries(s.facts).map(([k, val]) => `${k.toUpperCase().padEnd(13)} ${val}`) }) };
    return { svg: null };
  }

  // ---------------------------------------------------------------- experiments
  async function createExperiment(ctx, { workflowId, name, hypothesis, retestAfterDays = 14 }) {
    requirePermission(ctx, "experiment.manage");
    return T(ctx, async (q) => {
      await q("UPDATE experiments SET status = 'closed' WHERE workflow_id = $1 AND status = 'running'", [workflowId]);
      const [e] = await q("INSERT INTO experiments (org_id, workflow_id, name, hypothesis, status, retest_after_days, created_by) VALUES ($1,$2,$3,$4,'running',$5,$6) RETURNING *",
        [ctx.orgId, workflowId, String(name || "SOP vs captured judgment").slice(0, 120), String(hypothesis || "Learners coached with captured expert judgment outperform learners given the SOP alone on novel and counterfactual cases.").slice(0, 500), Math.max(1, Math.min(365, Number(retestAfterDays) || 14)), ctx.userId]);
      await q("INSERT INTO experiment_arms (org_id, experiment_id, key, description) VALUES ($1,$2,'SOP_ONLY','Documentation-only hints'), ($1,$2,'SOP_PLUS_JUDGMENT','Hints grounded in captured expert judgment')", [ctx.orgId, e.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "experiment.create", targetType: "experiment", targetId: e.id, requestId: ctx.requestId });
      return e;
    });
  }

  // ---------------------------------------------------------------- job: generate_scenarios
  async function generateScenariosJob({ judgmentId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const [j] = await q("SELECT * FROM judgments WHERE id = $1 AND status = 'approved'", [judgmentId]);
      if (!j) return null;
      if ((await scenariosForJudgment(q, j, { onlyApproved: false })).length) return null; // drafts count: never regenerate on retry
      const [sess] = await q("SELECT language FROM expert_sessions WHERE id = $1", [j.session_id]);
      return { j, wf: (await q("SELECT * FROM workflows WHERE id = $1", [j.workflow_id]))[0], knowledge: await knowledgeFor(q, j.id), language: normalizeLanguage(sess?.language), missionCriteria: await missionCriteriaFor(q, j.id) };
    });
    if (!prep) return { skipped: true };
    let g = await withAiContext({ orgId: ctx.orgId, workflowId: prep.wf.id }, () => generateScenarios({ wf: prep.wf, knowledge: prep.knowledge, language: prep.language, missionCriteria: prep.missionCriteria }));
    if (!g.ok) g = await withAiContext({ orgId: ctx.orgId, workflowId: prep.wf.id }, () => generateScenarios({ wf: prep.wf, knowledge: prep.knowledge, language: prep.language, missionCriteria: prep.missionCriteria }));
    if (!g.ok) throw new Error(g.error);
    await T(ctx, async (q) => {
      // Drafts: never used to assess anyone until the contributor approves the situation, key and criteria.
      for (const sc of g.cases) {
        await q(`INSERT INTO scenarios (org_id, workflow_id, judgment_id, kind, title, facts, narrative, options, answer_key, rule_action, source, ground_truth_source, flipped_condition, review_status, criteria, language)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'generated','MODEL_DERIVED',$11,'draft',$12,$13)`,
          [ctx.orgId, prep.wf.id, prep.j.id, sc.kind, sc.title, JSON.stringify(sc.facts), sc.narrative, JSON.stringify(sc.options), sc.answerKey, sc.ruleAction, g.flippedCondition, JSON.stringify(sc.criteria ?? []), prep.language]);
      }
    });
    return { generated: g.cases.length };
  }

  return { lessons, startAttempt, getAttempt, decide, reviewScenario, scenariosForReview, scenarioVisual, createExperiment, handlers: { generate_scenarios: generateScenariosJob } };
}
