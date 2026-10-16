// KT MISSIONS (Agamya Enterprise; also usable in Personal spaces). A mission ORCHESTRATES the existing engines (capture,
// Missing Knowledge Detective, Judgment Stress Test, learner assessment, Radar). It does not duplicate their logic.
//
// Stored states are explicit decisions only: draft, active, paused, blocked, cancelled, completed, completed_with_exceptions.
// The working stage of an active mission is DERIVED from records, so it cannot drift from reality:
//   awaiting_participants → ready_to_capture → capturing → knowledge_review → transfer_assessment
// A mission is completed only when every required item of the brief is satisfied or not applicable, approved knowledge
// exists and every receiver has an assessment result, OR when an authorised owner records an explicit exception.
//
// Access: space owners/admins/auditors read all missions; the coordinator manages theirs; participants read theirs
// (receivers see a reduced brief: blind spots, questions and acceptance criteria would give assessments away).
import { requirePermission, can } from "../platform/authz.mjs";
import { httpError, sha256, sanitizeText, scanForInjection, validateUpload } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { enqueue } from "../platform/jobs.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { assessRequirements } from "../ai/ops/missions.mjs";
import { normalizeLanguage } from "../ai/language.mjs";
import { visibleSql, viewerOf } from "./knowledge.mjs";
import { resolveGroupMembers } from "./groups.mjs";
import { notifyPerson } from "./notifications.mjs";
import { BUILTIN_TEMPLATES, templateByKey, cleanTemplateConfig, cleanBrief, parseBriefMarkdown, briefToMarkdown, motiSummary, requirementsFromBrief, CAPTURE_METHODS } from "./templates.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPLICIT = ["draft", "active", "paused", "blocked", "cancelled", "completed", "completed_with_exceptions"];
const CLOSED = ["cancelled", "completed", "completed_with_exceptions"];
export const STAGES = ["draft", "awaiting_participants", "ready_to_capture", "capturing", "knowledge_review", "transfer_assessment", "completed"];

