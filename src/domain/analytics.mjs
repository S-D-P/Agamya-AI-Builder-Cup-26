// Analytics: bounded SQL aggregates (no full-history loads into memory).
import { requirePermission } from "../platform/authz.mjs";
import { httpError } from "../platform/security.mjs";
import { STALE_DAYS } from "./knowledge.mjs";

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

export function createAnalytics({ db }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const wfFilter = (alias, idx) => `($${idx}::uuid IS NULL OR ${alias}.workflow_id = $${idx}::uuid)`;

  async function transfer(q, workflowId) {
    const rows = await q(`SELECT a.kind, a.result, a.phase, arm.key AS arm, s.ground_truth_source FROM learner_attempts a JOIN scenarios s ON s.id = a.scenario_id
                          LEFT JOIN experiment_arms arm ON arm.id = a.experiment_arm_id WHERE a.status = 'complete' AND ${wfFilter("a", 1)} ORDER BY a.completed_at DESC LIMIT 5000`, [workflowId]);
    const calc = (rs) => {
      const r = rs.map((x) => x.result);
      const wrong = r.filter((x) => !x.initialCorrect);
      const cf = r.filter((x) => x.kind === "counterfactual");
      return {
        attempts: r.length, initialAccuracy: pct(r.filter((x) => x.initialCorrect).length, r.length), finalAccuracy: pct(r.filter((x) => x.finalCorrect).length, r.length),
        startedWrong: wrong.length, successfulTransfers: wrong.filter((x) => x.finalCorrect).length, transferRate: pct(wrong.filter((x) => x.finalCorrect).length, wrong.length),
        counterfactualAttempts: cf.length, boundaryUnderstanding: pct(cf.filter((x) => x.initialCorrect).length, cf.length), overgeneralizationRate: pct(cf.filter((x) => x.overgeneralized).length, cf.length),
      };
    };
    const byTruth = {};
    for (const g of ["EXPERT", "REVIEWER", "SYNTHETIC", "MODEL_DERIVED"]) { const rs = rows.filter((x) => x.ground_truth_source === g); if (rs.length) byTruth[g] = calc(rs); }
    const byArm = {};
    for (const a of ["SOP_ONLY", "SOP_PLUS_JUDGMENT"]) { const rs = rows.filter((x) => x.arm === a); if (rs.length) byArm[a] = { immediate: calc(rs.filter((x) => x.phase === "immediate")), retest: calc(rs.filter((x) => x.phase === "retest")) }; }
    const humanValidated = rows.filter((x) => ["EXPERT", "REVIEWER"].includes(x.ground_truth_source));
    return { ...calc(rows), byGroundTruth: byTruth, humanValidated: calc(humanValidated), byArm };
  }

  async function knowledgeStats(q, workflowId) {
    const [k] = await q(`SELECT
        count(*) FILTER (WHERE j.status <> 'rejected')::int AS judgments,
        count(*) FILTER (WHERE j.status = 'approved')::int AS approved,
        count(*) FILTER (WHERE j.status = 'observed')::int AS awaiting_validation,
        count(*) FILTER (WHERE j.status = 'approved' AND v.content->'fields'->'exception'->>'status' = 'EXPERT_STATED')::int AS exceptions,
        count(*) FILTER (WHERE j.status = 'approved' AND v.content->'boundary'->>'status' = 'confirmed')::int AS boundaries,
        count(*) FILTER (WHERE j.status = 'approved' AND (v.content->'fields'->'decision'->>'status' = 'INSUFFICIENT_EVIDENCE' OR v.content->'fields'->'reason'->>'status' = 'INSUFFICIENT_EVIDENCE'))::int AS insufficient
      FROM judgments j JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version WHERE ${wfFilter("j", 1)}`, [workflowId]);
    const [d] = await q(`SELECT count(*)::int AS gaps, count(*) FILTER (WHERE d.status = 'confirmed')::int AS confirmed FROM documentation_conflicts d JOIN judgments j ON j.id = d.judgment_id WHERE ${wfFilter("j", 1)}`, [workflowId]);
    const [c] = await q(`SELECT count(*)::int AS conflicts, count(*) FILTER (WHERE status = 'open')::int AS open FROM expert_conflicts c WHERE ${wfFilter("c", 1)}`, [workflowId]);
    const [st] = await q(`SELECT count(*)::int AS stale FROM knowledge_artifacts a WHERE a.status = 'active' AND a.last_validated_at < now() - ($2 || ' days')::interval AND ${wfFilter("a", 1)}`, [workflowId, String(STALE_DAYS)]);
    const [s] = await q(`SELECT count(*)::int AS sessions, count(*) FILTER (WHERE status = 'no_judgment')::int AS quiet,
                                (SELECT count(*)::int FROM session_dialogue sd JOIN expert_sessions es ON es.id = sd.session_id WHERE ${wfFilter("es", 1)}) AS questions
                         FROM expert_sessions s WHERE ${wfFilter("s", 1)}`, [workflowId]);
    return { judgmentsCaptured: k.judgments, knowledgeCaptured: k.approved, awaitingValidation: k.awaiting_validation, exceptionsCaptured: k.exceptions, boundariesConfirmed: k.boundaries,
      insufficientEvidence: k.insufficient, documentationGaps: d.gaps, documentationGapsConfirmed: d.confirmed, expertConflicts: c.conflicts, expertConflictsOpen: c.open, staleKnowledge: st.stale,
      sessions: s.sessions, sessionsWithoutInterruption: s.quiet, questionsAsked: s.questions };
  }

  async function cost(q, workflowId) {
    const [t] = await q(`SELECT count(*)::int AS calls, COALESCE(sum(prompt_tokens),0)::bigint AS input, COALESCE(sum(output_tokens + thought_tokens),0)::bigint AS output,
                                COALESCE(sum((tokens_by_modality->>'IMAGE')::int),0)::bigint AS image, COALESCE(sum((tokens_by_modality->>'AUDIO')::int),0)::bigint AS audio,
                                COALESCE(sum(cost_usd),0)::float AS cost, count(*) FILTER (WHERE status <> 'ok')::int AS failed,
                                count(*) FILTER (WHERE status = 'skipped_budget')::int AS budget_blocked
                         FROM ai_inferences i WHERE i.pipeline = 'live' AND i.created_at > now() - interval '30 days' AND ($1::uuid IS NULL OR i.workflow_id = $1::uuid)`, [workflowId]);
    const byOp = await q(`SELECT op, count(*)::int AS calls, COALESCE(sum(prompt_tokens + output_tokens + thought_tokens),0)::bigint AS tokens, COALESCE(sum(cost_usd),0)::float AS cost,
                                 round(avg(latency_ms))::int AS avg_ms FROM ai_inferences i WHERE i.pipeline = 'live' AND i.created_at > now() - interval '30 days'
                                 AND ($1::uuid IS NULL OR i.workflow_id = $1::uuid) GROUP BY op ORDER BY tokens DESC`, [workflowId]);
    const [s] = await q(`SELECT count(DISTINCT session_id)::int AS sessions FROM ai_inferences i WHERE session_id IS NOT NULL AND pipeline = 'live' AND ($1::uuid IS NULL OR i.workflow_id = $1::uuid)`, [workflowId]);
    const [v] = await q(`SELECT count(*)::int AS validated FROM knowledge_artifacts a WHERE ${wfFilter("a", 1)}`, [workflowId]);
    const [o] = await q("SELECT settings FROM organizations WHERE id = app_org()");
    const [month] = await q("SELECT COALESCE(sum(cost_usd),0)::float AS cost FROM ai_usage_daily WHERE day >= date_trunc('month', now())::date");
    const tokens = Number(t.input) + Number(t.output);
    return {
      calls: t.calls, inputTokens: Number(t.input), outputTokens: Number(t.output), imageTokens: Number(t.image), audioTokens: Number(t.audio), estimatedCostUsd: t.cost, failedCalls: t.failed, budgetBlocked: t.budget_blocked,
      costPerSession: s.sessions ? t.cost / s.sessions : null, costPerValidatedJudgment: v.validated ? t.cost / v.validated : null,
      validatedPer100kTokens: tokens ? Math.round((v.validated / tokens) * 100000 * 10) / 10 : null,
      byOp, monthToDateUsd: month.cost, monthlyBudgetUsd: o?.settings?.aiMonthlyBudgetUsd ?? null,
    };
  }

  async function risk(q) {
    const rows = await q(`
      SELECT w.id, w.name,
        (SELECT count(*)::int FROM knowledge_artifacts a WHERE a.workflow_id = w.id AND a.status = 'active') AS critical,
        (SELECT count(DISTINCT v.actor_person_id)::int FROM knowledge_validations v JOIN knowledge_artifacts a ON a.id = v.artifact_id WHERE a.workflow_id = w.id AND v.kind IN ('EXPERT_CONFIRMED','PEER_CONFIRMED')) AS experts,
        (SELECT count(*)::int FROM (
            SELECT la.learner_person_id FROM learner_attempts la WHERE la.workflow_id = w.id AND la.status = 'complete'
            GROUP BY la.learner_person_id
            HAVING count(DISTINCT la.judgment_id) FILTER (WHERE (la.result->>'finalCorrect')::boolean AND la.kind = 'apply')
                     >= (SELECT count(*) FROM knowledge_artifacts a WHERE a.workflow_id = w.id AND a.status = 'active')
               AND count(DISTINCT la.judgment_id) FILTER (WHERE la.kind = 'counterfactual' AND (la.result->>'initialCorrect')::boolean)
                     >= (SELECT count(*) FROM knowledge_artifacts a WHERE a.workflow_id = w.id AND a.status = 'active')) x) AS successors
      FROM workflows w WHERE w.deleted_at IS NULL ORDER BY w.created_at`);
    return rows.map((r) => ({ workflowId: r.id, area: r.name, criticalJudgments: r.critical, experts: r.experts, trainedSuccessors: r.successors,
      level: !r.critical ? "unknown" : r.experts <= 1 && r.successors === 0 ? "red" : r.experts <= 2 && r.successors <= 1 ? "yellow" : "green" }));
  }

  return {
    async summary(ctx, workflowId = null) {
      requirePermission(ctx, "workflow.read");
      return T(ctx, async (q) => {
        const k = await knowledgeStats(q, workflowId);
        const t = await transfer(q, workflowId);
        const r = await risk(q);
        return { knowledge: k, transfer: { attempts: t.attempts, transferRate: t.transferRate, boundaryUnderstanding: t.boundaryUnderstanding }, risk: r, atRisk: r.filter((x) => x.level === "red").length };
      });
    },
    async metrics(ctx, workflowId = null) {
      requirePermission(ctx, "analytics.read");
      return T(ctx, async (q) => ({ knowledge: await knowledgeStats(q, workflowId), transfer: await transfer(q, workflowId), risk: await risk(q) }));
    },
    async cost(ctx, workflowId = null) {
      requirePermission(ctx, "ai.cost.read");
      return T(ctx, async (q) => {
        const c = await cost(q, workflowId);
        const benchmarks = await q("SELECT id, model, ground_truth_source, summary, notes, created_at FROM benchmark_runs ORDER BY created_at DESC LIMIT 5");
        return { ...c, benchmarks };
      });
    },
    async inferences(ctx, { sessionId = null, limit = 50 } = {}) {
      requirePermission(ctx, "ai.cost.read");
      return T(ctx, (q) => q(`SELECT created_at, op, model, input_types, media_items, media_resolution, context_chars, context_manifest, prompt_tokens, output_tokens, thought_tokens,
                                     tokens_by_modality, cost_usd::float, latency_ms, status, error_category, confidence, result_summary, pipeline
                              FROM ai_inferences WHERE ($1::uuid IS NULL OR session_id = $1::uuid) ORDER BY created_at DESC LIMIT $2`, [sessionId, Math.min(limit, 200)]));
    },
    async audit(ctx, { before = null, limit = 50 } = {}) {
      requirePermission(ctx, "audit.read");
      return T(ctx, (q) => q(`SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.outcome, a.metadata, p.display_name AS actor
                              FROM audit_events a LEFT JOIN people p ON p.user_id = a.actor_user_id
                              WHERE ($1::bigint IS NULL OR a.id < $1::bigint) ORDER BY a.id DESC LIMIT $2`, [before, Math.min(limit, 200)]));
    },
    async experiments(ctx, workflowId) {
      requirePermission(ctx, "analytics.read");
      return T(ctx, async (q) => {
        const exps = await q("SELECT * FROM experiments WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 5", [workflowId]);
        if (!exps.length) return [];
        const t = await transfer(q, workflowId);
        return exps.map((e) => ({ ...e, results: e.status === "running" ? t.byArm : null }));
      });
    },
    async workflowInsights(ctx, workflowId) {
      requirePermission(ctx, "knowledge.read");
      return T(ctx, async (q) => {
        const gaps = await q(`SELECT d.id, d.gap_type, d.documented_procedure, d.observed_behavior, d.analysis, d.status, j.title FROM documentation_conflicts d JOIN judgments j ON j.id = d.judgment_id WHERE j.workflow_id = $1 ORDER BY d.created_at DESC LIMIT 50`, [workflowId]);
        const conflicts = await q(`SELECT c.id, c.relation, c.hidden_variable, c.status, pa.display_name AS a, pb.display_name AS b FROM expert_conflicts c
                                   JOIN judgments ja ON ja.id = c.judgment_a JOIN people pa ON pa.id = ja.expert_person_id JOIN judgments jb ON jb.id = c.judgment_b JOIN people pb ON pb.id = jb.expert_person_id
                                   WHERE c.workflow_id = $1 ORDER BY c.created_at DESC LIMIT 50`, [workflowId]);
        return { gaps, conflicts };
      });
    },
  };
}

