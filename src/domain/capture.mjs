// Capture + Judgment engine (workflow-agnostic).
//   Observation Engine: consent-gated capture → media assets in object storage → async processing → observations
//   Judgment Engine:    natural break → detect → gate → adaptive questions → extract → boundary → finalize
// Rules: tenant scope comes only from ctx; no AI call inside a DB transaction; heavy work runs in jobs.
import { requirePermission, can } from "../platform/authz.mjs";
import { findReusable, deleteUnreferenced } from "../platform/blobs.mjs";
import { httpError, sha256, validateUpload, scanForInjection } from "../platform/security.mjs";
import { objectKey } from "../platform/storage.mjs";
import { enqueue, RetryLater } from "../platform/jobs.mjs";
import { audit } from "../platform/audit.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { POLICIES, planObservation, rawEquivalentTokens, eventWindow, thumbFromSvg, thumbDiff, toRule, TOKENS } from "../ai/context.mjs";
import { verifyFields, CHAIN_FIELDS } from "../ai/validators.mjs";
import { gate } from "../ai/gate.mjs";
import { interpretObservation, transcribe, endsMidSpeech } from "../ai/ops/perception.mjs";
import { detectJudgment, contradictsKnowledge, generateQuestion, extractKnowledge, findBoundary, detectConflict, reconcileExperts } from "../ai/ops/judgment.mjs";
import { render, toPng } from "../sim/render.mjs";
import { simSource } from "../sim/workflows/index.mjs";
import { normalizeLanguage } from "../ai/language.mjs";
import { aiAvailable } from "../ai/gemini.mjs";
import { missionFocusFor, notifyMissionReview } from "./missions.mjs";

const PIXEL = new Set(["SCREEN", "CAMERA"]);
const MAX_FOLLOWUPS = 2;
const CAPTURE_MODALITIES = ["SCREEN", "CAMERA", "MICROPHONE"];