export function createMissions({ db, storage, cfg, workflows, capture, transfers }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const isManager = (ctx) => ctx.roles.some((r) => ["ORG_OWNER", "ORG_ADMIN"].includes(r));

  // ---------------------------------------------------------------- access
  async function load(q, ctx, id) {
    if (!UUID.test(String(id))) throw httpError(404, "mission not found");
    const [m] = await q("SELECT * FROM kt_missions WHERE id = $1", [id]);
    if (!m) throw httpError(404, "mission not found");
    const parts = await q("SELECT role, status FROM mission_participants WHERE mission_id = $1 AND person_id = $2 AND status NOT IN ('removed','declined')", [m.id, ctx.personId ?? null]);
    const coordinator = m.coordinator_person_id === ctx.personId;
    const access = {
      manage: can(ctx, "mission.manage.any") || (coordinator && can(ctx, "mission.create")),
      readAll: can(ctx, "mission.read.any") || coordinator,
      expert: parts.some((p) => p.role === "expert"),
      receiver: parts.some((p) => p.role === "receiver"),
      coordinator,
    };
    // Drafts are visible to their coordinator and managers only; a participant learns of a mission when it is sent.
    const participant = (access.expert || access.receiver) && m.status !== "draft";
    if (!access.manage && !access.readAll && !participant) throw httpError(404, "mission not found");
    return { m, access };
  }
  const requireManage = (access) => { if (!access.manage) throw httpError(403, "only the mission's coordinator or an administrator can change it"); };

  // ---------------------------------------------------------------- templates
  async function templates(ctx) {
    requirePermission(ctx, "workflow.read");
    const custom = await T(ctx, (q) => q("SELECT id, name, base_key, config FROM kt_templates WHERE archived_at IS NULL ORDER BY name"));
    return {
      builtIn: BUILTIN_TEMPLATES,
      organization: custom.map((t) => ({ id: t.id, ...t.config, key: t.base_key, name: t.name, custom: true })),
      captureMethods: CAPTURE_METHODS,
      canSave: can(ctx, "mission.manage.any"),
    };
  }
  async function saveTemplate(ctx, { baseKey, config }, requestId) {
    requirePermission(ctx, "mission.manage.any");
    const base = templateByKey(baseKey);
    if (!base) throw httpError(400, "unknown base template");
    const clean = cleanTemplateConfig(config, base);
    return T(ctx, async (q) => {
      const [t] = await q("INSERT INTO kt_templates (org_id, name, base_key, config, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id", [ctx.orgId, clean.name, base.key, JSON.stringify(clean), ctx.userId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.template_save", targetType: "kt_template", targetId: t.id, requestId });
      return { id: t.id };
    });
  }
  async function resolveTemplate(q, { templateKey, templateId }) {
    if (templateId) {
      if (!UUID.test(String(templateId))) throw httpError(400, "unknown template");
      const [t] = await q("SELECT * FROM kt_templates WHERE id = $1 AND archived_at IS NULL", [templateId]);
      if (!t) throw httpError(400, "unknown template");
      return { ...t.config, key: t.base_key, name: t.name, customId: t.id };
    }
    const t = templateByKey(templateKey ?? "general");
    if (!t) throw httpError(400, "unknown template");
    return t;
  }

  // ---------------------------------------------------------------- participants
  async function validPeople(q, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => UUID.test(String(x))))].slice(0, 200);
    if (!list.length) return [];
    const found = await q("SELECT id FROM people WHERE id = ANY($1::uuid[])", [list]); // RLS: this space only
    if (found.length !== list.length) throw httpError(400, "unknown person");
    return list;
  }
  async function validGroups(q, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => UUID.test(String(x))))].slice(0, 20);
    if (!list.length) return [];
    const found = await q("SELECT id FROM groups WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [list]);
    if (found.length !== list.length) throw httpError(400, "unknown group");
    return list;
  }

  /**
   * Replace the assignment. Group members are resolved NOW (snapshot) and de-duplicated; a person assigned both
   * individually and through groups is one receiver. Later group changes do not alter this mission unless re-synced.
   */
  async function assign(q, ctx, m, { experts, receivers, receiverGroups }) {
    const ex = experts !== undefined ? await validPeople(q, experts) : null;
    const rc = receivers !== undefined ? await validPeople(q, receivers) : null;
    const gs = receiverGroups !== undefined ? await validGroups(q, receiverGroups) : null;
    if (ex) {
      await q("UPDATE mission_participants SET status = 'removed' WHERE mission_id = $1 AND role = 'expert' AND NOT (person_id = ANY($2::uuid[])) AND status <> 'removed'", [m.id, ex]);
      for (const pid of ex) await q(`INSERT INTO mission_participants (mission_id, org_id, person_id, role, added_by) VALUES ($1,$2,$3,'expert',$4)
                                     ON CONFLICT (mission_id, person_id, role) DO UPDATE SET status = CASE WHEN mission_participants.status = 'removed' THEN 'pending' ELSE mission_participants.status END, via_group_id = NULL`, [m.id, ctx.orgId, pid, ctx.userId]);
    }
    if (gs) {
      await q("UPDATE mission_groups SET removed_at = now() WHERE mission_id = $1 AND NOT (group_id = ANY($2::uuid[])) AND removed_at IS NULL", [m.id, gs]);
      for (const g of gs) await q("INSERT INTO mission_groups (mission_id, org_id, group_id) VALUES ($1,$2,$3) ON CONFLICT (mission_id, group_id) DO UPDATE SET removed_at = NULL, resolved_at = now()", [m.id, ctx.orgId, g]);
    }
    if (rc || gs) {
      const individual = rc ?? (await q("SELECT person_id FROM mission_participants WHERE mission_id = $1 AND role = 'receiver' AND via_group_id IS NULL AND status <> 'removed'", [m.id])).map((r) => r.person_id);
      const groups = gs ?? (await q("SELECT group_id FROM mission_groups WHERE mission_id = $1 AND removed_at IS NULL", [m.id])).map((r) => r.group_id);
      const viaGroups = await resolveGroupMembers(q, groups);
      const wanted = new Map(individual.map((pid) => [pid, null]));
      for (const [pid, gids] of viaGroups) if (!wanted.has(pid)) wanted.set(pid, gids[0]);
      const expertIds = new Set((await q("SELECT person_id FROM mission_participants WHERE mission_id = $1 AND role = 'expert' AND status <> 'removed'", [m.id])).map((r) => r.person_id));
      for (const pid of expertIds) wanted.delete(pid); // an expert is not their own receiver
      await q("UPDATE mission_participants SET status = 'removed' WHERE mission_id = $1 AND role = 'receiver' AND NOT (person_id = ANY($2::uuid[])) AND status <> 'removed'", [m.id, [...wanted.keys()]]);
      for (const [pid, via] of wanted) await q(`INSERT INTO mission_participants (mission_id, org_id, person_id, role, via_group_id, added_by) VALUES ($1,$2,$3,'receiver',$4,$5)
                                               ON CONFLICT (mission_id, person_id, role) DO UPDATE SET via_group_id = EXCLUDED.via_group_id,
                                                 status = CASE WHEN mission_participants.status = 'removed' THEN 'pending' ELSE mission_participants.status END`, [m.id, ctx.orgId, pid, via, ctx.userId]);
    }
  }

  async function participantsOf(q, m) {
    return q(`SELECT mp.person_id, mp.role, mp.status, mp.via_group_id, g.name AS via_group, p.display_name, p.title, p.user_id IS NOT NULL AS has_login, COALESCE(mem.roles, '{}') AS roles
              FROM mission_participants mp JOIN people p ON p.id = mp.person_id LEFT JOIN groups g ON g.id = mp.via_group_id
              LEFT JOIN memberships mem ON mem.user_id = p.user_id AND mem.org_id = p.org_id AND mem.status = 'active'
              WHERE mp.mission_id = $1 AND mp.status <> 'removed' ORDER BY mp.role, p.display_name`, [m.id]);
  }
  const eligibility = (p) => {
    if (!p.has_login) return "no sign-in: cannot be notified or take part until invited to the space";
    if (p.role === "expert" && !p.roles.includes("EXPERT")) return "missing the Subject matter expert role in this space";
    if (p.role === "receiver" && !p.roles.includes("LEARNER")) return "missing the Receiver role in this space";
    return null;
  };

  // ---------------------------------------------------------------- brief + requirements
  async function syncRequirements(q, m, brief, briefVersion) {
    const wanted = requirementsFromBrief(brief);
    const existing = await q("SELECT * FROM mission_requirements WHERE mission_id = $1 AND retired_at IS NULL", [m.id]);
    const key = (r) => `${r.kind}|${r.text.trim().toLowerCase()}`;
    const keep = new Set(wanted.map(key));
    for (const r of existing) if (!keep.has(key(r))) await q("UPDATE mission_requirements SET retired_at = now() WHERE id = $1", [r.id]);
    const have = new Set(existing.map(key));
    for (const [i, r] of wanted.entries()) {
      if (have.has(key(r))) await q("UPDATE mission_requirements SET position = $2 WHERE mission_id = $1 AND kind = $3 AND lower(text) = lower($4) AND retired_at IS NULL", [m.id, i, r.kind, r.text.trim()]);
      else await q("INSERT INTO mission_requirements (mission_id, org_id, kind, text, position, brief_version) VALUES ($1,$2,$3,$4,$5,$6)", [m.id, m.org_id, r.kind, r.text.trim(), i, briefVersion]);
    }
  }

  // ---------------------------------------------------------------- create / update
  async function create(ctx, input, requestId) {
    requirePermission(ctx, "mission.create");
    const name = String(input.name ?? "").trim().slice(0, 140);
    if (!name) throw httpError(400, "give the mission a name");
    return T(ctx, async (q) => {
      const tpl = await resolveTemplate(q, input);
      let coordinator = ctx.personId;
      if (input.coordinatorPersonId && input.coordinatorPersonId !== ctx.personId) {
        if (!isManager(ctx)) throw httpError(403, "only an administrator can make someone else the coordinator");
        const [c] = await q(`SELECT p.id FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active'
                             WHERE p.id = $1 AND (m.roles && ARRAY['KT_COORDINATOR','ORG_ADMIN']::text[])`, [input.coordinatorPersonId]);
        if (!c) throw httpError(400, "the coordinator must be a KT coordinator or administrator in this space");
        coordinator = c.id;
      }
      let workflowId = null;
      if (input.workflowId) {
        if (!UUID.test(String(input.workflowId))) throw httpError(400, "unknown workflow");
        const [w] = await q("SELECT id FROM workflows WHERE id = $1", [input.workflowId]);
        if (!w) throw httpError(400, "unknown workflow");
        workflowId = w.id;
      }
      const brief = cleanBrief({ questions: tpl.questions, acceptance: tpl.criteria, ...input.brief });
      const methods = (Array.isArray(input.captureMethods) ? input.captureMethods : tpl.captureMethods).filter((x) => CAPTURE_METHODS[x]);
      const [m] = await q(`INSERT INTO kt_missions (org_id, workflow_id, name, description, business_context, domain, template_key, template_config, coordinator_person_id, target_date, language, brief, capture_modalities, retention, created_by)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [ctx.orgId, workflowId, name, String(input.description ?? "").slice(0, 2000), String(input.businessContext ?? "").slice(0, 2000), String(input.domain ?? tpl.domain).slice(0, 80),
          tpl.key, JSON.stringify({ name: tpl.name, outputs: tpl.outputs, approvals: tpl.approvals, customId: tpl.customId ?? null }), coordinator,
          /^\d{4}-\d{2}-\d{2}$/.test(String(input.targetDate ?? "")) ? input.targetDate : null, normalizeLanguage(input.language), JSON.stringify(brief),
          methods.length ? methods : ["text"], JSON.stringify(tpl.retention), ctx.userId]);
      await assign(q, ctx, m, { experts: input.experts ?? [], receivers: input.receivers ?? [], receiverGroups: input.receiverGroups ?? [] });
      await syncRequirements(q, m, brief, 1);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.create", targetType: "kt_mission", targetId: m.id, requestId, metadata: { template: tpl.key } });
      return { id: m.id };
    });
  }

  async function update(ctx, id, input, requestId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      if (CLOSED.includes(m.status)) throw httpError(409, "this mission is closed");
      const sets = [], vals = [m.id];
      const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (input.name !== undefined) { const n = String(input.name).trim().slice(0, 140); if (!n) throw httpError(400, "name is required"); put("name", n); }
      if (input.description !== undefined) put("description", String(input.description).slice(0, 2000));
      if (input.businessContext !== undefined) put("business_context", String(input.businessContext).slice(0, 2000));
      if (input.domain !== undefined) put("domain", String(input.domain).slice(0, 80));
      if (input.language !== undefined) put("language", normalizeLanguage(input.language));
      if (input.targetDate !== undefined) put("target_date", /^\d{4}-\d{2}-\d{2}$/.test(String(input.targetDate ?? "")) ? input.targetDate : null);
      if (input.captureMethods !== undefined) { const c = (Array.isArray(input.captureMethods) ? input.captureMethods : []).filter((x) => CAPTURE_METHODS[x]); put("capture_modalities", c.length ? c : ["text"]); }
      let briefChanged = false;
      if (input.brief !== undefined) {
        const brief = cleanBrief(input.brief);
        if (JSON.stringify(brief) !== JSON.stringify(cleanBrief(m.brief))) { briefChanged = true; put("brief", JSON.stringify(brief)); put("brief_version", m.brief_version + 1); }
      }
      if (sets.length) await q(`UPDATE kt_missions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
      if (briefChanged) {
        await syncRequirements(q, m, cleanBrief(input.brief), m.brief_version + 1);
        if (m.workflow_id && m.brief_document_id) await q("UPDATE workflow_documents SET text_content = $2 WHERE id = $1", [m.brief_document_id, briefToMarkdown(input.name ?? m.name, cleanBrief(input.brief))]);
      }
      if (input.experts !== undefined || input.receivers !== undefined || input.receiverGroups !== undefined) {
        await assign(q, ctx, m, input);
        if (m.status !== "draft") await inviteNew(q, ctx, m);
      }
      if (m.status !== "draft" && (briefChanged || input.targetDate !== undefined || input.name !== undefined)) {
        const people = await q("SELECT person_id FROM mission_participants WHERE mission_id = $1 AND status IN ('invited','accepted')", [m.id]);
        for (const p of people) await notifyPerson(q, { orgId: ctx.orgId, personId: p.person_id, kind: "mission.updated", title: `Mission details changed: ${input.name ?? m.name}`, link: `#/missions/${m.id}`, dedupeKey: `mission:${m.id}:updated:${m.brief_version + (briefChanged ? 1 : 0)}:${input.targetDate ?? ""}:${input.name ?? ""}` });
      }
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.update", targetType: "kt_mission", targetId: m.id, requestId, metadata: { fields: Object.keys(input), briefChanged } });
      return { id: m.id };
    });
  }

  /** Brief document: plain text / Markdown is parsed into a suggested brief (reviewed by the coordinator); PDF is stored for the AI to read. */
  async function uploadBrief(ctx, id, { title = "KT Mission Brief", text = null, dataBase64 = null }, requestId) {
    requirePermission(ctx, "workflow.read");
    let buf, mime, content = null;
    if (dataBase64) {
      buf = Buffer.from(String(dataBase64), "base64");
      mime = validateUpload(buf, { allow: ["application/pdf"], maxBytes: cfg.media.maxDocBytes });
    } else {
      content = sanitizeText(text, 60000);
      if (content.trim().length < 10) throw httpError(400, "the brief is empty");
      buf = Buffer.from(content, "utf8"); mime = "text/plain";
    }
    const flags = content ? scanForInjection(content) : [];
    const parsed = content ? parseBriefMarkdown(content) : null;
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      const wfId = m.workflow_id ?? (await ensureWorkflow(q, ctx, m));
      const key = `${ctx.orgId}/missions/${m.id}/brief/${sha256(buf).slice(0, 24)}.${mime === "application/pdf" ? "pdf" : "txt"}`;
      await storage.put(key, buf, { contentType: mime });
      const [asset] = await q(`INSERT INTO media_assets (org_id, workflow_id, kind, modality, storage_key, mime_type, bytes, sha256, retention_class, status, created_by)
                               VALUES ($1,$2,'document','DOCUMENT',$3,$4,$5,$6,'knowledge','processed',$7) RETURNING id`, [ctx.orgId, wfId, key, mime, buf.length, sha256(buf), ctx.userId]);
      const [doc] = await q(`INSERT INTO workflow_documents (org_id, workflow_id, title, mime_type, media_asset_id, text_content, sha256, injection_flags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.orgId, wfId, String(title).slice(0, 120), mime, asset.id, content, sha256(buf), JSON.stringify(flags)]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.brief_upload", targetType: "kt_mission", targetId: m.id, requestId, metadata: { mime, bytes: buf.length, injectionFlags: flags.length } });
      return { documentId: doc.id, mime, suggestedBrief: parsed?.brief ?? null, unmatchedHeadings: parsed?.unmatchedHeadings ?? [], injectionFlags: flags,
        note: content ? "Review the fields filled from your document before saving; nothing was applied automatically." : "PDF stored for the AI to read as background. Fill the structured fields yourself; PDF text is not parsed into fields." };
    });
  }

  /** The destination workflow: created from the mission when the coordinator did not pick an existing one. */
  async function ensureWorkflow(q, ctx, m) {
    if (m.workflow_id) return m.workflow_id;
    const tpl = templateByKey(m.template_key) ?? templateByKey("general");
    const modalities = { screen: false, camera: false, microphone: false, documents: true, app_events: false };
    const sources = [];
    for (const k of m.capture_modalities) {
      const cm = CAPTURE_METHODS[k];
      if (!cm) continue;
      sources.push(cm.source);
      for (const mod of cm.modalities) modalities[mod.toLowerCase()] = true;
    }
    const [ws] = await q("SELECT id FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 1", [ctx.orgId]);
    const brief = cleanBrief(m.brief);
    const [w] = await q(`INSERT INTO workflows (org_id, workspace_id, name, description, kind, modalities, capture_sources, owner_user_id, source, status, profile)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user','active',$9) RETURNING id`,
      [ctx.orgId, ws.id, m.name.slice(0, 120), (m.description || brief.objectives[0] || "").slice(0, 500), tpl.workflowKind, JSON.stringify(modalities), [...new Set(sources.length ? sources : ["manual"])], ctx.userId,
        JSON.stringify({ domainSummary: (m.description || brief.objectives.join("; ")).slice(0, 500), source: "mission brief", decisionPoints: brief.decisions, likelyTacitAreas: brief.blindSpots, riskAreas: brief.constraints, vocabulary: [] })]);
    const md = briefToMarkdown(m.name, brief);
    const [doc] = await q(`INSERT INTO workflow_documents (org_id, workflow_id, title, mime_type, text_content, sha256, injection_flags) VALUES ($1,$2,'KT Mission Brief','text/plain',$3,$4,$5) RETURNING id`,
      [ctx.orgId, w.id, md, sha256(md), JSON.stringify(scanForInjection(md))]);
    await q("UPDATE kt_missions SET workflow_id = $2, brief_document_id = $3 WHERE id = $1", [m.id, w.id, doc.id]);
    m.workflow_id = w.id; m.brief_document_id = doc.id;
    return w.id;
  }

  async function syncWorkflowParticipants(q, m) {
    const parts = await q("SELECT person_id, role FROM mission_participants WHERE mission_id = $1 AND status IN ('pending','invited','accepted')", [m.id]);
    for (const p of parts) await q("INSERT INTO workflow_participants (org_id, workflow_id, person_id, participation) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [m.org_id, m.workflow_id, p.person_id, p.role === "expert" ? "EXPERT" : "LEARNER"]);
  }

  async function inviteNew(q, ctx, m) {
    await syncWorkflowParticipants(q, m);
    const pending = await q("SELECT person_id, role FROM mission_participants WHERE mission_id = $1 AND status = 'pending'", [m.id]);
    const [coord] = await q("SELECT display_name FROM people WHERE id = $1", [m.coordinator_person_id]);
    for (const p of pending) {
      await q("UPDATE mission_participants SET status = 'invited' WHERE mission_id = $1 AND person_id = $2 AND role = $3", [m.id, p.person_id, p.role]);
      // Minimal content: the mission name and who coordinates it. The brief is visible only inside the authorised mission view.
      await notifyPerson(q, { orgId: m.org_id, personId: p.person_id, kind: "mission.assigned", title: `${coord?.display_name ?? "A coordinator"} added you to "${m.name}" as ${p.role === "expert" ? "subject matter expert" : "receiver"}`, link: `#/missions/${m.id}`, dedupeKey: `mission:${m.id}:assigned:${p.role}` });
    }
    return pending.length;
  }

  /** Review → send: validates the mission, creates its workflow if needed, invites participants. Idempotent. */
  async function send(ctx, id, requestId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      if (m.status !== "draft") throw httpError(409, "this mission was already sent");
      const parts = await participantsOf(q, m);
      const brief = cleanBrief(m.brief);
      const problems = [];
      if (!parts.some((p) => p.role === "expert")) problems.push("assign at least one subject matter expert");
      if (!parts.some((p) => p.role === "receiver")) problems.push("assign at least one receiver or receiver group");
      if (!brief.objectives.length && !brief.outcomes.length) problems.push("add at least one objective or expected outcome to the brief");
      if (problems.length) throw httpError(400, `before sending: ${problems.join("; ")}`);
      await ensureWorkflow(q, ctx, m);
      await q("UPDATE kt_missions SET status = 'active', invited_at = now(), updated_at = now() WHERE id = $1", [m.id]);
      const invited = await inviteNew(q, ctx, { ...m, status: "active" });
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.send", targetType: "kt_mission", targetId: m.id, requestId, metadata: { invited } });
      return { invited, workflowId: m.workflow_id };
    });
  }

  async function respond(ctx, id, { accept }, requestId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      if (!access.expert && !access.receiver) throw httpError(403, "you are not a participant in this mission");
      if (CLOSED.includes(m.status)) throw httpError(409, "this mission is closed");
      const r = await q("UPDATE mission_participants SET status = $3, responded_at = now() WHERE mission_id = $1 AND person_id = $2 AND status IN ('invited','pending','accepted','declined') RETURNING role", [m.id, ctx.personId, accept ? "accepted" : "declined"]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: accept ? "mission.accept" : "mission.decline", targetType: "kt_mission", targetId: m.id, requestId });
      if (m.coordinator_person_id) await notifyPerson(q, { orgId: ctx.orgId, personId: m.coordinator_person_id, kind: "mission.response", title: `${ctx.displayName} ${accept ? "accepted" : "declined"} "${m.name}"`, link: `#/missions/${m.id}`, dedupeKey: `mission:${m.id}:response:${ctx.personId}:${accept ? "a" : "d"}` });
      return { status: accept ? "accepted" : "declined", roles: r.map((x) => x.role) };
    });
  }

  async function confirmBrief(ctx, id, requestId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      if (!access.expert) throw httpError(403, "only an assigned expert confirms the brief");
      await q("UPDATE kt_missions SET brief_confirmed_at = now(), brief_confirmed_by = $2, brief_confirmed_version = brief_version WHERE id = $1", [m.id, ctx.personId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.brief_confirm", targetType: "kt_mission", targetId: m.id, requestId, metadata: { briefVersion: m.brief_version } });
      return { confirmed: true };
    });
  }

  /** The expert starts a capture session for this mission, with a method allowed by the mission. */
  async function startCapture(ctx, id, { method, source, caseRef, language }) {
    requirePermission(ctx, "session.capture");
    const prep = await T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      if (!access.expert) throw httpError(403, "only an assigned subject matter expert captures for this mission");
      if (m.status !== "active") throw httpError(409, m.status === "draft" ? "the mission has not been sent yet" : `the mission is ${m.status}`);
      if (m.brief_confirmed_version !== m.brief_version) throw httpError(409, "confirm Moti's summary of the current brief before capturing");
      await q("UPDATE mission_participants SET status = 'accepted', responded_at = COALESCE(responded_at, now()) WHERE mission_id = $1 AND person_id = $2 AND role = 'expert' AND status IN ('invited','pending')", [m.id, ctx.personId]);
      const [wf] = await q("SELECT capture_sources FROM workflows WHERE id = $1", [m.workflow_id]);
      let src = source;
      if (!src) {
        if (method && !m.capture_modalities.includes(method)) throw httpError(400, "that capture method is not enabled for this mission");
        src = CAPTURE_METHODS[method ?? m.capture_modalities[0]]?.source ?? "manual";
      }
      if (src !== "manual" && !wf.capture_sources.includes(src)) throw httpError(400, "that capture method is not enabled for this mission");
      return m;
    });
    return capture.startSession(ctx, { workflowId: prep.workflow_id, source: source ?? CAPTURE_METHODS[method ?? prep.capture_modalities[0]]?.source ?? "manual", caseRef, language: language ?? prep.language, missionId: prep.id });
  }

  // ---------------------------------------------------------------- overview (stage derived from records)
  async function overviewData(q, ctx, m, access) {
    const viewer = await viewerOf(q, ctx);
    const parts = await participantsOf(q, m);
    const sessions = m.workflow_id ? await q(`SELECT s.id, s.status, s.capture_source, s.expert_person_id, s.judgment_id, s.started_at, p.display_name FROM expert_sessions s JOIN people p ON p.id = s.expert_person_id
                                              WHERE s.mission_id = $1 ORDER BY s.started_at`, [m.id]) : [];
    const judgments = sessions.length ? await q(`SELECT j.id, j.status, j.title, j.current_version, j.expert_person_id, j.case_ref, j.workflow_id, a.id AS artifact_id, a.status AS artifact_status, p.display_name AS expert_name,
                                                        v.content, ${visibleSql(viewer)} AS visible
                                                 FROM judgments j JOIN expert_sessions s ON s.id = j.session_id LEFT JOIN knowledge_artifacts a ON a.judgment_id = j.id
                                                 JOIN people p ON p.id = j.expert_person_id JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                                                 WHERE s.mission_id = $1 AND j.status <> 'rejected' ORDER BY j.created_at`, [m.id]) : [];
    const jIds = judgments.map((j) => j.id);
    const gaps = jIds.length ? await q("SELECT judgment_id, status, kind FROM knowledge_gaps WHERE judgment_id = ANY($1::uuid[])", [jIds]) : [];
    const scen = jIds.length ? await q("SELECT judgment_id, kind, review_status FROM scenarios WHERE judgment_id = ANY($1::uuid[])", [jIds]) : [];
    const approved = judgments.filter((j) => j.status === "approved" && j.artifact_status === "active");
    const curatedApproved = approved.some((j) => j.case_ref);
    const testsApproved = scen.some((s) => s.review_status === "approved") || curatedApproved;
    const receivers = parts.filter((p) => p.role === "receiver" && ["invited", "accepted", "pending"].includes(p.status));
    const results = [];
    for (const r of receivers) for (const j of approved) results.push({ personId: r.person_id, name: r.display_name, judgmentId: j.id, title: j.visible ? j.title : "Private knowledge", ...(await transfers.learnerResult(q, j, r.person_id)) });
    const reqs = await q("SELECT r.*, p.display_name AS decided_by_name FROM mission_requirements r LEFT JOIN people p ON p.id = r.decided_by WHERE r.mission_id = $1 AND r.retired_at IS NULL ORDER BY r.position", [m.id]);
    const expertsAccepted = parts.some((p) => p.role === "expert" && p.status === "accepted");
    const anyCapture = sessions.length > 0;
    const capturing = sessions.some((s) => ["awaiting_consent", "capturing", "processing", "analyzing", "asking", "extracting"].includes(s.status));
    let stage;
    if (m.status === "draft") stage = "draft";
    else if (CLOSED.includes(m.status) || ["paused", "blocked"].includes(m.status)) stage = m.status;
    else if (!expertsAccepted && !anyCapture) stage = "awaiting_participants";
    else if (!anyCapture) stage = "ready_to_capture";
    else if (!judgments.length) stage = capturing ? "capturing" : "ready_to_capture";
    else if (!approved.length || !testsApproved) stage = "knowledge_review";
    else stage = "transfer_assessment";
    const requiredOpen = reqs.filter((r) => r.required && !["satisfied", "not_applicable"].includes(r.status));
    const receiversWithResults = new Set(results.filter((x) => x.status !== "not_started").map((x) => x.personId));
    const receiversWithout = receivers.filter((r) => !receiversWithResults.has(r.person_id));
    const completion = {
      requirementsOpen: requiredOpen.length, approvedKnowledge: approved.length, receiversWithoutResults: receiversWithout.map((r) => r.display_name),
      ready: requiredOpen.length === 0 && approved.length > 0 && receivers.length > 0 && receiversWithout.length === 0,
    };
    return { parts, sessions, judgments, gaps, scen, approved, receivers, results, reqs, stage, completion, testsApproved };
  }

  function nextAction(stage, d, access, m) {
    const brief = m.brief_confirmed_version === m.brief_version;
    switch (stage) {
      case "draft": return access.manage ? { label: "Review participants and send invitations", href: `#/missions/${m.id}/review` } : null;
      case "awaiting_participants": return access.expert ? { label: brief ? "Accept and start capturing" : "Confirm Moti's summary of the brief", act: brief ? "start" : "confirm" } : { label: "Waiting for the expert to accept" };
      case "ready_to_capture": return access.expert ? { label: brief ? "Start a capture session" : "Confirm Moti's summary of the brief", act: brief ? "start" : "confirm" } : { label: "Waiting for the expert to capture" };
      case "capturing": return { label: access.expert ? "Continue your capture session" : "The expert is capturing", href: d.sessions.at(-1) && access.expert ? `#/session/${d.sessions.at(-1).id}` : null };
      case "knowledge_review": {
        const open = d.gaps.filter((g) => ["open", "answered"].includes(g.status)).length;
        if (!d.approved.length) return { label: access.expert ? "Review and approve the captured knowledge" : "Waiting for the expert to approve the knowledge", href: access.expert && d.judgments[0] ? `#/knowledge/${d.judgments[0].id}` : null };
        return { label: open ? `Answer ${open} open knowledge gap(s) and approve the practice cases` : "Approve the practice cases for receivers", href: access.expert && d.approved[0] ? `#/knowledge/${d.approved[0].id}` : null };
      }
      case "transfer_assessment":
        if (access.receiver) return { label: "Take your transfer assessment", href: "#/learn" };
        if (d.completion.ready && access.manage) return { label: "All criteria met: complete the mission", act: "complete" };
        return { label: d.completion.requirementsOpen ? `${d.completion.requirementsOpen} requirement(s) still open` : `Waiting for ${d.completion.receiversWithoutResults.length} receiver(s) to be assessed` };
      default: return null;
    }
  }

  async function get(ctx, id) {
    requirePermission(ctx, "workflow.read");
    const out = await T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      const d = await overviewData(q, ctx, m, access);
      const brief = cleanBrief(m.brief);
      const fullBrief = access.manage || access.readAll || access.expert;
      // Requirement re-check: once per distinct knowledge state (idempotency key), never on every page view.
      let assessing = false;
      if (d.judgments.length && m.status === "active" && d.reqs.length) {
        const fp = sha256(JSON.stringify([m.brief_version, d.judgments.map((j) => [j.id, j.current_version, j.status])])).slice(0, 24);
        const job = await enqueue(q, { orgId: ctx.orgId, kind: "assess_mission", key: `${m.id}:${fp}`, payload: { missionId: m.id }, maxAttempts: 2 });
        assessing = ["queued", "running"].includes(job.status);
      }
      const [coord] = await q("SELECT display_name FROM people WHERE id = $1", [m.coordinator_person_id]);
      const me = { manage: access.manage, expert: access.expert, receiver: access.receiver, readOnly: !access.manage && !access.expert && !access.receiver };
      const myStatus = d.parts.find((p) => p.person_id === ctx.personId)?.status ?? null;
      return {
        id: m.id, name: m.name, description: m.description, businessContext: fullBrief ? m.business_context : "", domain: m.domain, status: m.status, stage: d.stage, language: m.language,
        template: { key: m.template_key, ...m.template_config }, targetDate: m.target_date, coordinator: coord?.display_name ?? null, workflowId: m.workflow_id,
        captureMethods: m.capture_modalities.map((k) => ({ key: k, ...CAPTURE_METHODS[k] })), retention: m.retention, statusNote: m.status_note, exceptionNote: m.exception_note,
        brief: fullBrief ? brief : { objectives: brief.objectives, outcomes: brief.outcomes, scope: brief.scope, outOfScope: brief.outOfScope, constraints: brief.constraints },
        briefVersion: m.brief_version, briefConfirmed: m.brief_confirmed_version === m.brief_version, moti: access.expert || fullBrief ? motiSummary(m, brief) : null,
        me: { ...me, status: myStatus },
        participants: d.parts.map((p) => ({ personId: p.person_id, name: p.display_name, title: p.title, role: p.role, status: p.status, viaGroup: p.via_group, issue: eligibility(p) })),
        sessions: (access.manage || access.readAll || access.expert) ? d.sessions.map((s) => ({ id: s.id, status: s.status, source: s.capture_source, expert: s.display_name, createdAt: s.started_at, mine: s.expert_person_id === ctx.personId })) : [],
        knowledge: d.judgments.map((j) => ({ id: j.visible ? j.id : null, title: j.visible ? j.title : "Private knowledge (not shared with you)", status: j.status, expert: j.expert_name, version: j.current_version,
          openGaps: d.gaps.filter((g) => g.judgment_id === j.id && ["open", "answered"].includes(g.status)).length,
          tests: { draft: d.scen.filter((s) => s.judgment_id === j.id && s.review_status === "draft").length, approved: d.scen.filter((s) => s.judgment_id === j.id && s.review_status === "approved").length } })),
        requirements: fullBrief ? d.reqs.map((r) => ({ id: r.id, kind: r.kind, text: r.text, status: r.status, basis: r.basis, evidence: r.evidence, explanation: r.explanation, decidedBy: r.decided_by_name, decidedAt: r.decided_at })) : [],
        assessing,
        results: (access.manage || access.readAll) ? d.results : d.results.filter((x) => x.personId === ctx.personId),
        completion: (access.manage || access.readAll) ? d.completion : null,
        next: nextAction(d.stage, d, access, m),
      };
    });
    return out;
  }

  async function list(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const all = can(ctx, "mission.read.any");
      const rows = await q(`SELECT m.id, m.name, m.status, m.domain, m.template_key, m.target_date, m.created_at, m.coordinator_person_id, p.display_name AS coordinator,
                                   (SELECT count(*)::int FROM mission_participants mp WHERE mp.mission_id = m.id AND mp.role = 'receiver' AND mp.status <> 'removed') AS receivers,
                                   (SELECT string_agg(pp.display_name, ', ') FROM mission_participants mp JOIN people pp ON pp.id = mp.person_id WHERE mp.mission_id = m.id AND mp.role = 'expert' AND mp.status <> 'removed') AS experts,
                                   (SELECT mp.role FROM mission_participants mp WHERE mp.mission_id = m.id AND mp.person_id = $1 AND mp.status NOT IN ('removed','declined') LIMIT 1) AS my_role
                            FROM kt_missions m LEFT JOIN people p ON p.id = m.coordinator_person_id ORDER BY m.created_at DESC`, [ctx.personId ?? null]);
      const visible = rows.filter((r) => all || can(ctx, "mission.manage.any") || r.coordinator_person_id === ctx.personId || (r.my_role && r.status !== "draft"));
      return { canCreate: can(ctx, "mission.create"), missions: visible.map((r) => ({ id: r.id, name: r.name, status: r.status, domain: r.domain, template: r.template_key, targetDate: r.target_date, coordinator: r.coordinator, experts: r.experts ?? "", receivers: r.receivers, myRole: r.my_role ?? (r.coordinator_person_id === ctx.personId ? "coordinator" : null) })) };
    });
  }

  /** The confirmation page before invitations go out: identities, resolved recipients, access implications. */
  async function review(ctx, id) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      const parts = await participantsOf(q, m);
      const groups = await q(`SELECT g.id, g.name, (SELECT count(*)::int FROM group_members gm WHERE gm.group_id = g.id AND gm.removed_at IS NULL) AS members
                              FROM mission_groups mg JOIN groups g ON g.id = mg.group_id WHERE mg.mission_id = $1 AND mg.removed_at IS NULL`, [m.id]);
      const [space] = await q("SELECT experience FROM organizations WHERE id = app_org()");
      const brief = cleanBrief(m.brief);
      return {
        id: m.id, name: m.name, status: m.status, description: m.description, template: m.template_config?.name ?? m.template_key, targetDate: m.target_date, language: m.language,
        experts: parts.filter((p) => p.role === "expert").map((p) => ({ name: p.display_name, status: p.status, issue: eligibility(p) })),
        receivers: parts.filter((p) => p.role === "receiver").map((p) => ({ name: p.display_name, via: p.via_group ?? "individually", status: p.status, issue: eligibility(p) })),
        groups: groups.map((g) => ({ name: g.name, members: g.members })),
        moti: motiSummary(m, brief), deliverables: m.template_config?.outputs ?? [],
        captureMethods: m.capture_modalities.map((k) => CAPTURE_METHODS[k]?.label ?? k),
        consent: "Each expert sees exactly which inputs are captured and agrees before each session; they can pause, exclude an input or delete any moment.",
        access: space?.experience === "living"
          ? "Captured knowledge stays private to the expert until they share it. Receivers see a mission's knowledge only if the expert shares it with them or their group."
          : "After the expert approves it, the knowledge is shared with people in this space who learn this workflow (the workplace default; the expert sees this before capturing). Receivers see the brief's objectives and outcomes, not its blind spots, questions or acceptance criteria.",
        retention: m.retention,
        notifications: "Assigned people get an in-app notification with the mission name and coordinator only. No email is sent.",
      };
    });
  }

  async function decideRequirement(ctx, reqId, { status, note = "" }, requestId) {
    requirePermission(ctx, "workflow.read");
    if (!["satisfied", "partial", "unresolved", "not_applicable"].includes(status)) throw httpError(400, "invalid status");
    if (!UUID.test(String(reqId))) throw httpError(404, "requirement not found");
    return T(ctx, async (q) => {
      const [r] = await q("SELECT * FROM mission_requirements WHERE id = $1 AND retired_at IS NULL", [reqId]);
      if (!r) throw httpError(404, "requirement not found");
      const { m, access } = await load(q, ctx, r.mission_id);
      if (!access.manage && !access.expert) throw httpError(403, "only the coordinator or an assigned expert can decide a requirement");
      if (status === "satisfied" && !String(note).trim()) throw httpError(400, "say what shows it is satisfied");
      await q("UPDATE mission_requirements SET status = $2, basis = 'PERSON', explanation = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE id = $1", [r.id, status, String(note).slice(0, 500), ctx.personId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.requirement_decide", targetType: "mission_requirement", targetId: r.id, requestId, metadata: { status, missionId: m.id } });
      return { id: r.id, status };
    });
  }

  async function setStatus(ctx, id, { status, note = "" }, requestId) {
    requirePermission(ctx, "workflow.read");
    if (!["active", "paused", "blocked", "cancelled"].includes(status)) throw httpError(400, "invalid status");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      if (CLOSED.includes(m.status)) throw httpError(409, "this mission is closed");
      if (m.status === "draft" && status === "active") throw httpError(409, "send the mission to activate it");
      await q("UPDATE kt_missions SET status = $2, status_note = $3, updated_at = now() WHERE id = $1", [m.id, status, String(note).slice(0, 500) || null]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.status", targetType: "kt_mission", targetId: m.id, requestId, metadata: { from: m.status, to: status } });
      return { status };
    });
  }

  /** Completion: every required criterion met, or an explicit exception by an authorised owner. Never from a recording alone. */
  async function complete(ctx, id, { exceptionNote = "" }, requestId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const { m, access } = await load(q, ctx, id);
      requireManage(access);
      if (m.status !== "active") throw httpError(409, `the mission is ${m.status}`);
      const d = await overviewData(q, ctx, m, access);
      const note = String(exceptionNote ?? "").trim();
      if (!d.completion.ready && !note) {
        const why = [d.completion.requirementsOpen ? `${d.completion.requirementsOpen} required item(s) not satisfied` : null, d.approved.length ? null : "no approved knowledge",
          d.completion.receiversWithoutResults.length ? `no assessment result for ${d.completion.receiversWithoutResults.join(", ")}` : null].filter(Boolean);
        throw httpError(409, `not complete: ${why.join("; ")}. Record an exception to close it anyway.`);
      }
      const status = d.completion.ready ? "completed" : "completed_with_exceptions";
      await q("UPDATE kt_missions SET status = $2, exception_note = $3, completed_at = now(), updated_at = now() WHERE id = $1", [m.id, status, note || null]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "mission.complete", targetType: "kt_mission", targetId: m.id, requestId, metadata: { status, requirementsOpen: d.completion.requirementsOpen } });
      return { status };
    });
  }

  // ---------------------------------------------------------------- jobs
  async function assessJob({ missionId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const [m] = await q("SELECT * FROM kt_missions WHERE id = $1", [missionId]);
      if (!m) return null;
      const reqs = await q("SELECT id, kind, text, basis FROM mission_requirements WHERE mission_id = $1 AND retired_at IS NULL ORDER BY position", [m.id]);
      const js = await q(`SELECT j.id, j.title, j.status, v.content FROM judgments j JOIN expert_sessions s ON s.id = j.session_id JOIN judgment_versions v ON v.judgment_id = j.id AND v.version = j.current_version
                          WHERE s.mission_id = $1 AND j.status <> 'rejected'`, [m.id]);
      return { m, reqs: reqs.filter((r) => r.basis !== "PERSON"), items: js.map((j) => ({ judgmentId: j.id, title: j.content.title ?? j.title, status: j.status, fields: j.content.fields })) };
    });
    if (!prep?.reqs.length) return { skipped: true };
    const res = await withAiContext({ orgId: ctx.orgId, workflowId: prep.m.workflow_id }, () => assessRequirements({ requirements: prep.reqs, items: prep.items, language: prep.m.language }));
    await T(ctx, async (q) => {
      for (const r of res.results) {
        // A person's decision is never overwritten by the AI.
        await q(`UPDATE mission_requirements SET status = $2, basis = $3, evidence = $4, explanation = $5, updated_at = now() WHERE id = $1 AND basis <> 'PERSON'`,
          [r.id, r.status, r.basis, JSON.stringify(r.evidence), r.explanation]);
      }
    });
    return { assessed: res.results.length, source: res.source };
  }

  /** Hourly: deadline reminders (idempotent per mission per day). */
  async function sweepJob(_payload, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    return T(ctx, async (q) => {
      const due = await q("SELECT * FROM kt_missions WHERE status = 'active' AND target_date IS NOT NULL AND target_date - CURRENT_DATE BETWEEN 0 AND 3");
      let sent = 0;
      for (const m of due) {
        const people = await q("SELECT person_id FROM mission_participants WHERE mission_id = $1 AND status IN ('invited','accepted') UNION SELECT $2::uuid WHERE $2::uuid IS NOT NULL", [m.id, m.coordinator_person_id]);
        for (const p of people) if (await notifyPerson(q, { orgId: ctx.orgId, personId: p.person_id, kind: "mission.deadline", title: `"${m.name}" is due ${new Date(m.target_date).toISOString().slice(0, 10)}`, link: `#/missions/${m.id}`, dedupeKey: `mission:${m.id}:deadline:${new Date().toISOString().slice(0, 10)}` })) sent++;
      }
      return { reminders: sent };
    });
  }

  return { templates, saveTemplate, create, update, uploadBrief, send, respond, confirmBrief, startCapture, get, list, review, decideRequirement, setStatus, complete, handlers: { assess_mission: assessJob, mission_sweep: sweepJob } };
}

