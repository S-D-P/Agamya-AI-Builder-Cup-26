// MISSING KNOWLEDGE DETECTIVE: Capture → Analyze → Identify gap → Ask expert → Record answer → Approve → Update versioned
// knowledge → Re-evaluate. AI proposals never become knowledge without the contributor's approval; every step is audited and
// every applied change creates a new judgment (and, once approved, knowledge) version.
import { requirePermission } from "../platform/authz.mjs";
import { missionFocusFor } from "./missions.mjs";
import { httpError, scanForInjection } from "../platform/security.mjs";
import { enqueue } from "../platform/jobs.mjs";
import { audit } from "../platform/audit.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { toRule } from "../ai/context.mjs";
import { CHAIN_FIELDS } from "../ai/validators.mjs";
import { ruleGaps, detectGaps, integrateGapAnswer } from "../ai/ops/detective.mjs";
import { normalizeLanguage } from "../ai/language.mjs";
import { visibleSql, viewerOf, compactFor } from "./knowledge.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GAP_ACTIONS = ["approve", "reject_proposal", "accept_unresolved", "defer", "not_applicable", "reopen"];

export function createGaps({ db }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function latest(q, judgmentId) {
    const [v] = await q("SELECT * FROM judgment_versions WHERE judgment_id = $1 ORDER BY version DESC LIMIT 1", [judgmentId]);
    return v;
  }

  /** Job: detect gaps for a judgment. Idempotent: (judgment_id, dedupe_key) is unique, so retries never duplicate a gap. */
  async function detectJob({ judgmentId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const [j] = await q("SELECT j.*, s.language, s.sim_state FROM judgments j JOIN expert_sessions s ON s.id = j.session_id WHERE j.id = $1", [judgmentId]);
      if (!j || j.status === "rejected") return null;
      const v = await latest(q, j.id);
      const wf = (await q("SELECT * FROM workflows WHERE id = $1", [j.workflow_id]))[0];
      const [sess] = await q("SELECT mission_id FROM expert_sessions WHERE id = $1", [j.session_id]);
      wf.missionFocus = await missionFocusFor(q, sess?.mission_id);
      const procedure = j.procedure_id ? (await q("SELECT * FROM workflow_procedures WHERE id = $1", [j.procedure_id]))[0] : null;
      const obs = await q("SELECT id, seq, modality, text FROM observations WHERE session_id = $1 AND deleted_at IS NULL AND NOT dropped AND text <> '' ORDER BY seq DESC LIMIT 40", [j.session_id]);
      const dialogue = await q("SELECT question, answer FROM session_dialogue WHERE session_id = $1 AND answer IS NOT NULL ORDER BY seq", [j.session_id]);
      const existing = await q("SELECT dedupe_key, missing FROM knowledge_gaps WHERE judgment_id = $1", [j.id]);
      return { j, v, wf, procedure, obs: obs.reverse(), dialogue, existing };
    });
    if (!prep) return { skipped: true };
    const { j, v, wf, procedure, obs, dialogue, existing } = prep;
    const language = normalizeLanguage(j.language);
    const events = obs.map((o) => ({ id: `e${o.seq}`, obsId: o.id, modality: o.modality, text: o.text }));
    const rules = ruleGaps(v.content, { language });
    const ai = await withAiContext({ orgId: ctx.orgId, workflowId: wf.id, sessionId: j.session_id }, () =>
      detectGaps({ wf, procedure, content: v.content, events, dialogue, language, already: [...existing.map((e) => e.missing), ...rules.map((r) => r.missing)] }));
    // A rule gap already covers a field; the AI's view of the same field is not added twice.
    const ruleFields = new Set(rules.map((r) => r.field));
    const gaps = [...rules, ...ai.gaps.filter((g) => !g.field || !ruleFields.has(g.field))];
    const aliasToObs = new Map(events.map((e) => [e.id, e.obsId]));
    const inserted = await T(ctx, async (q) => {
      let n = 0;
      for (const g of gaps) {
        const evidence = (g.evidenceEventIds ?? []).map((id) => aliasToObs.get(id)).filter(Boolean);
        const r = await q(`INSERT INTO knowledge_gaps (org_id, judgment_id, kind, field, missing, why_it_matters, evidence_observation_ids, basis, question, question_language, dedupe_key)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (judgment_id, dedupe_key) DO NOTHING RETURNING id`,
          [ctx.orgId, j.id, g.kind, g.field ?? null, g.missing.slice(0, 600), g.whyItMatters.slice(0, 600), evidence, g.basis, g.question.slice(0, 600), language, g.dedupeKey]);
        n += r.length;
      }
      return n;
    });
    return { rules: rules.length, ai: ai.gaps.length, aiSource: ai.source, inserted };
  }

  async function loadVisible(q, ctx, gapId) {
    if (!UUID.test(String(gapId))) throw httpError(404, "gap not found");
    const viewer = await viewerOf(q, ctx);
    const [g] = await q(`SELECT g.*, j.expert_person_id, j.status AS judgment_status, j.workflow_id FROM knowledge_gaps g JOIN judgments j ON j.id = g.judgment_id
                         LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id WHERE g.id = $1 AND ${visibleSql(viewer)}`, [gapId]);
    if (!g) throw httpError(404, "gap not found");
    return g;
  }

  function view(ctx, g, evidence = []) {
    return {
      id: g.id, kind: g.kind, field: g.field, missing: g.missing, whyItMatters: g.why_it_matters, basis: g.basis, question: g.question, questionLanguage: g.question_language,
      status: g.status, answer: g.answer_text, answerOriginal: g.answer_original, answerLanguage: g.answer_language, answerSource: g.answer_source, answeredAt: g.answered_at,
      proposal: g.proposal, proposalSource: g.proposal_source, appliedVersion: g.applied_version, decisionNote: g.decision_note, decidedAt: g.decided_at,
      evidence: evidence.filter((e) => g.evidence_observation_ids?.includes(e.id)).map((e) => ({ id: e.id, alias: `e${e.seq}`, modality: e.modality, text: e.text, capturedAt: e.captured_at, deleted: Boolean(e.deleted_at) })),
      canAnswer: ctx.personId === g.expert_person_id,
    };
  }

  async function list(ctx, judgmentId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [j] = await q(`SELECT j.id, j.session_id, j.expert_person_id FROM judgments j LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id WHERE j.id = $1 AND ${visibleSql(viewer)}`, [judgmentId]);
      if (!j) throw httpError(404, "judgment not found");
      const gaps = await q("SELECT g.*, $2::uuid AS expert_person_id FROM knowledge_gaps g WHERE g.judgment_id = $1 ORDER BY g.status = 'open' DESC, g.created_at", [j.id, j.expert_person_id]);
      const ids = [...new Set(gaps.flatMap((g) => g.evidence_observation_ids))];
      const evidence = ids.length ? await q("SELECT id, seq, modality, text, captured_at, deleted_at FROM observations WHERE id = ANY($1::uuid[])", [ids]) : [];
      const [job] = await q("SELECT status FROM jobs WHERE kind = 'detect_gaps' AND idempotency_key LIKE $1 ORDER BY created_at DESC LIMIT 1", [`${j.id}:detect:%`]);
      return { analyzing: ["queued", "running"].includes(job?.status), gaps: gaps.map((g) => view(ctx, g, evidence)) };
    });
  }

  /** The contributor answers. The AI then proposes a change (job), which the contributor approves or rejects. */
  async function answer(ctx, gapId, { text, language = null, source = "typed", original = null }) {
    requirePermission(ctx, "workflow.read");
    const clean = String(text ?? "").trim().slice(0, 3000);
    if (!clean) throw httpError(400, "answer required");
    return T(ctx, async (q) => {
      const g = await loadVisible(q, ctx, gapId);
      if (g.expert_person_id !== ctx.personId) throw httpError(403, "only the person who contributed this knowledge can answer its gaps");
      if (!["open", "deferred", "answered"].includes(g.status)) throw httpError(409, "this gap is already closed; reopen it first");
      const src = ["typed", "voice", "voice_corrected"].includes(source) ? source : "typed";
      await q(`UPDATE knowledge_gaps SET status = 'answered', answer_text = $2, answer_original = $3, answer_language = $4, answer_source = $5, answered_by = $6, answered_at = now(),
               proposal = NULL, proposal_source = NULL, updated_at = now() WHERE id = $1`,
        [g.id, clean, original ? String(original).slice(0, 3000) : null, normalizeLanguage(language ?? g.question_language), src, ctx.personId]);
      const flags = scanForInjection(clean);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "knowledge.gap_answer", targetType: "knowledge_gap", targetId: g.id, requestId: ctx.requestId, metadata: { source: src, flags } });
      const job = await enqueue(q, { orgId: ctx.orgId, kind: "propose_gap_change", key: `${g.id}:${Date.now()}`, payload: { gapId: g.id } });
      return { status: "answered", jobId: job.id };
    });
  }

  async function proposeJob({ gapId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const [g] = await q("SELECT * FROM knowledge_gaps WHERE id = $1 AND status = 'answered'", [gapId]);
      if (!g) return null;
      return { g, v: await latest(q, g.judgment_id), wf: (await q("SELECT j.workflow_id, j.session_id FROM judgments j WHERE j.id = $1", [g.judgment_id]))[0] };
    });
    if (!prep) return { skipped: true };
    const { g, v, wf } = prep;
    const p = await withAiContext({ orgId: ctx.orgId, workflowId: wf.workflow_id, sessionId: wf.session_id }, () =>
      integrateGapAnswer({ gap: { kind: g.kind, field: g.field, missing: g.missing, question: g.question }, content: v.content, answer: g.answer_text, language: g.answer_language }));
    const proposal = { field: p.field, value: p.value, valueEn: p.valueEn ?? "", quote: p.quote, quoteVerified: p.quoteVerified, resolves: p.resolves, explanation: p.explanation,
      before: v.content.fields?.[p.field] ?? null, baseVersion: v.version,
      // Overwriting something the expert already stated is allowed (they approve it) but must never be silent.
      replacesExpertStated: v.content.fields?.[p.field]?.status === "EXPERT_STATED" && Boolean(v.content.fields?.[p.field]?.value) && v.content.fields[p.field].value.trim() !== String(p.value ?? "").trim() };
    await T(ctx, (q) => q("UPDATE knowledge_gaps SET proposal = $2, proposal_source = $3, updated_at = now() WHERE id = $1 AND status = 'answered'", [g.id, JSON.stringify(proposal), p.source]));
    return { proposed: true, source: p.source };
  }

  /** approve: apply the proposal as a new version (and knowledge version, if approved knowledge exists), then re-evaluate. */
  async function decide(ctx, gapId, { action, note = "", value = null }) {
    requirePermission(ctx, "workflow.read");
    if (!GAP_ACTIONS.includes(action)) throw httpError(400, "invalid action");
    const out = await T(ctx, async (q) => {
      const g = await loadVisible(q, ctx, gapId);
      if (g.expert_person_id !== ctx.personId) throw httpError(403, "only the person who contributed this knowledge can decide on its gaps");
      const memo = String(note ?? "").slice(0, 500);
      if (action === "reopen") {
        await q("UPDATE knowledge_gaps SET status = 'open', decided_by = NULL, decided_at = NULL, decision_note = NULL, updated_at = now() WHERE id = $1", [g.id]);
      } else if (["accept_unresolved", "defer", "not_applicable"].includes(action)) {
        const status = { accept_unresolved: "accepted_unresolved", defer: "deferred", not_applicable: "not_applicable" }[action];
        await q("UPDATE knowledge_gaps SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1", [g.id, status, ctx.personId, memo]);
      } else if (action === "reject_proposal") {
        if (!g.proposal) throw httpError(409, "nothing to reject");
        await q("UPDATE knowledge_gaps SET status = 'open', proposal = NULL, decision_note = $2, updated_at = now() WHERE id = $1", [g.id, memo || "proposal rejected"]);
      } else {
        if (!g.proposal) throw httpError(409, "the proposed change is not ready yet");
        const v = await latest(q, g.judgment_id);
        const p = g.proposal;
        if (!CHAIN_FIELDS.includes(p.field)) throw httpError(400, "invalid field");
        const finalValue = typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : p.value;
        const content = structuredClone(v.content);
        // The expert's own words support the change; if they edited the wording, the edit itself is their statement.
        content.fields[p.field] = { value: finalValue, valueEn: finalValue === p.value ? p.valueEn ?? "" : "", status: "EXPERT_STATED", quote: finalValue === p.value ? p.quote : finalValue, eventIds: [], viaGap: g.id };
        if (p.field === "exception" || p.field === "boundary") { content.boundary = { ...(content.boundary ?? {}), status: "confirmed", confirmedByExpert: true }; }
        content.rule = toRule({ ...Object.fromEntries(CHAIN_FIELDS.map((k) => [k, content.fields[k]?.value ?? ""])), boundary: content.boundary });
        const version = v.version + 1;
        await q("INSERT INTO judgment_versions (org_id, judgment_id, version, content, verification, author_type, author_user_id) VALUES ($1,$2,$3,$4,$5,'expert',$6)",
          [ctx.orgId, g.judgment_id, version, JSON.stringify(content), JSON.stringify({ notes: [`missing knowledge filled (${g.kind}): ${p.field} is now expert-stated`], gapId: g.id }), ctx.userId]);
        await q("UPDATE judgments SET current_version = $2, version = version + 1, updated_at = now() WHERE id = $1", [g.judgment_id, version]);
        const [a] = await q("SELECT id, current_version FROM knowledge_artifacts WHERE judgment_id = $1 AND status = 'active'", [g.judgment_id]);
        if (a) {
          const kv = a.current_version + 1;
          await q("INSERT INTO knowledge_versions (org_id, artifact_id, version, judgment_version, rule, compact) VALUES ($1,$2,$3,$4,$5,$6)", [ctx.orgId, a.id, kv, version, content.rule, JSON.stringify(compactFor(content))]);
          await q("UPDATE knowledge_artifacts SET current_version = $2, last_validated_at = now(), updated_at = now() WHERE id = $1", [a.id, kv]);
          await enqueue(q, { orgId: ctx.orgId, kind: "compile_knowledge", key: `${a.id}:${kv}`, payload: { artifactId: a.id, version: kv } });
        }
        // Re-evaluate: this gap is resolved only if the answer actually filled it; rule gaps no longer triggered by the new content close too.
        await q("UPDATE knowledge_gaps SET status = $2, applied_version = $3, decided_by = $4, decided_at = now(), decision_note = $5, updated_at = now() WHERE id = $1",
          [g.id, p.resolves ? "resolved" : "open", version, ctx.personId, p.resolves ? memo : (memo || "answer recorded, but it did not fully fill the gap")]);
        const still = new Set(ruleGaps(content).map((r) => r.dedupeKey));
        await q(`UPDATE knowledge_gaps SET status = 'resolved', applied_version = $2::int, decision_note = 'no longer missing after version ' || $2::int::text, updated_at = now()
                 WHERE judgment_id = $1 AND basis = 'RULE' AND status IN ('open','deferred') AND NOT (dedupe_key = ANY($3::text[]))`, [g.judgment_id, version, [...still]]);
      }
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: `knowledge.gap_${action}`, targetType: "knowledge_gap", targetId: g.id, requestId: ctx.requestId });
      return { judgmentId: g.judgment_id };
    });
    return { ...(await list(ctx, out.judgmentId)), judgmentId: out.judgmentId };
  }

  /** Re-run detection on demand (e.g. after a correction). New dedupe key per request; existing gaps are never duplicated. */
  async function reanalyze(ctx, judgmentId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const viewer = await viewerOf(q, ctx);
      const [j] = await q(`SELECT j.id, j.expert_person_id FROM judgments j LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id WHERE j.id = $1 AND ${visibleSql(viewer)}`, [judgmentId]);
      if (!j) throw httpError(404, "judgment not found");
      if (j.expert_person_id !== ctx.personId) throw httpError(403, "only the contributor can request a new analysis");
      const [{ n }] = await q("SELECT count(*)::int AS n FROM jobs WHERE kind = 'detect_gaps' AND idempotency_key LIKE $1", [`${j.id}:detect:%`]);
      if (n >= 6) throw httpError(429, "this knowledge has been analysed several times already");
      return enqueue(q, { orgId: ctx.orgId, kind: "detect_gaps", key: `${j.id}:detect:${n + 1}`, payload: { judgmentId: j.id } });
    });
  }

  return { list, answer, decide, reanalyze, handlers: { detect_gaps: detectJob, propose_gap_change: proposeJob } };
}