export function createCapture({ db, storage, jobs, knowledge, policy, cfg, log }) {
  const P = POLICIES[cfg.contextPolicy ?? "compressed"];
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const ai = (ctx, session, fn) => withAiContext({ orgId: ctx.orgId, sessionId: session.id, workflowId: session.workflow_id, requestId: ctx.requestId, pipeline: cfg.pipeline ?? "live" }, fn);

  // ---------------------------------------------------------------- loading + authorization
  async function loadSession(q, id) {
    const [s] = await q("SELECT * FROM expert_sessions WHERE id = $1", [id]);
    if (!s) throw httpError(404, "session not found"); // RLS: other tenants' sessions are indistinguishable from missing ones
    return s;
  }
  function assertCanRead(ctx, s) {
    if (can(ctx, "session.read.any")) return;
    if (can(ctx, "session.read.own") && ctx.personId === s.expert_person_id) return;
    throw httpError(403, "not allowed to view this session");
  }
  function assertIsExpert(ctx, s) {
    if (ctx.personId !== s.expert_person_id) throw httpError(403, "only the expert being captured can do this");
  }
  async function loadWorkflow(q, id) {
    const [w] = await q("SELECT * FROM workflows WHERE id = $1 AND deleted_at IS NULL", [id]);
    if (!w) throw httpError(404, "workflow not found");
    return w;
  }
  async function loadProcedures(q, workflowId) { return q("SELECT * FROM workflow_procedures WHERE workflow_id = $1 ORDER BY key", [workflowId]); }

  async function nextSeq(q, sessionId) {
    const [r] = await q("UPDATE expert_sessions SET obs_seq = obs_seq + 1, updated_at = now() WHERE id = $1 RETURNING obs_seq", [sessionId]);
    return r.obs_seq;
  }

  async function insertObservation(q, s, o) {
    const seq = await nextSeq(q, s.id);
    const [row] = await q(
      `INSERT INTO observations (org_id, session_id, workflow_id, seq, modality, source, captured_at, text, structured, readings, plan, change_type, confidence,
                                 level, dropped, media_asset_id, linked_observation_id, consent_id, retention_class, security_flags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'semantic',$19) RETURNING *`,
      [s.org_id, s.id, s.workflow_id, seq, o.modality, o.source, o.capturedAt ?? new Date(), String(o.text ?? "").slice(0, 4000), o.structured ? JSON.stringify(o.structured) : null,
        JSON.stringify(o.readings ?? []), JSON.stringify(o.plan ?? null), o.changeType ?? null, o.confidence ?? null, o.dropped ? 0 : 1, Boolean(o.dropped),
        o.mediaAssetId ?? null, o.linkedTo ?? null, o.consentId ?? null, JSON.stringify(o.flags ?? [])],
    );
    await bumpBudget(q, s.id, o.plan?.decision ?? "use_text", rawEquivalentTokens({ ...o, hasRaw: Boolean(o.mediaAssetId) }));
    return row;
  }

  async function bumpBudget(q, sessionId, decision, rawEq) {
    await q(`UPDATE expert_sessions SET budget = jsonb_set(jsonb_set(budget, '{decisions,${decision}}',
               to_jsonb(COALESCE((budget->'decisions'->>'${decision}')::int, 0) + 1), true),
               '{rawEquivalentTokens}', to_jsonb(COALESCE((budget->>'rawEquivalentTokens')::int, 0) + $2), true) WHERE id = $1`, [sessionId, rawEq]);
  }

  async function activeConsent(q, s) {
    const [c] = await q("SELECT * FROM consent_records WHERE session_id = $1 AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1", [s.id]);
    return c ?? null;
  }

  /** Capture is allowed only with active consent for that modality, not paused, not excluded. */
  function assertCaptureAllowed(s, consent, modality) {
    if (s.status !== "capturing") throw httpError(409, "session is not capturing");
    if (s.privacy.paused) throw httpError(409, "capture is paused");
    if (CAPTURE_MODALITIES.includes(modality)) {
      if (!consent || !consent.modalities.includes(modality)) throw httpError(403, `no recording consent for ${modality.toLowerCase()}`);
      if (s.privacy.excluded?.[modality]) throw httpError(409, `${modality.toLowerCase()} is excluded for this session`);
    }
  }

  // ---------------------------------------------------------------- session lifecycle
  async function startSession(ctx, { workflowId, source, caseRef, expertPersonId, transferId = null, missionId = null, language = null }) {
    requirePermission(ctx, "session.capture");
    return T(ctx, async (q) => {
      const wf = await loadWorkflow(q, workflowId);
      const expertId = expertPersonId ?? ctx.personId;
      if (!expertId) throw httpError(400, "no expert person for this user");
      if (expertId !== ctx.personId && !can(ctx, "workflow.manage")) throw httpError(403, "only workflow owners can facilitate capture for another expert");
      const [isExpert] = await q("SELECT 1 FROM workflow_participants WHERE workflow_id = $1 AND person_id = $2 AND participation = 'EXPERT'", [wf.id, expertId]);
      if (!isExpert) throw httpError(403, "this person is not an expert on this workflow");
      const src = source ?? wf.capture_sources[0] ?? "manual";
      if (!wf.capture_sources.includes(src) && src !== "manual") throw httpError(400, "capture source not enabled for this workflow");
      let simState = null, procedureId = null, ref = null;
      if (src.startsWith("sim:")) {
        const env = simSource(src);
        const c = env?.cases.find((x) => x.id === caseRef) ?? env?.cases[0];
        if (!c) throw httpError(400, "unknown simulated case");
        ref = c.id;
        simState = { state: c.state, facts: c.facts ?? {}, sampler: { recent: [] } };
        if (c.procedureId) procedureId = (await q("SELECT id FROM workflow_procedures WHERE workflow_id = $1 AND key = $2", [wf.id, c.procedureId]))[0]?.id ?? null;
      }
      if (transferId) {
        const [t] = await q("SELECT * FROM transfers WHERE id = $1", [transferId]);
        if (!t || t.workflow_id !== wf.id || t.expert_person_id !== expertId) throw httpError(404, "transfer not found");
        if (t.status !== "scheduled") throw httpError(409, "this transfer is not open");
      }
      if (missionId) {
        const [mm] = await q("SELECT m.workflow_id, m.status FROM kt_missions m JOIN mission_participants p ON p.mission_id = m.id AND p.person_id = $2 AND p.role = 'expert' AND p.status IN ('invited','accepted') WHERE m.id = $1", [missionId, expertId]);
        if (!mm || mm.workflow_id !== wf.id) throw httpError(404, "mission not found");
        if (mm.status !== "active") throw httpError(409, "this mission is not active");
      }
      const privacy = { paused: false, excluded: { SCREEN: false, CAMERA: false, MICROPHONE: false }, retainRaw: "evidence" };
      const [s] = await q(
        `INSERT INTO expert_sessions (org_id, workflow_id, expert_person_id, started_by, capture_source, case_ref, status, privacy, sim_state, procedure_id, budget, transfer_id, language, mission_id)
         VALUES ($1,$2,$3,$4,$5,$6,'awaiting_consent',$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [ctx.orgId, wf.id, expertId, ctx.userId, src, ref, JSON.stringify(privacy), simState ? JSON.stringify(simState) : null, procedureId,
          JSON.stringify({ decisions: {}, rawEquivalentTokens: 0, rawBytesCaptured: 0, rawBytesPurged: 0, sampler: { seen: false, droppedSinceVision: 0, appEventsPresent: false } }), transferId, normalizeLanguage(language ?? ctx.language), missionId],
      );
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "capture.session_start", targetType: "session", targetId: s.id, requestId: ctx.requestId, metadata: { source: src } });
      return s;
    });
  }

  /** The person being captured sees exactly what will be captured and consents (per modality, versioned policy). */
  async function grantConsent(ctx, sessionId, { modalities, clientTime }) {
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (!["awaiting_consent", "capturing"].includes(s.status)) throw httpError(409, "session is not capturing");
      const wf = await loadWorkflow(q, s.workflow_id);
      const enabled = { SCREEN: wf.modalities.screen, CAMERA: wf.modalities.camera, MICROPHONE: wf.modalities.microphone };
      const chosen = [...new Set((modalities ?? []).filter((m) => CAPTURE_MODALITIES.includes(m) && enabled[m]))];
      const doc = await policy.currentConsentPolicy(q);
      await q("UPDATE consent_records SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [s.id]);
      const [c] = await q(`INSERT INTO consent_records (org_id, session_id, user_id, modalities, policy_document_id, policy_version) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.orgId, s.id, ctx.userId, chosen, doc?.id ?? null, doc?.version ?? null]);
      const offset = Number.isFinite(clientTime) ? Math.round(Date.now() - clientTime) : 0;
      await q("UPDATE expert_sessions SET status = 'capturing', client_clock_offset_ms = $2, updated_at = now() WHERE id = $1", [s.id, Math.max(-86400000, Math.min(86400000, offset))]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "capture.consent", targetType: "session", targetId: s.id, requestId: ctx.requestId, metadata: { modalities: chosen, policyVersion: doc?.version } });
      return c;
    });
  }

  async function setPrivacy(ctx, sessionId, patch) {
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      const p = { ...s.privacy, excluded: { ...s.privacy.excluded } };
      if (typeof patch.paused === "boolean") p.paused = patch.paused;
      for (const m of CAPTURE_MODALITIES) if (typeof patch.excluded?.[m] === "boolean") p.excluded[m] = patch.excluded[m];
      if (["evidence", "all", "none"].includes(patch.retainRaw)) p.retainRaw = patch.retainRaw;
      await q("UPDATE expert_sessions SET privacy = $2, updated_at = now() WHERE id = $1", [s.id, JSON.stringify(p)]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "capture.privacy", targetType: "session", targetId: s.id, requestId: ctx.requestId, metadata: p });
      return p;
    });
  }

  // ---------------------------------------------------------------- media ingestion (real capture + simulated feeds share this path)
  function retentionExpiry(orgSettings, cls) {
    const days = orgSettings?.retention?.[cls];
    return days ? new Date(Date.now() + days * 86400000) : null;
  }

  async function storeAsset(q, s, { buf, mime, kind, modality, capturedAt, durationMs, consentId, userId }) {
    const hash = sha256(buf);
    const [existing] = await q("SELECT * FROM media_assets WHERE session_id = $1 AND sha256 = $2 AND kind = $3", [s.id, hash, kind]);
    if (existing) return { asset: existing, duplicate: true };
    const [org] = await q("SELECT settings FROM organizations WHERE id = $1", [s.org_id]);
    const id = (await q("SELECT gen_random_uuid() AS id"))[0].id;
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/wav": "wav", "video/webm": "webm", "video/mp4": "mp4", "application/pdf": "pdf" }[mime] ?? "bin";
    // Same bytes already stored in this space (another session): reuse the object, keep a separate row.
    const reuse = await findReusable(q, { orgId: s.org_id, sha256: hash, kind });
    const key = reuse?.storage_key ?? objectKey(s.org_id, "sessions", s.id, kind, `${id}.${ext}`);
    if (!reuse) await storage.put(key, buf, { contentType: mime });
    const [asset] = await q(
      `INSERT INTO media_assets (id, org_id, workflow_id, session_id, kind, modality, storage_key, mime_type, bytes, sha256, captured_at, duration_ms, consent_id, retention_class, expires_at, created_by, dedup_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'raw_media',$14,$15,$16) RETURNING *`,
      [id, s.org_id, s.workflow_id, s.id, kind, modality, key, mime, buf.length, hash, capturedAt, durationMs ?? null, consentId, retentionExpiry(org?.settings, "raw_media"), userId, reuse?.id ?? null],
    );
    await q(`UPDATE expert_sessions SET budget = jsonb_set(budget, '{rawBytesCaptured}', to_jsonb(COALESCE((budget->>'rawBytesCaptured')::bigint, 0) + $2)) WHERE id = $1`, [s.id, buf.length]);
    return { asset, duplicate: false };
  }

  /** Real browser capture: one chunk/frame per call. Returns immediately; processing is asynchronous and idempotent. */
  async function uploadMedia(ctx, sessionId, { buf, modality, kind, capturedAt, durationMs, diffScore, cycleDiff, purpose }) {
    const limits = { frame: [["image/jpeg", "image/png", "image/webp"], cfg.media.maxFrameBytes], audio_chunk: [["audio/wav"], cfg.media.maxAudioBytes], video_chunk: [["video/webm", "video/mp4"], cfg.media.maxVideoBytes] }[kind];
    if (!limits) throw httpError(400, "unknown media kind");
    if (!CAPTURE_MODALITIES.includes(modality)) throw httpError(400, "unknown modality");
    const mime = validateUpload(buf, { allow: limits[0], maxBytes: limits[1] });
    const out = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      const consent = await activeConsent(q, s);
      const answering = purpose === "answer" && s.status === "asking";
      if (!answering) assertCaptureAllowed(s, consent, modality);
      else if (!consent?.modalities.includes("MICROPHONE")) throw httpError(403, "no recording consent for microphone");
      const at = new Date((Number(capturedAt) || Date.now()) + s.client_clock_offset_ms);
      const { asset, duplicate } = await storeAsset(q, s, { buf, mime, kind, modality, capturedAt: at, durationMs, consentId: consent?.id, userId: ctx.userId });
      if (kind === "video_chunk") return { asset, duplicate, job: null }; // evidence only; never sent to the model by default
      const jobKind = kind === "frame" ? "process_frame" : "process_audio";
      const job = await enqueue(q, { orgId: ctx.orgId, kind: jobKind, key: asset.id, payload: { sessionId: s.id, assetId: asset.id, diffScore, cycleDiff, purpose: answering ? "answer" : "narration", userId: ctx.userId } });
      return { asset, duplicate, job };
    });
    return { assetId: out.asset.id, duplicate: out.duplicate, jobId: out.job?.id ?? null, status: out.job ? "queued" : "stored" };
  }

  /** Simulated capture sources run through the same asset → job → observation path; we wait inline for UX. */
  async function simAction(ctx, sessionId, actionId, param) {
    const { s, env, c, frames, appEvent, close } = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      const consent = await activeConsent(q, s);
      if (s.status !== "capturing") throw httpError(409, "session is not capturing");
      if (s.privacy.paused) throw httpError(409, "capture is paused");
      const env = simSource(s.capture_source);
      const c = env?.cases.find((x) => x.id === s.case_ref);
      const action = env?.actions.find((a) => a.id === actionId);
      if (!c || !action) throw httpError(400, "unknown action");
      if (action.param && !(c.paramOptions?.[action.id] ?? []).includes(param)) throw httpError(400, "invalid action parameter");
      const sim = s.sim_state;
      const eff = c.effect(sim.state, actionId, param) ?? {};
      const frameStates = [...(eff.frames ?? []).map((f) => ({ ...sim.state, ...f })), { ...sim.state, ...(eff.set ?? {}) }];
      sim.state = frameStates.at(-1);
      const frames = [];
      const wf = await loadWorkflow(q, s.workflow_id);
      const pixelModalities = env.emits.filter((m) => PIXEL.has(m)).filter((m) => (m === "SCREEN" ? wf.modalities.screen : wf.modalities.camera));
      for (const fs of frameStates) {
        for (const m of pixelModalities) {
          if (!consent?.modalities.includes(m) || s.privacy.excluded?.[m]) continue;
          const svg = render(env.render, c.view(fs));
          const thumb = thumbFromSvg(svg);
          const recent = sim.sampler.recent ?? [];
          const diffScore = thumbDiff(recent.at(-1), thumb);
          const cycleDiff = recent.length > 1 ? Math.min(...recent.slice(0, -1).map((t) => thumbDiff(t, thumb))) : 1;
          sim.sampler.recent = [...recent, thumb].slice(-8);
          const { asset } = await storeAsset(q, s, { buf: toPng(svg), mime: "image/png", kind: "rendered_frame", modality: m, capturedAt: new Date(), consentId: consent?.id, userId: ctx.userId });
          frames.push({ asset, diffScore, cycleDiff, uiText: env.uiText ? (eff.text ?? "") : undefined });
        }
      }
      await q("UPDATE expert_sessions SET sim_state = $2, updated_at = now() WHERE id = $1", [s.id, JSON.stringify(sim)]);
      const appEvent = env.emits.includes("APP_EVENT") && wf.modalities.app_events
        ? { modality: "APP_EVENT", source: "sim", text: `${action.label}${param ? ` ${param}` : ""}${eff.text ? ` → ${eff.text}` : ""}`, structured: { action: actionId, kind: action.kind, param: param ?? null }, plan: { decision: "use_text", reason: "structured application event" } }
        : null;
      if (appEvent) {
        await insertObservation(q, s, { ...appEvent, consentId: consent?.id });
        await q(`UPDATE expert_sessions SET budget = jsonb_set(budget, '{sampler,appEventsPresent}', 'true'::jsonb) WHERE id = $1`, [s.id]);
      }
      return { s, env, c, frames, appEvent, close: action.kind === "close" };
    });
    for (const f of frames) {
      const job = await T(ctx, (q) => enqueue(q, { orgId: ctx.orgId, kind: "process_frame", key: f.asset.id, payload: { sessionId: s.id, assetId: f.asset.id, diffScore: f.diffScore, cycleDiff: f.cycleDiff, uiText: f.uiText, userId: ctx.userId } }));
      await jobs.runInline(job.id);
      await jobs.waitFor(job.id);
    }
    if (close) await endTask(ctx, sessionId, { wait: true });
    return { appEvent: Boolean(appEvent), frames: frames.length };
  }

  async function addNote(ctx, sessionId, text) {
    const clean = String(text ?? "").trim().slice(0, 2000);
    if (!clean) throw httpError(400, "text required");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (s.status !== "capturing" || s.privacy.paused) throw httpError(409, "session is not capturing");
      return insertObservation(q, s, { modality: "TEXT", source: "narrated", text: clean, plan: { decision: "use_text", reason: "typed by the expert" }, flags: scanForInjection(clean) });
    });
  }

  // ---------------------------------------------------------------- job: process_frame
  async function processFrame({ sessionId, assetId, diffScore, cycleDiff, uiText }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId, userId: null };
    const prep = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      const [asset] = await q("SELECT * FROM media_assets WHERE id = $1", [assetId]);
      if (!asset || asset.deleted_at) return { skip: true };
      const [done] = await q("SELECT id FROM observations WHERE media_asset_id = $1", [assetId]);
      if (done) return { skip: true }; // idempotent: never reprocess
      const wf = await loadWorkflow(q, s.workflow_id);
      const recent = (await q("SELECT modality, text FROM observations WHERE session_id = $1 AND dropped = false AND deleted_at IS NULL AND text <> '' ORDER BY seq DESC LIMIT 4", [s.id])).reverse().map((o) => `(${o.modality}) ${o.text}`);
      return { s, asset, wf, recent };
    });
    if (prep.skip) return { skipped: true };
    const { s, asset, wf, recent } = prep;
    const sampler = s.budget.sampler ?? { seen: false, droppedSinceVision: 0 };
    const plan = planObservation({ modality: asset.modality, uiText, diffScore, cycleDiff }, P, sampler);
    let o = { modality: asset.modality, source: asset.kind === "rendered_frame" ? "sim" : "live", capturedAt: asset.captured_at, mediaAssetId: asset.id, consentId: asset.consent_id, plan, text: "" };
    if (plan.decision === "use_text" || plan.decision === "evidence_only") {
      o.text = uiText ?? "";
      o.dropped = plan.decision === "evidence_only";
    } else if (plan.decision === "drop_stable") {
      o.dropped = true;
      sampler.droppedSinceVision = (sampler.droppedSinceVision ?? 0) + 1;
    } else {
      const buf = await storage.get(asset.storage_key);
      if (!buf) throw new Error("asset bytes missing");
      const media = { mimeType: asset.mime_type, data: buf.toString("base64") };
      let r = await ai(ctx, s, () => interpretObservation({ wf, modality: asset.modality, media, recent, mediaResolution: plan.resolution }));
      if (P.escalateBelowConfidence && r.source === "gemini" && r.confidence < P.escalateBelowConfidence && plan.resolution === "MEDIA_RESOLUTION_LOW") {
        r = await ai(ctx, s, () => interpretObservation({ wf, modality: asset.modality, media, recent, mediaResolution: "MEDIA_RESOLUTION_MEDIUM" }));
        plan.escalated = "low confidence at LOW → re-read at MEDIUM";
      }
      const readings = r.stateReadings.map((x) => `${x.name}=${x.value}`).join(", ");
      o.text = `${r.actionDetected ? `${r.actionDetected.replace(/\.$/, "")}. ` : ""}${r.observed}${readings ? ` [${readings}]` : ""}`;
      Object.assign(o, { readings: r.stateReadings, changeType: r.changeType, confidence: r.confidence, flags: r.containsInstructionsToAI ? ["instructions-in-image"] : [] });
      o.flags = [...(o.flags ?? []), ...scanForInjection(o.text)];
      o.dropped = r.changeType === "none" && sampler.seen;
      sampler.seen = true;
      sampler.droppedSinceVision = 0;
    }
    await T(ctx, async (q) => {
      const [dup] = await q("SELECT id FROM observations WHERE media_asset_id = $1", [asset.id]);
      if (dup) return;
      await insertObservation(q, s, o);
      await q("UPDATE media_assets SET status = 'processed' WHERE id = $1", [asset.id]);
      await q(`UPDATE expert_sessions SET budget = jsonb_set(budget, '{sampler}', $2::jsonb) WHERE id = $1`, [s.id, JSON.stringify({ ...sampler, appEventsPresent: s.budget.sampler?.appEventsPresent ?? false })]);
      if (o.flags?.length) await audit(q, { orgId: s.org_id, action: "ai.injection_signal", targetType: "media_asset", targetId: asset.id, metadata: { flags: o.flags } });
    });
    return { decision: plan.decision };
  }

  // ---------------------------------------------------------------- job: process_audio (narration or spoken answer)
  async function processAudio({ sessionId, assetId, purpose }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId, userId: null };
    const prep = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      const [asset] = await q("SELECT * FROM media_assets WHERE id = $1", [assetId]);
      const [done] = await q("SELECT id FROM observations WHERE media_asset_id = $1", [assetId]);
      return { s, asset, done };
    });
    if (!prep.asset || prep.done || prep.asset.deleted_at) return { skipped: true };
    const { s, asset } = prep;
    const buf = await storage.get(asset.storage_key);
    const t = await ai(ctx, s, () => transcribe({ media: { mimeType: asset.mime_type, data: buf.toString("base64") }, context: purpose === "answer" ? s.question?.text ?? "" : "", expectedLanguage: s.language }));
    t.incomplete = Boolean(t.incomplete || endsMidSpeech(buf)); // model signal OR acoustic signal
    const durationSec = (asset.duration_ms ?? 0) / 1000;
    await T(ctx, async (q) => {
      const near = (await q(`SELECT id FROM observations WHERE session_id = $1 AND modality IN ('SCREEN','CAMERA') AND deleted_at IS NULL
                             ORDER BY abs(extract(epoch FROM captured_at - $2::timestamptz)) LIMIT 1`, [s.id, asset.captured_at]))[0]?.id ?? null;
      const obs = await insertObservation(q, s, {
        modality: "MICROPHONE", source: purpose === "answer" ? "voice" : "live", capturedAt: asset.captured_at, mediaAssetId: asset.id, consentId: asset.consent_id,
        text: t.speechPresent === false ? "" : `${t.transcript}${t.incomplete ? " [recording ended mid-speech]" : ""}`, dropped: t.speechPresent === false, confidence: t.confidence, linkedTo: near,
        plan: { decision: "transcribe", reason: "speech heard once", estTokens: Math.ceil(durationSec * TOKENS.audioPerSec) }, flags: scanForInjection(t.transcript),
      });
      await q(`INSERT INTO transcript_segments (org_id, session_id, media_asset_id, observation_id, start_at, end_at, text, confidence, speaker_person_id, expires_at)
               VALUES ($1,$2,$3,$4,$5,$5::timestamptz + ($6 || ' milliseconds')::interval,$7,$8,$9, now() + interval '180 days')`,
        [s.org_id, s.id, asset.id, obs.id, asset.captured_at, String(asset.duration_ms ?? 0), t.transcript, t.confidence, s.expert_person_id]);
      await q("UPDATE media_assets SET status = 'processed' WHERE id = $1", [asset.id]);
      if (purpose === "answer") {
        if (!t.transcript.trim()) { await q("UPDATE expert_sessions SET last_error = 'could not understand the recording; try again or type' WHERE id = $1", [s.id]); return; }
        // A spoken answer is a DRAFT until the expert checks it: transcription can be wrong, especially across languages and dialects.
        await q("UPDATE expert_sessions SET answer_draft = $2, last_error = NULL, updated_at = now() WHERE id = $1",
          [s.id, JSON.stringify({ text: t.transcript.trim(), language: normalizeLanguage(t.language ?? s.language), confidence: t.confidence, incomplete: t.incomplete, observationId: obs.id, at: new Date().toISOString() })]);
      }
    });
    return { transcribed: true, incomplete: t.incomplete };
  }

  // ---------------------------------------------------------------- natural break → detection
  async function endTask(ctx, sessionId, { wait = false } = {}) {
    const job = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (s.status !== "capturing") throw httpError(409, "session is not capturing");
      await q("UPDATE expert_sessions SET status = 'processing', updated_at = now() WHERE id = $1", [s.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "capture.end_task", targetType: "session", targetId: s.id, requestId: ctx.requestId });
      return enqueue(q, { orgId: ctx.orgId, kind: "analyze_session", key: `${s.id}:analyze`, payload: { sessionId: s.id } });
    });
    if (wait) { await jobs.runInline(job.id); await jobs.waitFor(job.id, 180000); }
    return { jobId: job.id };
  }

  function eventsFrom(rows) {
    return rows.filter((o) => !o.dropped && !o.deleted_at && o.text).map((o) => ({ id: `e${o.seq}`, obsId: o.id, modality: o.modality, text: o.text, structured: o.structured, mediaAssetId: o.media_asset_id }));
  }

  async function procedureFor(q, s, wf, events) {
    if (s.procedure_id) return (await q("SELECT * FROM workflow_procedures WHERE id = $1", [s.procedure_id]))[0] ?? null;
    const procs = await loadProcedures(q, wf.id);
    if (procs.length <= 1) return procs[0] ?? null;
    // Unknown which documented procedure applies: give detection all of them (short), keep best match for provenance.
    const text = events.map((e) => e.text).join(" ").toLowerCase();
    const score = (p) => `${p.title} ${p.applies_when} ${p.steps.join(" ")}`.toLowerCase().match(/[\p{L}\p{M}\p{N}-]{4,}/gu)?.filter((w) => text.includes(w)).length ?? 0;
    const best = [...procs].sort((a, b) => score(b) - score(a))[0];
    return { ...best, title: `${wf.name}: documented procedures`, applies_when: "see each section", steps: procs.flatMap((p) => p.steps.map((st) => `[${p.title}] ${st}`)), default_decision: procs.map((p) => `${p.title}: ${p.default_decision}`).join("; "), resolution_actions: [] };
  }

  async function analyzeSession({ sessionId }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId, userId: null };
    const prep = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      if (s.status !== "processing") return { skip: true };
      const [pending] = await q(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'sessionId' = $1 AND kind IN ('process_frame','process_audio') AND status IN ('queued','running')`, [s.id]);
      if (pending.n) return { wait: true };
      const wf = await loadWorkflow(q, s.workflow_id);
      const rows = await q("SELECT * FROM observations WHERE session_id = $1 ORDER BY seq", [s.id]);
      const events = eventsFrom(rows);
      const procedure = await procedureFor(q, s, wf, events);
      wf.missionFocus = await missionFocusFor(q, s.mission_id);
      await q("UPDATE expert_sessions SET status = 'analyzing' WHERE id = $1", [s.id]);
      return { s, wf, events, procedure };
    });
    if (prep.skip) return { skipped: true };
    if (prep.wait) throw new RetryLater("media still processing", 1500);
    const { s, wf, events, procedure } = prep;
    const { events: windowed, summary } = eventWindow(events, P.maxEvents);
    const known = await knowledge.retrieveForSession(ctx, wf.id, windowed.map((e) => e.text).join(" ").slice(0, 2000), P.knowledgeTopK, { forPersonId: s.expert_person_id });
    const kAlias = known.map((k, i) => ({ id: `k${i + 1}`, rule: k.rule, artifactId: k.artifact_id, judgmentId: k.judgment_id, expertPersonId: k.expert_person_id }));
    const situation = Object.entries(s.sim_state?.facts ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ");
    const media = P.sendAllFrames ? await framesFor(ctx, events.filter((e) => PIXEL.has(e.modality)).map((e) => e.mediaAssetId)) : [];
    const det = await ai(ctx, s, () => detectJudgment({ wf, procedure, situation, events: windowed, eventSummary: summary, knowledge: kAlias, media, mediaResolution: P.routineResolution }));

    // ------------- deterministic gate (src/ai/gate.mjs)
    const g = gate({ det, events: windowed, procedure, knowledge: kAlias, expertPersonId: s.expert_person_id });
    const { resolutionDiffers, log } = g;
    let chosen = g.chosen, intent = g.intent ?? "why", related = g.related;
    const others = kAlias.filter((k) => k.expertPersonId !== s.expert_person_id);
    if (!chosen && others.length) {
      const cx = await ai(ctx, s, () => contradictsKnowledge({ wf, situation, events: windowed, knowledge: others }));
      if (cx.contradicts) {
        related = others.find((k) => k.id === cx.knowledgeId);
        chosen = { eventIds: cx.eventIds.length ? cx.eventIds : [windowed.at(-1)?.id].filter(Boolean), type: "contradiction", action: windowed.at(-1)?.text ?? "", outcome: "", alternatives: [related.rule], choiceEvidence: cx.eventIds, isJudgment: true, judgmentBasis: "contradicts_colleague", summary: cx.explanation, salience: 0.8, changesWhatIsDone: true, reasonInferableFromObservation: false, matchesKnowledgeId: "", contradictsKnowledgeId: related.id, whyAsk: "Differs from a colleague's approved practice in a similar situation." };
        intent = "consistency";
        log.push(`contradiction: differs from ${related.id} (another expert) → ask`);
      } else log.push("consistent with other experts' approved practice");
    }

    if (!chosen) {
      await T(ctx, async (q) => {
        await q(`UPDATE expert_sessions SET status = 'no_judgment', detection = $2, gate = $3, ended_at = now(), updated_at = now() WHERE id = $1`, [s.id, JSON.stringify(trimDetection(det)), JSON.stringify({ resolutionDiffers: Boolean(resolutionDiffers), log })]);
        await enqueue(q, { orgId: ctx.orgId, kind: "retention_session", key: `${s.id}:retention`, payload: { sessionId: s.id } });
      });
      return { asked: false };
    }
    const moment = await momentEvidence(ctx, events, chosen);
    const q1 = await ai(ctx, s, () => generateQuestion({ wf, procedure, candidate: chosen, events: windowed, intent, relatedRule: related?.rule ?? null, media: moment.media, mediaResolution: moment.resolution, language: s.language }));
    await T(ctx, async (q) => {
      await q(`UPDATE expert_sessions SET status = 'asking', detection = $2, gate = $3, candidate = $4, question = $5,
               budget = jsonb_set(budget, '{momentEvidence}', to_jsonb($6::text)), updated_at = now() WHERE id = $1`,
        [s.id, JSON.stringify(trimDetection(det)), JSON.stringify({ resolutionDiffers: Boolean(resolutionDiffers), log }),
          JSON.stringify({ ...chosen, momentObservationIds: moment.obsIds, relatedArtifactId: related?.artifactId ?? null, relatedJudgmentId: related?.judgmentId ?? null, procedureId: procedure?.id ?? null }),
          JSON.stringify({ text: q1.question, intent: q1.intent, alternates: q1.alternates, source: q1.source }), moment.note]);
      await q("INSERT INTO session_dialogue (org_id, session_id, seq, question, intent, question_source, question_language) VALUES ($1,$2,1,$3,$4,$5,$6)", [s.org_id, s.id, q1.question, q1.intent, q1.source, s.language]);
    });
    return { asked: true };
  }

  function trimDetection(det) {
    return { source: det.source, actionDiffersFromProcedure: det.actionDiffersFromProcedure, events: det.events, candidates: det.candidates.slice(0, 5) };
  }

  /** Pixels for the moment: only if pixels were the source of the evidence (UI text / app events need none). */
  async function momentEvidence(ctx, events, candidate) {
    const ids = new Set([...candidate.eventIds, ...(candidate.choiceEvidence ?? [])]);
    let picked = events.filter((e) => ids.has(e.id) && PIXEL.has(e.modality) && e.mediaAssetId);
    if (!picked.length) {
      const lastIdx = Math.max(...events.map((e, i) => (ids.has(e.id) ? i : -1)));
      const prev = events.slice(0, lastIdx + 1).reverse().find((e) => PIXEL.has(e.modality) && e.mediaAssetId);
      if (prev) picked = [prev];
    }
    const pixelSourced = await T(ctx, async (q) => (picked.length ? (await q("SELECT id FROM media_assets WHERE id = ANY($1) AND kind IN ('frame','rendered_frame')", [picked.map((e) => e.mediaAssetId)])).map((r) => r.id) : []));
    const uiTextOnly = events.some((e) => e.modality === "APP_EVENT");
    if (!pixelSourced.length || uiTextOnly) return { media: [], resolution: null, note: "semantic events sufficient (app events / UI text available)", obsIds: [] };
    const use = picked.slice(-P.momentFrames);
    return { media: await framesFor(ctx, use.map((e) => e.mediaAssetId)), resolution: P.momentResolution, note: `${use.length} moment frame(s) attached at ${P.momentResolution ?? "DEFAULT"}`, obsIds: use.map((e) => e.obsId) };
  }

  async function framesFor(ctx, assetIds) {
    if (!assetIds.length) return [];
    const assets = await T(ctx, (q) => q("SELECT storage_key, mime_type FROM media_assets WHERE id = ANY($1) AND deleted_at IS NULL", [assetIds]));
    const out = [];
    for (const a of assets) { const b = await storage.get(a.storage_key); if (b) out.push({ mimeType: a.mime_type, data: b.toString("base64") }); }
    return out;
  }

  // ---------------------------------------------------------------- answers → extraction → boundary → follow-up or finalize
  async function recordAnswer(q, s, text, observationId, ctxUserId, { language = null, source = "typed", original = null } = {}) {
    const [d] = await q("SELECT seq FROM session_dialogue WHERE session_id = $1 AND answer IS NULL ORDER BY seq DESC LIMIT 1", [s.id]);
    if (!d) throw httpError(409, "no open question");
    await q(`UPDATE session_dialogue SET answer = $3, answer_observation_id = $4, answered_at = now(), answer_language = $5, answer_source = $6, answer_original = $7
             WHERE session_id = $1 AND seq = $2`, [s.id, d.seq, text.slice(0, 4000), observationId, normalizeLanguage(language ?? s.language), source, original ? String(original).slice(0, 4000) : null]);
    await q("UPDATE expert_sessions SET answer_draft = NULL WHERE id = $1", [s.id]);
    await q("UPDATE expert_sessions SET status = 'extracting', last_error = NULL, updated_at = now() WHERE id = $1", [s.id]);
    await enqueue(q, { orgId: s.org_id, kind: "process_answer", key: `${s.id}:answer:${d.seq}`, payload: { sessionId: s.id, seq: d.seq } });
  }

  async function answer(ctx, sessionId, { text, language = null, fromDraft = false, wait = false }) {
    const clean = String(text ?? "").trim().slice(0, 4000);
    if (!clean) throw httpError(400, "answer required");
    const jobId = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (s.status !== "asking") throw httpError(409, "no open question");
      const draft = fromDraft ? s.answer_draft : null;
      if (fromDraft && !draft) throw httpError(409, "no spoken answer is waiting for review");
      if (draft) {
        // Spoken answer, checked by the expert. Keep the machine transcript when they corrected it, so provenance is honest.
        const corrected = clean !== draft.text;
        if (corrected) await q("UPDATE observations SET text = $2 WHERE id = $1", [draft.observationId, `${clean} [corrected by the speaker]`]);
        await recordAnswer(q, s, clean, draft.observationId, ctx.userId, { language: language ?? draft.language, source: corrected ? "voice_corrected" : "voice", original: corrected ? draft.text : null });
      } else {
        const obs = await insertObservation(q, s, { modality: "TEXT", source: "typed", text: clean, plan: { decision: "use_text", reason: "typed answer" }, flags: scanForInjection(clean), linkedTo: s.candidate?.momentObservationIds?.[0] ?? null });
        await recordAnswer(q, s, clean, obs.id, ctx.userId, { language, source: "typed" });
      }
      const [j] = await q("SELECT id FROM jobs WHERE payload->>'sessionId' = $1 AND kind = 'process_answer' ORDER BY created_at DESC LIMIT 1", [s.id]);
      return j.id;
    });
    if (wait) { await jobs.runInline(jobId); await jobs.waitFor(jobId, 180000); }
    return { jobId };
  }

  async function stopQuestions(ctx, sessionId, { wait = false } = {}) {
    const job = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (s.status !== "asking") throw httpError(409, "nothing to finalise");
      const [answered] = await q("SELECT count(*)::int AS n FROM session_dialogue WHERE session_id = $1 AND answer IS NOT NULL", [s.id]);
      if (!answered.n) throw httpError(409, "answer at least one question first");
      await q("DELETE FROM session_dialogue WHERE session_id = $1 AND answer IS NULL", [s.id]);
      await q("UPDATE expert_sessions SET status = 'extracting' WHERE id = $1", [s.id]);
      return enqueue(q, { orgId: ctx.orgId, kind: "process_answer", key: `${s.id}:final`, payload: { sessionId: s.id, final: true } });
    });
    if (wait) { await jobs.runInline(job.id); await jobs.waitFor(job.id, 180000); }
    return { jobId: job.id };
  }

  async function processAnswer({ sessionId, final = false }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId, userId: null };
    const prep = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      if (s.status !== "extracting") return { skip: true };
      const wf = await loadWorkflow(q, s.workflow_id);
      const rows = await q("SELECT * FROM observations WHERE session_id = $1 ORDER BY seq", [s.id]);
      const dialogue = await q("SELECT * FROM session_dialogue WHERE session_id = $1 AND answer IS NOT NULL ORDER BY seq", [s.id]);
      const answerIds = new Set(dialogue.map((d) => d.answer_observation_id));
      const events = eventsFrom(rows.filter((o) => !answerIds.has(o.id)));
      const procedure = await procedureFor(q, s, wf, events);
      wf.missionFocus = await missionFocusFor(q, s.mission_id);
      return { s, wf, rows, dialogue, events, procedure };
    });
    if (prep.skip) return { skipped: true };
    const { s, wf, dialogue, events, procedure } = prep;
    const { events: windowed } = eventWindow(events, P.maxEvents);
    const d = dialogue.map((x) => ({ question: x.question, answer: x.answer }));
    const moment = await momentEvidence(ctx, events, s.candidate);
    const draft = await ai(ctx, s, () => extractKnowledge({ wf, procedure, candidate: s.candidate, events: windowed, dialogue: d, media: moment.media, mediaResolution: moment.resolution, language: s.language }));
    const expertWords = d.map((x) => x.answer).join("\n");
    const verified = verifyFields(draft.fields, { expertWords, eventIds: windowed.map((e) => e.id) });
    draft.fields = verified.fields;
    const boundary = await ai(ctx, s, () => findBoundary({ wf, procedure, draft, dialogue: d, language: s.language }));
    const notes = [...verified.notes, ...(boundary.notes ?? []), ...(draft.attributionNote ? [draft.attributionNote] : [])];
    // Cross-operation guard: a boundary is confirmed only if extraction ALSO found the exception in the expert's own words.
    if (boundary.status === "confirmed" && draft.fields.exception.status !== "EXPERT_STATED") {
      boundary.status = "needs_confirmation"; boundary.statedByExpert = false;
      boundary.hypothesis ||= `Possibly: ${boundary.boundaryCondition}`;
      if (boundary.nextQuestionIntent === "none") boundary.nextQuestionIntent = "counterfactual";
      notes.push("boundary: extraction did not find the exception in the expert's words → needs confirmation");
    }
    const followups = d.length - 1;
    if (!final && boundary.status !== "confirmed" && followups < MAX_FOLLOWUPS && boundary.nextQuestionIntent !== "none") {
      const q2 = await ai(ctx, s, () => generateQuestion({ wf, procedure, candidate: s.candidate, events: windowed, intent: boundary.nextQuestionIntent, dialogue: d, hypothesis: boundary.hypothesis, language: s.language }));
      await T(ctx, async (q) => {
        await q("UPDATE expert_sessions SET status = 'asking', question = $2, draft = $3, updated_at = now() WHERE id = $1", [s.id, JSON.stringify({ text: q2.question, intent: q2.intent, alternates: q2.alternates, source: q2.source, hypothesis: boundary.hypothesis }), JSON.stringify({ draft, boundary, notes })]);
        await q("INSERT INTO session_dialogue (org_id, session_id, seq, question, intent, question_source, question_language) VALUES ($1,$2,$3,$4,$5,$6,$7)", [s.org_id, s.id, d.length + 1, q2.question, q2.intent, q2.source, s.language]);
      });
      return { followUp: true };
    }
    await finalize(ctx, { s, wf, procedure, draft, boundary, notes, dialogue, events: windowed });
    return { finalized: true };
  }

  async function finalize(ctx, { s, wf, procedure, draft, boundary, notes, dialogue, events }) {
    const f = draft.fields;
    const observedBehavior = draft.observedBehavior || f.decision.value;
    const explanation = dialogue.map((x) => x.answer).join(" ");
    const conflict = await ai(ctx, s, () => detectConflict({ wf, procedure, observedBehavior, expertExplanation: explanation }));
    const aliasToObs = new Map(events.map((e) => [e.id, e.obsId]));
    const content = {
      title: draft.title, fields: f, boundary, ruleOrJudgment: draft.ruleOrJudgment, aiConfidence: draft.confidence,
      documentation: { documentedProcedure: procedure ? `${procedure.title}: ${procedure.default_decision}` : null, observedBehavior, expertExplanation: explanation, defaultBehavior: draft.defaultBehavior },
      situationFacts: { ...(s.sim_state?.facts ?? {}) }, candidate: { action: s.candidate.action, alternatives: s.candidate.alternatives, type: s.candidate.type },
    };
    content.rule = toRule({ ...Object.fromEntries(CHAIN_FIELDS.map((k) => [k, f[k].value])), boundary });
    const judgmentId = await T(ctx, async (q) => {
      const evidenceObs = [
        ...s.candidate.eventIds.map((id) => [aliasToObs.get(id), "trigger"]),
        ...(s.candidate.momentObservationIds ?? []).map((id) => [id, "moment_frame"]),
        ...(await q("SELECT answer_observation_id FROM session_dialogue WHERE session_id = $1 AND answer_observation_id IS NOT NULL", [s.id])).map((r) => [r.answer_observation_id, "expert_answer"]),
      ].filter(([id]) => id);
      const times = evidenceObs.length ? await q("SELECT min(captured_at) AS a, max(captured_at) AS b FROM observations WHERE id = ANY($1)", [evidenceObs.map(([id]) => id)]) : [{}];
      const [j] = await q(
        `INSERT INTO judgments (org_id, workflow_id, session_id, expert_person_id, procedure_id, case_ref, status, title, extraction_source, evidence_window)
         VALUES ($1,$2,$3,$4,$5,$6,'observed',$7,$8, CASE WHEN $9::timestamptz IS NULL THEN NULL ELSE tstzrange($9::timestamptz, $10::timestamptz, '[]') END) RETURNING id`,
        [s.org_id, s.workflow_id, s.id, s.expert_person_id, procedure?.id ?? s.procedure_id, s.case_ref, String(draft.title).slice(0, 200), draft.source, times[0].a ?? null, times[0].b ?? null]);
      await q("INSERT INTO judgment_versions (org_id, judgment_id, version, content, verification, author_type) VALUES ($1,$2,1,$3,$4,'ai')", [s.org_id, j.id, JSON.stringify(content), JSON.stringify({ notes, extraction: draft.source, boundary: boundary.source })]);
      for (const [obsId, role] of evidenceObs) await q("INSERT INTO judgment_evidence (org_id, judgment_id, observation_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.org_id, j.id, obsId, role]);
      if (conflict.gapType !== "none" && procedure) {
        await q(`INSERT INTO documentation_conflicts (org_id, judgment_id, procedure_id, gap_type, documented_procedure, observed_behavior, expert_explanation, analysis, severity)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [s.org_id, j.id, procedure.id, conflict.gapType, `${procedure.title}: ${procedure.default_decision}`, observedBehavior, explanation.slice(0, 2000), conflict.analysis, conflict.severity]);
      }
      await q("UPDATE expert_sessions SET status = 'validating', judgment_id = $2, question = NULL, draft = NULL, updated_at = now() WHERE id = $1", [s.id, j.id]);
      await enqueue(q, { orgId: s.org_id, kind: "detect_gaps", key: `${j.id}:detect:1`, payload: { judgmentId: j.id } });
      await notifyMissionReview(q, s, j.id);
      return j.id;
    });
    await knowledge.checkOtherExperts(ctx, { judgmentId, workflowId: wf.id, procedure });
    return judgmentId;
  }

  // ---------------------------------------------------------------- privacy: delete a moment
  async function deleteObservation(ctx, observationId) {
    const released = [];
    const out = await T(ctx, async (q) => {
      const [o] = await q("SELECT o.*, s.expert_person_id FROM observations o JOIN expert_sessions s ON s.id = o.session_id WHERE o.id = $1", [observationId]);
      if (!o) throw httpError(404, "observation not found");
      if (ctx.personId !== o.expert_person_id && !ctx.roles.includes("ORG_ADMIN")) throw httpError(403, "only the captured expert or an admin can delete a moment");
      if (o.media_asset_id) {
        const [a] = await q("SELECT storage_key FROM media_assets WHERE id = $1", [o.media_asset_id]);
        await q("UPDATE media_assets SET status = 'deleted', deleted_at = now() WHERE id = $1", [o.media_asset_id]);
        if (a) released.push(a.storage_key);
      }
      await q("UPDATE observations SET text = '', readings = '[]', deleted_at = now() WHERE id = $1", [o.id]);
      await q("UPDATE transcript_segments SET text = '', deleted_at = now() WHERE observation_id = $1", [o.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "capture.delete_moment", targetType: "observation", targetId: o.id, requestId: ctx.requestId });
      return { deleted: true };
    });
    // After commit: remove the stored object unless another live record (another session in this space) still uses it.
    await deleteUnreferenced(T, ctx, storage, released);
    return out;
  }

  // ---------------------------------------------------------------- views
  async function getSession(ctx, sessionId, { limit = 200 } = {}) {
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertCanRead(ctx, s);
      const obs = await q(`SELECT id, seq, modality, source, captured_at, text, readings, plan, change_type, confidence, dropped, media_asset_id, deleted_at, security_flags, linked_observation_id
                           FROM observations WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`, [s.id, Math.min(limit, 500)]);
      const dialogue = await q("SELECT seq, question, intent, question_source, question_language, answer, answer_language, answer_source, answer_original, asked_at, answered_at FROM session_dialogue WHERE session_id = $1 ORDER BY seq", [s.id]);
      const [jobsState] = await q(`SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS pending, count(*) FILTER (WHERE status = 'dead')::int AS failed
                                   FROM jobs WHERE payload->>'sessionId' = $1`, [s.id]);
      const ai = await q(`SELECT count(*)::int AS calls, COALESCE(sum(prompt_tokens),0)::int AS prompt, COALESCE(sum(output_tokens + thought_tokens),0)::int AS output,
                                 COALESCE(sum((tokens_by_modality->>'IMAGE')::int),0)::int AS image, COALESCE(sum(cost_usd),0)::float AS cost
                          FROM ai_inferences WHERE session_id = $1 AND status = 'ok'`, [s.id]);
      const [consent] = await q("SELECT modalities, policy_version, granted_at FROM consent_records WHERE session_id = $1 AND revoked_at IS NULL ORDER BY granted_at DESC LIMIT 1", [s.id]);
      // What the expert must know before agreeing: purpose, who will see it, AI processing, retention.
      const [space] = await q("SELECT experience, settings FROM organizations WHERE id = $1", [s.org_id]);
      const [mission] = s.mission_id ? await q("SELECT id, name FROM kt_missions WHERE id = $1", [s.mission_id]) : [];
      const [wfMods] = await q("SELECT modalities FROM workflows WHERE id = $1", [s.workflow_id]);
      const disclosure = {
        purpose: mission ? `Knowledge-transfer mission "${mission.name}"` : "Preserving how you make decisions in this workflow",
        missionId: mission?.id ?? null,
        access: space?.experience === "living" ? "Only you, until you approve the knowledge and choose who may see it." : "You first. Nothing becomes knowledge until you approve it; approved knowledge is then shared with people in this space who learn this workflow.",
        ai: aiAvailable() ? "Captured frames, audio and your answers are processed by Gemini on Google Cloud Vertex AI to find decisions and ask questions. They are not used to train models." : "AI processing is offline here: simple built-in rules are used instead of a model.",
        retention: `Original recordings are kept ${space?.settings?.retention?.raw_media ?? 30} days for your review; only the evidence linked to knowledge you approve is kept longer. You can delete any moment at any time.`,
      };
      const [person] = await q("SELECT display_name FROM people WHERE id = $1", [s.expert_person_id]);
      const frames = obs.filter((o) => PIXEL.has(o.modality)).length;
      let sim = null;
      if (s.sim_state && s.capture_source.startsWith("sim:")) {
        const env = simSource(s.capture_source);
        const c = env.cases.find((x) => x.id === s.case_ref);
        sim = { render: env.render, svg: render(env.render, c.view(s.sim_state.state)), actions: env.actions, paramOptions: c.paramOptions ?? {}, label: env.label, emits: env.emits, title: c.title, script: c.script, facts: s.sim_state.facts };
      }
      return {
        id: s.id, workflowId: s.workflow_id, status: s.status, language: s.language, answerDraft: ctx.personId === s.expert_person_id ? s.answer_draft : null, captureSource: s.capture_source, caseRef: s.case_ref, expertPersonId: s.expert_person_id, expertName: person?.display_name,
        isMine: ctx.personId === s.expert_person_id, privacy: s.privacy, consent, disclosure, modalities: wfMods?.modalities ?? {}, gate: s.gate, candidate: s.candidate, question: s.question, detection: s.detection ? { source: s.detection.source, labels: Object.fromEntries((s.detection.events ?? []).map((e) => [e.eventId, e])) } : null,
        dialogue, observations: obs.reverse().map((o) => ({ ...o, alias: `e${o.seq}` })), judgmentId: s.judgment_id, transferId: s.transfer_id, lastError: s.last_error,
        processing: jobsState, budget: s.budget, sim, startedAt: s.started_at, endedAt: s.ended_at,
        tokens: { ...ai[0], imageIfDefault: frames * TOKENS.imageDefault, frames, framesToVision: obs.filter((o) => o.plan?.decision === "vision").length },
      };
    });
  }

  /** Temporal evidence window: everything captured around a moment, across modalities. */
  async function evidenceWindow(ctx, sessionId, atIso, spanMs = 6000) {
    requirePermission(ctx, "evidence.read");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertCanRead(ctx, s);
      const at = new Date(atIso);
      if (Number.isNaN(at.getTime())) throw httpError(400, "invalid time");
      const span = Math.min(Math.max(Number(spanMs) || 6000, 1000), 60000);
      const obs = await q(`SELECT id, seq, modality, captured_at, text, media_asset_id, deleted_at FROM observations
                           WHERE session_id = $1 AND captured_at BETWEEN $2::timestamptz - ($3 || ' milliseconds')::interval AND $2::timestamptz + ($3 || ' milliseconds')::interval
                           ORDER BY captured_at LIMIT 100`, [s.id, at.toISOString(), String(span)]);
      const segs = await q(`SELECT start_at, end_at, text FROM transcript_segments WHERE session_id = $1 AND deleted_at IS NULL
                            AND tstzrange(start_at, end_at, '[]') && tstzrange($2::timestamptz - ($3 || ' milliseconds')::interval, $2::timestamptz + ($3 || ' milliseconds')::interval)`, [s.id, at.toISOString(), String(span)]);
      const video = await q(`SELECT id, captured_at, duration_ms FROM media_assets WHERE session_id = $1 AND kind = 'video_chunk' AND deleted_at IS NULL
                             AND captured_at BETWEEN $2::timestamptz - interval '30 seconds' AND $2::timestamptz + ($3 || ' milliseconds')::interval ORDER BY captured_at`, [s.id, at.toISOString(), String(span)]);
      return { at, spanMs: span, observations: obs, transcript: segs, videoChunks: video };
    });
  }

  /**
   * Terminate a session started by accident or no longer needed (the expert, or a workflow manager). Its captured
   * evidence is removed from use (soft-deleted, purged by retention), an unconfirmed Work Map is withdrawn, and the
   * database keeps the session terminated even if a background job finishes afterwards (migration 006).
   */
  async function terminate(ctx, sessionId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      if (s.expert_person_id !== ctx.personId && !can(ctx, "workflow.manage")) throw httpError(403, "only the expert of this session can terminate it");
      if (["done", "mapped", "terminated"].includes(s.status)) throw httpError(409, s.status === "terminated" ? "this session was already terminated" : "this session is complete; withdraw its knowledge instead");
      await q("UPDATE expert_sessions SET status = 'terminated', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1", [s.id]);
      await q("UPDATE observations SET deleted_at = now() WHERE session_id = $1 AND deleted_at IS NULL", [s.id]);
      await q("UPDATE media_assets SET deleted_at = now() WHERE session_id = $1 AND deleted_at IS NULL", [s.id]);
      await q("UPDATE work_maps SET status = 'withdrawn', updated_at = now() WHERE session_id = $1 AND status <> 'confirmed'", [s.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "session.terminate", targetType: "session", targetId: s.id, requestId: ctx.requestId, metadata: { from: s.status } });
      return { status: "terminated" };
    });
  }

  /** My recent sessions with a clear status, visible immediately after recording (both live and classic capture). */
  async function mySessions(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const rows = await q(`SELECT s.id, s.status, s.mode, s.capture_source, s.started_at, s.ended_at, w.name AS workflow, m.status AS map_status, m.title AS map_title
                            FROM expert_sessions s JOIN workflows w ON w.id = s.workflow_id LEFT JOIN work_maps m ON m.session_id = s.id
                            WHERE s.expert_person_id = $1 AND s.status <> 'terminated' AND w.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 20`, [ctx.personId ?? null]);
      return rows.map((r) => ({ id: r.id, status: r.status, mode: r.mode, source: r.capture_source, startedAt: r.started_at, endedAt: r.ended_at, workflow: r.workflow,
        title: r.map_title || r.workflow, mapStatus: r.map_status, href: r.mode === "live" || r.map_status ? `#/map/${r.id}` : `#/session/${r.id}` }));
    });
  }

  return {
    startSession, grantConsent, setPrivacy, uploadMedia, simAction, addNote, endTask, answer, stopQuestions, deleteObservation, getSession, evidenceWindow, terminate, mySessions,
    // Reused by live sessions (src/domain/workmaps.mjs): same storage, consent checks and evidence records.
    internals: { loadSession, loadWorkflow, insertObservation, activeConsent, assertCaptureAllowed, assertIsExpert },
    handlers: { process_frame: processFrame, process_audio: processAudio, analyze_session: analyzeSession, process_answer: processAnswer },
  };
}