/** Notifications from other engines (called inside their transactions). */
export async function notifyMissionReview(q, session, judgmentId) {
  if (!session.mission_id) return;
  const [m] = await q("SELECT id, name, org_id FROM kt_missions WHERE id = $1", [session.mission_id]);
  if (m) await notifyPerson(q, { orgId: m.org_id, personId: session.expert_person_id, kind: "mission.review", title: `Your knowledge from "${m.name}" is ready for your review`, link: `#/knowledge/${judgmentId}`, dedupeKey: `mission:${m.id}:review:${judgmentId}` });
}
export async function notifyAssessmentReady(q, judgmentId) {
  const [m] = await q("SELECT k.id, k.name, k.org_id FROM judgments j JOIN expert_sessions s ON s.id = j.session_id JOIN kt_missions k ON k.id = s.mission_id WHERE j.id = $1 AND j.status = 'approved'", [judgmentId]);
  if (!m) return;
  const receivers = await q("SELECT person_id FROM mission_participants WHERE mission_id = $1 AND role = 'receiver' AND status IN ('invited','accepted','pending')", [m.id]);
  for (const r of receivers) await notifyPerson(q, { orgId: m.org_id, personId: r.person_id, kind: "mission.assessment", title: `A transfer assessment from "${m.name}" is waiting for you`, link: "#/learn", dedupeKey: `mission:${m.id}:assessment:${judgmentId}` });
}
/** The brief as untrusted focus text for a session's prompts (empty when the session is not part of a mission). */
export async function missionFocusFor(q, missionId) {
  if (!missionId) return "";
  const [m] = await q("SELECT brief FROM kt_missions WHERE id = $1", [missionId]);
  if (!m) return "";
  const { briefFocus } = await import("./templates.mjs");
  return briefFocus(cleanBrief(m.brief));
}
export async function missionCriteriaFor(q, judgmentId) {
  const [m] = await q("SELECT k.brief FROM judgments j JOIN expert_sessions s ON s.id = j.session_id JOIN kt_missions k ON k.id = s.mission_id WHERE j.id = $1", [judgmentId]);
  if (!m) return [];
  const b = cleanBrief(m.brief);
  return [...b.acceptance, ...b.decisions].slice(0, 12);
}
