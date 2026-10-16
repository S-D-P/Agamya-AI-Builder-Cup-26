// Live sessions → Work Maps → tutoring.
//   Capture (live): Moti and the expert talk while the expert works; every turn is stored as evidence (redacted).
//   Map: when the expert finishes, a job builds the Work Map and the list of what is still unclear.
//   Debrief (live): Moti asks the unclear questions, explains the process back, and the expert confirms or corrects;
//                   the map is rebuilt with the debrief and the expert confirms it ("yes, that is how it works").
//   Teach (live): a new hire works on their own screen; Moti tutors from the confirmed map (tutor_runs).
// The map is stored in English (the shared base). Server-side authorization everywhere; tenant isolation by RLS.
import { requirePermission, can } from "../platform/authz.mjs";
import { httpError } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { enqueue } from "../platform/jobs.mjs";
import { redactText } from "../platform/redact.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { buildWorkMap, narrateWorkMap, LISTEN_LANGUAGES, LISTEN_REVIEWED } from "../ai/ops/workmap.mjs";
import { tts } from "../ai/gemini.mjs";
import { objectKey } from "../platform/storage.mjs";
import { notifyPerson } from "./notifications.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createWorkMaps({ db, capture, storage }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);
  const { loadSession, loadWorkflow, insertObservation, activeConsent, assertIsExpert } = capture.internals;

  // ---------------------------------------------------------------- live turns (called by the live relay)
  /** One spoken turn. Expert speech is evidence (MICROPHONE observation); Moti's turns become dialogue questions. */
  async function liveTurn(ctx, sessionId, { role, text, at = new Date(), phase = "capture" }) {
    const clean = redactText(String(text ?? "").trim().slice(0, 4000));
    if (!clean.text) return null;
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (!["capturing", "debrief"].includes(s.status)) return null;
      const consent = await activeConsent(q, s);
      if (!consent?.modalities.includes("MICROPHONE")) throw httpError(403, "no recording consent for the microphone");
      if (role === "moti") {
        const [{ n }] = await q("SELECT COALESCE(max(seq), 0)::int AS n FROM session_dialogue WHERE session_id = $1", [s.id]);
        await q(`INSERT INTO session_dialogue (org_id, session_id, seq, question, intent, question_source, asked_at, question_language) VALUES ($1,$2,$3,$4,$5,'gemini-live',$6,$7)`,
          [s.org_id, s.id, n + 1, clean.text, phase === "debrief" ? "debrief" : "live", at, s.language]);
        return { role };
      }
      const obs = await insertObservation(q, s, { modality: "MICROPHONE", source: "voice", capturedAt: at, text: clean.text, consentId: consent.id,
        plan: { decision: "transcribe", reason: phase === "debrief" ? "debrief answer" : "live conversation" }, flags: Object.keys(clean.found).map((k) => `redacted:${k}`) });
      // The expert's words after Moti's latest question answer it (appended if they keep talking).
      await q(`UPDATE session_dialogue SET answer = CASE WHEN answer IS NULL THEN $2 ELSE answer || ' ' || $2 END, answer_observation_id = COALESCE(answer_observation_id, $3), answered_at = now(), answer_source = 'voice', answer_language = $4
               WHERE id = (SELECT id FROM session_dialogue WHERE session_id = $1 AND intent IN ('live','debrief') ORDER BY seq DESC LIMIT 1)`, [s.id, clean.text, obs.id, s.language]);
      return { role, observationId: obs.id, redacted: clean.found };
    });
  }

  /** A session started from the live screens is a live session from its first moment (lists link it correctly). */
  async function markLive(ctx, sessionId) {
    return T(ctx, async (q) => { const s = await loadSession(q, sessionId); assertIsExpert(ctx, s); await q("UPDATE expert_sessions SET mode = 'live' WHERE id = $1", [s.id]); });
  }

  /** Off the record: nothing is captured until the expert says so; the period itself is recorded (not its content). */
  async function setOffRecord(ctx, sessionId, on) {
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      const periods = Array.isArray(s.off_record) ? s.off_record : [];
      if (on && !(periods.at(-1) && !periods.at(-1).to)) periods.push({ from: new Date().toISOString(), to: null });
      if (!on && periods.at(-1) && !periods.at(-1).to) periods.at(-1).to = new Date().toISOString();
      await q("UPDATE expert_sessions SET off_record = $2, privacy = jsonb_set(privacy, '{paused}', to_jsonb($3::boolean)), updated_at = now() WHERE id = $1", [s.id, JSON.stringify(periods), Boolean(on)]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: on ? "capture.off_record" : "capture.on_record", targetType: "session", targetId: s.id, requestId: ctx.requestId });
      return { offRecord: Boolean(on) };
    });
  }

  /** The expert finished a phase: build (or rebuild) the Work Map asynchronously. Idempotent per phase. */
  async function finishPhase(ctx, sessionId, phase) {
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      if (phase === "capture" && s.status !== "capturing") throw httpError(409, "this session is not capturing");
      if (phase === "debrief" && s.status !== "debrief") throw httpError(409, "this session is not in its debrief");
      await q("UPDATE expert_sessions SET status = 'mapping', mode = 'live', ended_at = COALESCE(ended_at, now()), updated_at = now() WHERE id = $1", [s.id]);
      const job = await enqueue(q, { orgId: s.org_id, kind: "build_work_map", key: `${s.id}:${phase}`, payload: { sessionId: s.id, phase }, maxAttempts: 3 });
      return { status: "mapping", jobId: job.id };
    });
  }

  async function buildJob({ sessionId, phase }, jobCtx) {
    const ctx = { orgId: jobCtx.orgId };
    const prep = await T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      const wf = await loadWorkflow(q, s.workflow_id);
      const obs = await q("SELECT seq, modality, text, captured_at, source FROM observations WHERE session_id = $1 AND deleted_at IS NULL AND NOT dropped ORDER BY seq", [s.id]);
      const dialogue = await q("SELECT question, answer FROM session_dialogue WHERE session_id = $1 ORDER BY seq", [s.id]);
      const [prev] = await q("SELECT * FROM work_maps WHERE session_id = $1", [s.id]);
      return { s, wf, obs, dialogue, prev };
    });
    if (prep.s.status === "terminated") return { skipped: "terminated" };
    const events = prep.obs.filter((o) => o.modality !== "MICROPHONE" && o.text).map((o) => ({ id: `e${o.seq}`, at: new Date(o.captured_at).toISOString(), modality: o.modality, text: o.text }));
    const speech = prep.obs.filter((o) => o.modality === "MICROPHONE" && o.text).map((o) => ({ at: new Date(o.captured_at).toISOString(), text: o.text }));
    const m = await withAiContext({ orgId: ctx.orgId, sessionId, workflowId: prep.wf.id }, () =>
      buildWorkMap({ wf: prep.wf, events, speech, dialogue: prep.dialogue, previous: prep.prev?.map ?? null, language: prep.s.language }));
    if (m.source === "fallback" && prep.prev) return { kept: true, error: m.error }; // never replace a real map with a fallback
    await T(ctx, async (q) => {
      const [space] = await q("SELECT experience FROM organizations WHERE id = app_org()");
      const map = { steps: m.steps };
      if (prep.prev) {
        await q("UPDATE work_maps SET map = $2, unclear = $3, title = $4, version = version + 1, status = $5, updated_at = now() WHERE id = $1",
          [prep.prev.id, JSON.stringify(map), JSON.stringify(m.unclear), m.title || prep.prev.title, phase === "debrief" ? "debriefed" : "draft"]);
      } else {
        await q(`INSERT INTO work_maps (org_id, session_id, workflow_id, expert_person_id, title, map, unclear, source_language, visibility)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [prep.s.org_id, prep.s.id, prep.wf.id, prep.s.expert_person_id, m.title || prep.wf.name, JSON.stringify(map), JSON.stringify(m.unclear), prep.s.language,
          space?.experience === "living" ? "private" : "organization"]);
      }
      // After capture: debrief next. After the debrief: the expert confirms (status stays 'debrief' until then).
      await q("UPDATE expert_sessions SET status = 'debrief', updated_at = now() WHERE id = $1", [prep.s.id]);
      await notifyPerson(q, { orgId: prep.s.org_id, personId: prep.s.expert_person_id, kind: "workmap.ready", title: phase === "debrief" ? "Your Work Map is updated: confirm it" : "Moti has a few questions about your task", link: `#/map/${prep.s.id}`, dedupeKey: `workmap:${prep.s.id}:${phase}` });
    });
    return { steps: m.steps.length, unclear: m.unclear.length, source: m.source };
  }

  // ---------------------------------------------------------------- reading and confirming
  // Access, the same everywhere (map page, lists, Learning, Ask, listening, practice):
  //   the expert who recorded it: always (drafts included); space owners, admins and coordinators: everything in the space;
  //   everyone else: a CONFIRMED map shared with the whole space, with one of their groups, or with them by name.
  const MANAGERS = ["ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR"];
  const isManager = (ctx) => Boolean(ctx.roles?.some((r) => MANAGERS.includes(r)));
  async function myGroups(q, ctx) {
    if (!ctx.personId) return [];
    return (await q("SELECT group_id FROM group_members WHERE person_id = $1 AND removed_at IS NULL", [ctx.personId])).map((r) => r.group_id);
  }
  async function readable(q, ctx, row, groups = null) {
    if (!row) return false;
    if (row.expert_person_id === ctx.personId || isManager(ctx)) return true;
    if (row.status !== "confirmed") return false;
    if (row.visibility === "organization") return true;
    if (row.visibility !== "named") return false;
    if ((row.shared_with ?? []).includes(ctx.personId)) return true;
    const mine = groups ?? (await myGroups(q, ctx));
    return (row.shared_groups ?? []).some((g) => mine.includes(g));
  }
  const accessOf = (ctx, row) => (row.expert_person_id === ctx.personId ? "owner" : isManager(ctx) ? "manager" : "shared");

  async function get(ctx, sessionId) {
    requirePermission(ctx, "workflow.read");
    if (!UUID.test(String(sessionId))) throw httpError(404, "work map not found");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      const [m] = await q("SELECT w.*, p.display_name AS expert_name FROM work_maps w JOIN people p ON p.id = w.expert_person_id WHERE w.session_id = $1", [s.id]);
      const mine = s.expert_person_id === ctx.personId;
      if (!m) { if (!mine) throw httpError(404, "work map not found"); return { sessionId: s.id, status: s.status, map: null, building: s.status === "mapping" }; }
      if (!(await readable(q, ctx, m))) throw httpError(404, "work map not found");
      const evIds = [...new Set(m.map.steps.flatMap((st) => st.eventIds))].map((e) => Number(e.slice(1))).filter(Number.isFinite);
      const frames = evIds.length ? await q(`SELECT seq, media_asset_id, captured_at, text FROM observations WHERE session_id = $1 AND seq = ANY($2::int[]) AND deleted_at IS NULL`, [s.id, evIds]) : [];
      const t0 = (await q("SELECT min(captured_at) AS t FROM observations WHERE session_id = $1", [s.id]))[0]?.t;
      const moment = (seq) => { const f = frames.find((x) => x.seq === seq); return f ? { mediaId: f.media_asset_id, offsetSec: t0 ? Math.max(0, Math.round((new Date(f.captured_at) - new Date(t0)) / 1000)) : null, text: f.text } : null; };
      return {
        id: m.id, sessionId: s.id, workflowId: m.workflow_id, title: m.title, status: m.status, version: m.version, expertName: m.expert_name, mine, sessionStatus: s.status,
        access: accessOf(ctx, m), canShare: mine || isManager(ctx), sharing: mine || isManager(ctx) ? await sharingOf(q, m) : null,
        language: m.source_language, unclear: mine ? m.unclear : [], visibility: m.visibility, confirmedAt: m.confirmed_at,
        steps: m.map.steps.map((st) => ({ ...st, moments: st.eventIds.map((e) => moment(Number(e.slice(1)))).filter(Boolean) })),
        counts: { steps: m.map.steps.length, judgments: m.map.steps.filter((x) => x.isJudgment).length, guardrails: m.map.steps.reduce((n, x) => n + x.guardrails.length, 0) },
        building: s.status === "mapping",
      };
    });
  }

  async function confirm(ctx, sessionId, { correction = "" } = {}) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      assertIsExpert(ctx, s);
      const [m] = await q("SELECT * FROM work_maps WHERE session_id = $1", [s.id]);
      if (!m) throw httpError(409, "the Work Map is not ready yet");
      if (s.status === "mapping") throw httpError(409, "the Work Map is still being updated");
      await q("UPDATE work_maps SET status = 'confirmed', confirmed_at = now(), teach_back = COALESCE(NULLIF($2, ''), teach_back), updated_at = now() WHERE id = $1", [m.id, String(correction).slice(0, 2000)]);
      await q("UPDATE expert_sessions SET status = 'mapped', updated_at = now() WHERE id = $1", [s.id]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workmap.confirm", targetType: "work_map", targetId: m.id, requestId: ctx.requestId, metadata: { version: m.version } });
      return { status: "confirmed" };
    });
  }

  async function sharingOf(q, m) {
    const people = m.shared_with?.length ? await q("SELECT id, display_name FROM people WHERE id = ANY($1::uuid[])", [m.shared_with]) : [];
    const groups = m.shared_groups?.length ? await q("SELECT id, name FROM groups WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [m.shared_groups]) : [];
    return { visibility: m.visibility, people: people.map((p) => ({ id: p.id, name: p.display_name })), groups: groups.map((g) => ({ id: g.id, name: g.name })), chosen: Boolean(m.sharing_chosen_at) };
  }

  /** Who should learn from this? Everyone in the space, chosen groups, chosen people, or only the expert. */
  async function setSharing(ctx, sessionId, { visibility, people = [], groups = [] } = {}) {
    requirePermission(ctx, "workflow.read");
    if (!["private", "named", "organization"].includes(visibility)) throw httpError(400, "choose who can see it");
    return T(ctx, async (q) => {
      const s = await loadSession(q, sessionId);
      const [m] = await q("SELECT w.*, p.display_name AS expert_name FROM work_maps w JOIN people p ON p.id = w.expert_person_id WHERE w.session_id = $1", [s.id]);
      if (!m || !(await readable(q, ctx, m))) throw httpError(404, "work map not found");
      if (m.expert_person_id !== ctx.personId && !isManager(ctx)) throw httpError(403, "only the expert who recorded it, or a space admin or coordinator, can share it");
      const ids = (xs) => [...new Set((Array.isArray(xs) ? xs : []).filter((x) => UUID.test(String(x))))].slice(0, 200);
      const validPeople = visibility === "named" ? (await q("SELECT id FROM people WHERE id = ANY($1::uuid[]) AND id <> $2", [ids(people), m.expert_person_id])).map((r) => r.id) : [];
      const validGroups = visibility === "named" ? (await q("SELECT id FROM groups WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [ids(groups)])).map((r) => r.id) : [];
      if (visibility === "named" && !validPeople.length && !validGroups.length) throw httpError(400, "choose at least one person or group");
      const before = new Set(m.visibility === "named" ? m.shared_with : []);
      await q("UPDATE work_maps SET visibility = $2, shared_with = $3, shared_groups = $4, sharing_chosen_at = now(), updated_at = now() WHERE id = $1", [m.id, visibility, validPeople, validGroups]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "workmap.sharing", targetType: "work_map", targetId: m.id, requestId: ctx.requestId, metadata: { from: m.visibility, to: visibility, people: validPeople.length, groups: validGroups.length } });
      if (m.status === "confirmed") for (const pid of validPeople.filter((x) => !before.has(x) && x !== ctx.personId)) {
        await notifyPerson(q, { orgId: ctx.orgId, personId: pid, kind: "workmap.shared", title: `${m.expert_name} shared a Work Map with you: ${m.title}`, link: `#/map/${s.id}`, dedupeKey: `wm-share:${m.id}:${pid}` });
      }
      return { visibility, people: validPeople.length, groups: validGroups.length };
    });
  }

  /** Confirmed maps in this space the person cannot open yet: titles only, so they can ask for access. */
  async function catalog(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const groups = await myGroups(q, ctx);
      const rows = await q(`SELECT w.id, w.session_id, w.title, w.status, w.visibility, w.shared_with, w.shared_groups, w.expert_person_id, p.display_name AS expert_name,
                                   EXISTS (SELECT 1 FROM access_requests r WHERE r.work_map_id = w.id AND r.requester_person_id = $1 AND r.status = 'pending') AS requested
                            FROM work_maps w JOIN people p ON p.id = w.expert_person_id JOIN workflows wf ON wf.id = w.workflow_id
                            WHERE w.status = 'confirmed' AND wf.deleted_at IS NULL ORDER BY w.confirmed_at DESC LIMIT 100`, [ctx.personId ?? null]);
      const out = [];
      for (const r of rows) if (!(await readable(q, ctx, r, groups))) out.push({ workMapId: r.id, title: r.title, expertName: r.expert_name, requested: r.requested });
      return out;
    });
  }

  /** Confirmed Work Maps this person may read, as Ask sources (the same access rule as everywhere else). */
  async function readableForAsk(ctx) {
    return T(ctx, async (q) => {
      const groups = await myGroups(q, ctx);
      const rows = await q(`SELECT w.id, w.session_id, w.title, w.version, w.map, w.status, w.visibility, w.shared_with, w.shared_groups, w.expert_person_id, p.display_name AS expert_name
                            FROM work_maps w JOIN people p ON p.id = w.expert_person_id JOIN workflows wf ON wf.id = w.workflow_id
                            WHERE w.status = 'confirmed' AND wf.deleted_at IS NULL ORDER BY w.confirmed_at DESC LIMIT 12`);
      const out = [];
      for (const r of rows) if (await readable(q, ctx, r, groups)) out.push(r);
      return out;
    });
  }

  async function list(ctx) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const groups = await myGroups(q, ctx);
      const rows = await q(`SELECT w.id, w.session_id, w.title, w.status, w.version, w.visibility, w.shared_with, w.shared_groups, w.expert_person_id, w.created_at, w.confirmed_at, p.display_name AS expert_name, wf.name AS workflow_name,
                                   jsonb_array_length(w.map->'steps') AS steps
                            FROM work_maps w JOIN people p ON p.id = w.expert_person_id JOIN workflows wf ON wf.id = w.workflow_id
                            WHERE w.status <> 'withdrawn' AND wf.deleted_at IS NULL ORDER BY w.created_at DESC LIMIT 100`);
      const out = [];
      for (const r of rows) if (await readable(q, ctx, r, groups)) out.push({ id: r.id, sessionId: r.session_id, title: r.title, status: r.status, version: r.version, steps: r.steps, expertName: r.expert_name, workflowName: r.workflow_name,
        mine: r.expert_person_id === ctx.personId, access: accessOf(ctx, r), visibility: r.visibility, createdAt: r.created_at, confirmedAt: r.confirmed_at });
      return out;
    });
  }

  /** Agent-ready guardrails: the confirmed steps and stop points as instructions an AI agent can load. */
  async function exportForAgents(ctx, sessionId) {
    const m = await get(ctx, sessionId);
    if (!m.steps || m.status !== "confirmed") throw httpError(409, "only a confirmed Work Map can be exported");
    const lines = [`# ${m.title}`, `Confirmed by ${m.expertName} (version ${m.version}). Follow these steps; stop where a guardrail says so and hand over to a person.`, ""];
    for (const [i, st] of m.steps.entries()) {
      lines.push(`## Step ${i + 1}: ${st.title}`, `- Do: ${st.action}`, `- Decision: ${st.decision}`);
      if (st.reason?.text) lines.push(`- Why: ${st.reason.text}${st.reason.quote ? ` (expert: "${st.reason.quoteEn || st.reason.quote}")` : " (AI-inferred, not confirmed by the expert)"}`);
      for (const g of st.guardrails) lines.push(`- ${g.kind === "stop_and_ask" ? "STOP AND ASK A PERSON" : g.kind === "never" ? "NEVER" : g.kind.toUpperCase()}: ${g.text}`);
      lines.push("");
    }
    return { markdown: lines.join("\n"), json: { title: m.title, version: m.version, steps: m.steps.map(({ moments, ...st }) => st) } };
  }

  // ---------------------------------------------------------------- tutoring
  async function startTutor(ctx, sessionId, { language = "en" } = {}) {
    requirePermission(ctx, "workflow.read");
    const m = await get(ctx, sessionId);
    if (m.status !== "confirmed") throw httpError(409, "the expert has not confirmed this Work Map yet");
    return T(ctx, async (q) => {
      const [r] = await q("INSERT INTO tutor_runs (org_id, work_map_id, learner_person_id, language) VALUES ($1,$2,$3,$4) RETURNING id", [ctx.orgId, m.id, ctx.personId, language]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "tutor.start", targetType: "work_map", targetId: m.id, requestId: ctx.requestId });
      return { runId: r.id, map: m };
    });
  }
  async function loadRun(q, ctx, runId) {
    if (!UUID.test(String(runId))) throw httpError(404, "tutor run not found");
    const [r] = await q("SELECT * FROM tutor_runs WHERE id = $1", [runId]);
    if (!r || r.learner_person_id !== ctx.personId) throw httpError(404, "tutor run not found");
    return r;
  }
  async function recordIntervention(ctx, runId, { stepId, guardrail, said }) {
    return T(ctx, async (q) => {
      const r = await loadRun(q, ctx, runId);
      const list = [...r.interventions, { at: new Date().toISOString(), stepId: String(stepId ?? "").slice(0, 20), guardrail: String(guardrail ?? "").slice(0, 300), said: redactText(String(said ?? "").slice(0, 600)).text }].slice(-50);
      await q("UPDATE tutor_runs SET interventions = $2 WHERE id = $1", [r.id, JSON.stringify(list)]);
      return { count: list.length };
    });
  }
  async function finishTutor(ctx, runId, { mastered = [], practise = [], summary = "" } = {}) {
    return T(ctx, async (q) => {
      const r = await loadRun(q, ctx, runId);
      const ids = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[,\s]+/)).map((x) => String(x).trim()).filter((x) => /^s\d{1,3}$/.test(x)).slice(0, 40);
      const result = { mastered: ids(mastered), practise: ids(practise), summary: String(summary).slice(0, 1200), note: "Practice in a live session; not a certification." };
      await q("UPDATE tutor_runs SET status = 'done', result = $2, ended_at = now() WHERE id = $1", [r.id, JSON.stringify(result)]);
      return { status: "done", result };
    });
  }
  async function getRun(ctx, runId) { return T(ctx, (q) => loadRun(q, ctx, runId)); }

  /**
   * Listen: the confirmed map as a short spoken lesson in a chosen language (script + Gemini TTS audio), cached per map
   * version and language so each narration is generated once. The script is the transcript (shown with the audio).
   */
  async function listen(ctx, sessionId, language = "en", { audio = false } = {}) {
    if (!LISTEN_LANGUAGES[language]) throw httpError(400, "unsupported language");
    const m = await get(ctx, sessionId);
    if (m.status !== "confirmed" && !m.mine) throw httpError(404, "work map not found");
    if (!m.steps?.length) throw httpError(409, "this Work Map has no steps yet");
    const base = objectKey(ctx.orgId, "narration", `${m.id}-v${m.version}-${language}`);
    let meta = await storage.get(`${base}.json`).then((b) => (b ? JSON.parse(b.toString("utf8")) : null)).catch(() => null);
    if (!meta) {
      const script = await withAiContext({ orgId: ctx.orgId, sessionId }, () => narrateWorkMap({ map: m, expertName: m.expertName, title: m.title, language }));
      if (!script) throw httpError(503, "the narration could not be written right now; try again");
      const wav = await withAiContext({ orgId: ctx.orgId, sessionId }, () => tts(script, undefined, { timeoutMs: 120000, style: "Read this lesson aloud clearly and warmly, at a calm teaching pace:" }));
      if (wav) await storage.put(`${base}.wav`, wav, { contentType: "audio/wav" });
      meta = { language, script, audio: Boolean(wav), version: m.version, createdAt: new Date().toISOString() };
      await storage.put(`${base}.json`, Buffer.from(JSON.stringify(meta)), { contentType: "application/json" });
    }
    if (audio) { const wav = meta.audio ? await storage.get(`${base}.wav`) : null; if (!wav) throw httpError(404, "no audio for this narration"); return wav; }
    return { ...meta, languageName: LISTEN_LANGUAGES[language], reviewed: LISTEN_REVIEWED.has(language), audioUrl: meta.audio ? `/api/maps/${sessionId}/listen/audio?language=${language}` : null };
  }

  return { liveTurn, markLive, listen, setSharing, catalog, readableForAsk, setOffRecord, finishPhase, get, confirm, list, exportForAgents, startTutor, recordIntervention, finishTutor, getRun, handlers: { build_work_map: buildJob } };
}
