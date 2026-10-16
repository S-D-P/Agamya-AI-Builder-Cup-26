// Workflows are configuration (data), never code: modalities, documents, procedures, people.
import { requirePermission } from "../platform/authz.mjs";
import { httpError, sha256, validateUpload, sanitizeText, scanForInjection } from "../platform/security.mjs";
import { objectKey } from "../platform/storage.mjs";
import { enqueue } from "../platform/jobs.mjs";
import { audit } from "../platform/audit.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { understandWorkflow } from "../ai/ops/perception.mjs";
import { SIM_SOURCES } from "../sim/workflows/index.mjs";

const KINDS = ["software", "physical", "document", "hybrid"];
const MODALITY_KEYS = ["screen", "camera", "microphone", "documents", "app_events"];
const LIVE_SOURCES = ["live:screen", "live:camera", "live:audio", "manual"];

export function createWorkflows({ db, storage, cfg }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function list(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, (q) => q(`
      SELECT w.id, w.key, w.name, w.description, w.kind, w.modalities, w.capture_sources, w.source, w.status, w.updated_at,
        (SELECT count(*)::int FROM workflow_participants p WHERE p.workflow_id = w.id AND p.participation = 'EXPERT') AS experts,
        (SELECT count(*)::int FROM workflow_participants p WHERE p.workflow_id = w.id AND p.participation = 'LEARNER') AS learners,
        (SELECT count(*)::int FROM knowledge_artifacts a WHERE a.workflow_id = w.id AND a.status = 'active') AS knowledge,
        (SELECT count(DISTINCT j.expert_person_id)::int FROM knowledge_artifacts a JOIN judgments j ON j.id = a.judgment_id WHERE a.workflow_id = w.id AND a.status = 'active') AS knowledge_holders,
        (SELECT count(*)::int FROM learner_attempts la WHERE la.workflow_id = w.id AND la.status = 'complete' AND (la.result->>'finalCorrect')::boolean) AS successful_attempts,
        (SELECT count(*)::int FROM learner_attempts la WHERE la.workflow_id = w.id AND la.status = 'complete') AS completed_attempts,
        (SELECT count(*)::int FROM expert_sessions s WHERE s.workflow_id = w.id) AS sessions
      FROM workflows w WHERE w.deleted_at IS NULL ORDER BY w.source DESC, w.created_at`));
  }

  async function get(ctx, id) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const [w] = await q("SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL", [id]);
      if (!w) throw httpError(404, "workflow not found");
      const procedures = await q("SELECT id, key, title, applies_when, steps, default_decision, source FROM workflow_procedures WHERE workflow_id = $1 ORDER BY key", [id]);
      const documents = await q("SELECT id, title, mime_type, sha256, injection_flags, created_at, length(text_content) AS chars FROM workflow_documents WHERE workflow_id = $1", [id]);
      const people = await q(`SELECT p.id, p.display_name, p.title, wp.participation, p.user_id IS NOT NULL AS has_login FROM workflow_participants wp JOIN people p ON p.id = wp.person_id
                              WHERE wp.workflow_id = $1 ORDER BY wp.participation, p.display_name`, [id]);
      const [job] = await q("SELECT status, last_error FROM jobs WHERE kind = 'understand_workflow' AND idempotency_key = $1", [id]);
      const simSources = w.capture_sources.filter((s) => s.startsWith("sim:")).map((s) => SIM_SOURCES[s]).filter(Boolean)
        .map((e) => ({ id: e.id, label: e.label, render: e.render, emits: e.emits, cases: e.cases.map((c) => ({ id: c.id, title: c.title, expertId: c.expertId, groundTruth: c.groundTruth })) }));
      return { ...w, procedures, documents, people, understanding: job ?? null, simSources };
    });
  }

  async function create(ctx, input, requestId) {
    requirePermission(ctx, "workflow.create");
    const name = String(input.name ?? "").trim().slice(0, 120);
    if (!name) throw httpError(400, "name is required");
    const kind = KINDS.includes(input.kind) ? input.kind : "hybrid";
    const modalities = Object.fromEntries(MODALITY_KEYS.map((k) => [k, Boolean(input.modalities?.[k])]));
    const sources = [...new Set((input.captureSources ?? []).filter((s) => LIVE_SOURCES.includes(s) || SIM_SOURCES[s]))];
    if (!sources.length) sources.push("manual");
    const docs = Array.isArray(input.documents) ? input.documents.slice(0, 5) : [];
    const [space] = await T(ctx, (q) => q("SELECT experience FROM organizations WHERE id = app_org()"));
    const living = space?.experience === "living";
    // A workplace procedure is compared against its documentation. Much living knowledge is oral: a written recipe or
    // instructions are optional there, and without one there is simply nothing to compare against.
    if (!docs.length && !living) throw httpError(400, "add at least one document so the documented procedure can be learned");
    const prepared = docs.map((d) => {
      const title = String(d.title ?? "Document").slice(0, 120);
      if (d.dataBase64) {
        const buf = Buffer.from(String(d.dataBase64), "base64");
        const mime = validateUpload(buf, { allow: ["application/pdf"], maxBytes: cfg.media.maxDocBytes });
        return { title, mime, buf, text: null };
      }
      const text = sanitizeText(d.text, 60000);
      if (text.trim().length < 20) throw httpError(400, `document "${title}" is empty`);
      return { title, mime: "text/plain", buf: Buffer.from(text, "utf8"), text };
    });
    const wf = await T(ctx, async (q) => {
      const [ws] = await q("SELECT id FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 1", [ctx.orgId]);
      const oral = !prepared.length;
      const [w] = await q(`INSERT INTO workflows (org_id, workspace_id, name, description, kind, modalities, capture_sources, owner_user_id, source, status, profile)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9,$10) RETURNING *`,
        [ctx.orgId, ws.id, name, String(input.description ?? "").slice(0, 500), kind, JSON.stringify(modalities), sources, ctx.userId, oral ? "active" : "learning",
          oral ? JSON.stringify({ domainSummary: String(input.description ?? "").slice(0, 500), source: "description", decisionPoints: [], likelyTacitAreas: [], riskAreas: [], vocabulary: [] }) : null]);
      for (const d of prepared) {
        const key = objectKey(ctx.orgId, "workflows", w.id, "docs", `${sha256(d.buf).slice(0, 24)}.${d.mime === "application/pdf" ? "pdf" : "txt"}`);
        await storage.put(key, d.buf, { contentType: d.mime });
        const [asset] = await q(`INSERT INTO media_assets (org_id, workflow_id, kind, modality, storage_key, mime_type, bytes, sha256, retention_class, status, created_by)
                                 VALUES ($1,$2,'document','DOCUMENT',$3,$4,$5,$6,'knowledge','processed',$7) RETURNING id`, [ctx.orgId, w.id, key, d.mime, d.buf.length, sha256(d.buf), ctx.userId]);
        await q(`INSERT INTO workflow_documents (org_id, workflow_id, title, mime_type, media_asset_id, text_content, sha256, injection_flags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ctx.orgId, w.id, d.title, d.mime, asset.id, d.text, sha256(d.buf), JSON.stringify(d.text ? scanForInjection(d.text) : [])]);
      }
      const people = [...(input.expertPersonIds ?? []).map((id) => [id, "EXPERT"]), ...(input.learnerPersonIds ?? []).map((id) => [id, "LEARNER"])];
      if (!people.some(([, p]) => p === "EXPERT") && ctx.personId) people.push([ctx.personId, "EXPERT"]);
      for (const [pid, part] of people) {
        const [ok] = await q("SELECT 1 FROM people WHERE id = $1", [pid]);
        if (!ok) throw httpError(400, "unknown person");
        await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ctx.orgId, w.id, pid, part]);
      }
      if (!oral) await enqueue(q, { orgId: ctx.orgId, kind: "understand_workflow", key: w.id, payload: { workflowId: w.id } });
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workflow.create", targetType: "workflow", targetId: w.id, requestId });
      return w;
    });
    return wf;
  }

  /**
   * One-tap start: the person names what they are about to do (or not) and gets a live-capture workflow they are the expert
   * on. No document is required; the Work Map built from the session becomes the documentation.
   */
  async function quickStart(ctx, { name, kind }, requestId) {
    requirePermission(ctx, "session.capture");
    const camera = kind === "camera";
    const title = String(name ?? "").trim().slice(0, 120) || (camera ? "A skill, shown on camera" : "A task, shown on screen");
    return T(ctx, async (q) => {
      const [ws] = await q("SELECT id FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 1", [ctx.orgId]);
      const modalities = { screen: !camera, camera, microphone: true, documents: false, app_events: false };
      const [w] = await q(`INSERT INTO workflows (org_id, workspace_id, name, description, kind, modalities, capture_sources, owner_user_id, source, status, profile)
                           VALUES ($1,$2,$3,'',$4,$5,$6,$7,'user','active',$8) RETURNING id, name`,
        [ctx.orgId, ws.id, title, camera ? "physical" : "software", JSON.stringify(modalities), [camera ? "live:camera" : "live:screen", "live:audio", "manual"], ctx.userId,
          JSON.stringify({ domainSummary: "", source: "live", decisionPoints: [], likelyTacitAreas: [], riskAreas: [], vocabulary: [] })]);
      await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,'EXPERT') ON CONFLICT DO NOTHING", [ctx.orgId, w.id, ctx.personId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workflow.quick_start", targetType: "workflow", targetId: w.id, requestId });
      return { workflowId: w.id, name: w.name, source: camera ? "live:camera" : "live:screen" };
    });
  }

  async function setParticipants(ctx, workflowId, { personId, participation, remove = false }, requestId) {
    requirePermission(ctx, "workflow.manage");
    if (!["EXPERT", "LEARNER"].includes(participation)) throw httpError(400, "invalid participation");
    return T(ctx, async (q) => {
      const [w] = await q("SELECT id FROM workflows WHERE id = $1", [workflowId]);
      const [p] = await q("SELECT id FROM people WHERE id = $1", [personId]);
      if (!w || !p) throw httpError(404, "not found");
      if (remove) await q("DELETE FROM workflow_participants WHERE workflow_id = $1 AND person_id = $2 AND participation = $3", [w.id, p.id, participation]);
      else await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [ctx.orgId, w.id, p.id, participation]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workflow.participants", targetType: "workflow", targetId: w.id, requestId, metadata: { personId, participation, remove } });
    });
  }

  async function people(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, (q) => q(`SELECT p.id, p.display_name, p.title, p.user_id IS NOT NULL AS has_login, COALESCE(m.roles, '{}') AS roles
                            FROM people p LEFT JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active' ORDER BY p.display_name`));
  }

  // ---------------------------------------------------------------- job: understand_workflow
  async function understandJob({ workflowId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const [wf] = await q("SELECT * FROM workflows WHERE id = $1", [workflowId]);
      const docs = await q("SELECT d.*, m.storage_key FROM workflow_documents d LEFT JOIN media_assets m ON m.id = d.media_asset_id WHERE d.workflow_id = $1", [workflowId]);
      return { wf, docs };
    });
    if (!prep.wf) return { skipped: true };
    const pdfs = [];
    for (const d of prep.docs.filter((x) => x.mime_type === "application/pdf")) {
      const b = await storage.get(d.storage_key);
      if (b) pdfs.push({ mimeType: "application/pdf", data: b.toString("base64") });
    }
    const profile = await withAiContext({ orgId: ctx.orgId, workflowId }, () => understandWorkflow({ wf: prep.wf, documents: prep.docs.filter((d) => d.text_content).map((d) => ({ title: d.title, text: d.text_content })), pdfs }));
    await T(ctx, async (q) => {
      await q("UPDATE workflows SET profile = $2, status = 'active', updated_at = now() WHERE id = $1", [workflowId, JSON.stringify({ ...profile, learnedAt: new Date().toISOString() })]);
      const [{ n }] = await q("SELECT count(*)::int AS n FROM workflow_procedures WHERE workflow_id = $1", [workflowId]);
      if (!n) {
        for (const [i, p] of profile.procedures.entries()) {
          await q(`INSERT INTO workflow_procedures (org_id, workflow_id, document_id, key, title, applies_when, steps, default_decision, source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'document')`, [ctx.orgId, workflowId, prep.docs[0]?.id ?? null, `P${String(i + 1).padStart(2, "0")}`, p.title.slice(0, 200), p.appliesWhen.slice(0, 500), JSON.stringify(p.steps.slice(0, 30)), p.defaultDecision.slice(0, 500)]);
        }
      }
      if (profile.suspiciousInstructions?.length) await audit(q, { orgId: ctx.orgId, action: "ai.injection_signal", targetType: "workflow", targetId: workflowId, metadata: { count: profile.suspiciousInstructions.length } });
    });
    return { procedures: profile.procedures.length };
  }

  /**
   * Delete a skill / workflow (managers). Hidden from every list; its sessions in progress are terminated. Approved
   * knowledge is not destroyed here: its contributor keeps control of it (withdraw it from the knowledge page).
   */
  async function remove(ctx, workflowId, requestId) {
    requirePermission(ctx, "workflow.manage");
    return T(ctx, async (q) => {
      const [w] = await q("SELECT id, name FROM workflows WHERE id = $1 AND deleted_at IS NULL", [workflowId]);
      if (!w) throw httpError(404, "not found");
      await q("UPDATE workflows SET deleted_at = now(), status = 'archived', updated_at = now() WHERE id = $1", [w.id]);
      const ended = await q(`UPDATE expert_sessions SET status = 'terminated', ended_at = COALESCE(ended_at, now()), updated_at = now()
                             WHERE workflow_id = $1 AND status IN ('awaiting_consent','capturing','mapping','debrief') RETURNING id`, [w.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workflow.delete", targetType: "workflow", targetId: w.id, requestId, metadata: { name: w.name, terminatedSessions: ended.length } });
      return { deleted: true, terminatedSessions: ended.length };
    });
  }

  return { list, get, create, quickStart, setParticipants, people, remove, handlers: { understand_workflow: understandJob } };
}