/** Inference sink: persists every model call and maintains the daily rollup used for budgets. */
export function inferenceSink(db) {
  return async (e) => {
    if (!e.orgId) return;
    await db.system(async (q) => {
      await q(`INSERT INTO ai_inferences (org_id, request_id, session_id, workflow_id, op, model, pipeline, input_types, media_items, media_resolution, context_chars, context_manifest,
                                          prompt_tokens, output_tokens, thought_tokens, tokens_by_modality, cost_usd, latency_ms, status, error_category, confidence, result_summary)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [e.orgId, e.requestId, e.sessionId, e.workflowId, e.op, e.model, e.pipeline, e.inputTypes, e.mediaItems ?? 0, e.mediaResolution, e.contextChars ?? 0, e.manifest ? JSON.stringify(e.manifest) : null,
          e.promptTokens ?? 0, e.outputTokens ?? 0, e.thoughtTokens ?? 0, JSON.stringify(e.byModality ?? {}), e.costUsd ?? 0, e.latencyMs ?? 0, e.status, e.errorCategory, e.confidence ?? null, e.result ? String(e.result).slice(0, 300) : null]);
      if (e.pipeline === "live") {
        await q(`INSERT INTO ai_usage_daily (org_id, day, op, calls, input_tokens, output_tokens, image_tokens, cost_usd) VALUES ($1, current_date, $2, 1, $3, $4, $5, $6)
                 ON CONFLICT (org_id, day, op) DO UPDATE SET calls = ai_usage_daily.calls + 1, input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
                 output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens, image_tokens = ai_usage_daily.image_tokens + EXCLUDED.image_tokens, cost_usd = ai_usage_daily.cost_usd + EXCLUDED.cost_usd`,
          [e.orgId, e.op, e.promptTokens ?? 0, (e.outputTokens ?? 0) + (e.thoughtTokens ?? 0), e.byModality?.IMAGE ?? 0, e.costUsd ?? 0]);
      }
    });
  };
}

/** Budget guard: block AI calls once an organization exceeds its monthly AI budget (cached 30 s). */
const budgetCache = new Map();
/** Called when an organization's budget settings change, so the new limit applies immediately. */
export function invalidateBudget(orgId) { budgetCache.delete(orgId); }
export function budgetGuard(db) {
  const cache = budgetCache;
  return async (orgId) => {
    const c = cache.get(orgId);
    if (c && Date.now() - c.at < 30000) return c.ok;
    const [r] = await db.system((q) => q(`SELECT (o.settings->>'aiMonthlyBudgetUsd')::float AS budget,
                                            COALESCE((SELECT sum(cost_usd) FROM ai_usage_daily u WHERE u.org_id = o.id AND u.day >= date_trunc('month', now())::date), 0)::float AS spent
                                          FROM organizations o WHERE o.id = $1`, [orgId]));
    const ok = !r || r.budget == null || r.spent < r.budget;
    cache.set(orgId, { ok, at: Date.now() });
    return ok;
  };
}
export { httpError };
