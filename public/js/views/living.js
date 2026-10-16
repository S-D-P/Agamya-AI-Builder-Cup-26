// AGAMYA FOR LIVING KNOWLEDGE: home, the featured journey, skills, sharing & permissions.
// Same engine as Agamya for Work; different defaults (private), words (teacher / learner / skill) and pace.
// The journey page shows the state of real objects (session, judgment, artifact, attempts); nothing is pre-filled.
import { askToShareBlock } from "./access.js";
import { state, api, esc, render, act, go, draft, has, ago, toast, setWorkflow } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";

let journey = null, mine = null, people = null, detailCache = {}, startFor = null;
const start = { source: null, caseRef: null };
const editing = {};

export function invalidateLiving() { journey = null; mine = null; detailCache = {}; }
const loadJourney = () => api("GET", "/api/journey").then((j) => { journey = j; render(); }).catch(() => { journey = { none: true }; render(); });
const loadMine = () => api("GET", "/api/knowledge/mine").then((m) => { mine = m; render(); }).catch((e) => { mine = { mine: [], sharedWithMe: [] }; toast(e.message, true); });
let peopleLoading = false;
const loadPeople = () => { if (peopleLoading) return; peopleLoading = true; api("GET", "/api/people").then((p) => { people = p; }).catch(() => { people = []; }).finally(() => { peopleLoading = false; render(); }); };

const VIS = { private: ["Only the contributor", "eyeoff"], named: ["Named people", "users"], organization: ["Everyone in this space", "share"] };
export const visTag = (v, n = 0) => v ? `<span class="tag ${v === "private" ? "" : v === "named" ? "sky" : "green"}">${icon(VIS[v][1], 12)} ${VIS[v][0]}${v === "named" && n ? ` (${n})` : ""}</span>` : "";

// ---------------------------------------------------------------- home
export function livingHomeView() {
  if (!journey) loadJourney();
  if (!mine) loadMine();
  const teacher = has("EXPERT");
  const j = journey && !journey.none ? journey : null;
  return `<section class="living-hero">
      <div><div class="eyebrow">${esc(state.me.org?.name)}</div><h1>${teacher ? `Welcome, ${esc(state.me.user.displayName)}.` : `Hello, ${esc(state.me.user.displayName)}.`}</h1>
        <p class="lede">${teacher ? "Show a skill the way you normally do it. Agamya watches quietly, asks about the choices that matter, and keeps your reasons with your technique. Nothing is shared until you decide." : "Here you can learn what has been shared with you, in situations you haven't seen before."}</p></div>
      ${orb(teacher ? "observing" : "teaching", 110)}
    </section>
    ${j ? journeyCard(j) : ""}
    <div class="grid cols-2" style="margin-top:18px">
      <section class="card pad stack"><div class="row between"><h2>${teacher ? "Knowledge you've preserved" : "Shared with you"}</h2>${teacher ? `<a class="btn sm" href="#/capture">${icon("capture", 14)} Capture a skill</a>` : ""}</div>
        ${!mine ? `<span class="thinking">Loading</span>` : knowledgeList(teacher ? mine.mine : mine.sharedWithMe, teacher)}</section>
      <section class="card pad stack"><h2>${teacher ? "Shared with you" : "Learning"}</h2>
        ${teacher ? (!mine ? "" : knowledgeList(mine.sharedWithMe, false)) : `<p class="small muted">Lessons come from knowledge a teacher has shared with you.</p><a class="btn" href="#/learn">${icon("learn", 15)} Open my lessons</a>`}</section>
    </div>`;
}

function knowledgeList(rows, mineList) {
  if (!rows.length) return mineList ? `<p class="small muted">Nothing yet. Capture a skill to begin.</p>` : `<p class="small muted">Nothing has been shared with you yet.</p>${askToShareBlock()}`;
  return `<div class="klist">${rows.map((k) => `<a class="card kitem" href="#/knowledge/${k.id}"><b>${esc(k.title)}</b><span class="small muted">${esc(k.workflowName)} · ${esc(k.expertName)} · ${ago(k.createdAt)}</span>
    <span class="row">${k.status === "observed" ? '<span class="tag amber">waiting for your review</span>' : k.withdrawn ? '<span class="tag">withdrawn</span>' : visTag(k.visibility, k.sharedCount)}${k.restricted ? '<span class="tag amber">restricted</span>' : ""}</span></a>`).join("")}</div>`;
}

function journeyCard(j) {
  const steps = journeySteps(j);
  const done = steps.filter((s) => s.state === "done").length;
  return `<section class="card pad journey-card"><div class="row between"><div><div class="eyebrow">Featured journey · ${done}/${steps.length} steps</div><h2>Amma teaches Meera to make ghee</h2>
      <p class="small muted">A recipe card says "simmer 20 minutes". Lakshmi has never used a timer. What does she watch for, and when would doing the same thing be wrong?</p></div>
      <a class="btn primary" href="#/journey">${done ? "Continue" : "Begin"} ${icon("arrow", 15)}</a></div>
    <div class="journey-dots" aria-hidden="true">${steps.map((s) => `<i class="${s.state}"></i>`).join("")}</div></section>`;
}

// ---------------------------------------------------------------- the featured journey
function journeySteps(j) {
  const s = j.session, js = j.judgment, a = j.artifact;
  const at = (kind) => j.attempts.filter((x) => x.kind === kind && x.status === "complete").at(-1);
  const apply = at("apply"), cf = at("counterfactual");
  const sess = s?.status;
  const cookState = !s ? "now" : ["awaiting_consent", "capturing"].includes(sess) ? "now" : "done";
  const askState = !s || cookState === "now" ? "todo" : ["processing", "analyzing", "asking", "extracting"].includes(sess) ? "now" : sess === "no_judgment" ? "skipped" : "done";
  const approveState = !js ? (askState === "done" ? "now" : "todo") : js.status === "approved" ? "done" : "now";
  const shareState = !a ? "todo" : a.sharedWithLearner ? "done" : "now";
  const learnState = !a?.sharedWithLearner ? "todo" : apply && cf ? "done" : "now";
  return [
    { key: "problem", title: "The problem a recording can't solve", who: null, state: "done" },
    { key: "cook", title: "Lakshmi makes ghee while Agamya watches", who: "teacher", state: cookState },
    { key: "ask", title: "Agamya notices a choice and asks why", who: "teacher", state: askState },
    { key: "approve", title: "Lakshmi corrects or approves what Agamya understood", who: "teacher", state: approveState },
    { key: "share", title: "Lakshmi decides who may learn from it", who: "teacher", state: shareState },
    { key: "learn", title: "Meera meets a new case, then a counterexample", who: "learner", state: learnState },
    { key: "result", title: "What transferred, and what didn't", who: null, state: learnState === "done" ? "done" : "todo" },
  ];
}

export function journeyView() {
  if (!journey) { loadJourney(); return `<span class="thinking">Loading the journey</span>`; }
  if (journey.none) return `<div class="card empty">${orb("observing", 80)}<p>This space has no featured journey. Start from <a href="#/capture">Capture a skill</a>.</p></div>`;
  const j = journey, steps = journeySteps(j), viewer = j.viewer;
  const T = j.teacher?.name ?? "the teacher", Lname = j.learner?.name ?? "the learner";
  const body = {
    problem: `<p>You could film Lakshmi making ghee. The film would show her turning off the flame at about 12 minutes, though the family recipe card says 20. It would not tell you <b>why</b>, <b>what she was looking at</b>, or <b>when doing exactly the same would ruin the ghee</b>. That is the knowledge that disappears.</p>`,
    cook: !j.session ? (viewer === "teacher" ? `<p class="small muted">The kitchen camera is simulated: rendered frames go through the same capture, storage and analysis path as a real camera. You will be asked for consent first.</p><button class="primary" data-act="start-journey" ${state.busy ? "disabled" : ""}>${icon("capture", 15)} Start the kitchen session</button>` : switchHint("teacher", j))
      : viewer === "teacher" ? `<a class="btn" href="#/session/${j.session.id}">${icon("capture", 15)} ${steps[1].state === "now" ? "Continue the session" : "Open the session"}</a>` : `<p class="small muted">Captured with ${esc(T)}'s consent. Raw recordings stay with her.</p>`,
    ask: j.session && ["asking"].includes(j.session.status) ? (viewer === "teacher" ? `<a class="btn primary" href="#/session/${j.session.id}">Answer Agamya's question</a>` : switchHint("teacher", j)) : j.session?.status === "no_judgment" ? `<p class="small">Agamya found nothing to ask: what was done matched the recipe card. <button class="sm" data-act="start-journey">Try again</button></p>` : `<p class="small muted">Agamya waits for a natural pause, then asks one short question tied to what it saw.</p>`,
    approve: j.judgment && j.judgment.status === "observed" ? (viewer === "teacher" ? `<a class="btn primary" href="#/session/${j.session.id}">Review what Agamya understood</a>` : switchHint("teacher", j)) : j.judgment?.status === "approved" ? `<a class="btn" href="#/knowledge/${j.judgment.id}">${icon("knowledge", 15)} Open the preserved knowledge</a>` : `<p class="small muted">Nothing becomes knowledge until ${esc(T)} approves it. She can correct any part.</p>`,
    share: !j.artifact ? `<p class="small muted">Saving is not sharing. Approved knowledge starts private.</p>` : j.artifact.sharedWithLearner ? `<p class="small">${icon("check", 14)} Shared with ${esc(Lname)}. ${esc(T)} can change or withdraw this at any time in <a href="#/sharing">Sharing &amp; permissions</a>.</p>`
      : viewer === "teacher" ? `<p class="small muted">It is private: only ${esc(T)} can see it. Public publication and AI training are not offered.</p><button class="primary" data-act="share-learner" ${state.busy ? "disabled" : ""}>${icon("share", 15)} Share with ${esc(Lname)} only</button>` : switchHint("teacher", j),
    learn: !j.artifact?.sharedWithLearner ? `<p class="small muted">Available once ${esc(T)} shares it.</p>` : viewer === "learner" ? `<a class="btn primary" href="#/learn">${icon("learn", 15)} Start my lesson</a>` : `<p class="small muted">Now see it from ${esc(Lname)}'s side. She has not seen the recording or the answer.</p><button class="primary" data-act="become" data-person="${j.learner?.id}">Continue as ${esc(Lname)}</button>`,
    result: resultBlock(j),
  };
  return `<div class="page-head"><div><div class="eyebrow">Featured journey</div><h1>Amma teaches Meera to make ghee</h1><p>Every step below reflects the real state of this sample space: the session, the knowledge, and Meera's answers.</p></div>
      ${orb(steps.find((s) => s.state === "now")?.who === "learner" ? "teaching" : "observing", 76)}</div>
    <ol class="journey">${steps.map((s, i) => `<li class="jstep ${s.state}"><span class="jn" aria-hidden="true">${s.state === "done" ? icon("check", 14) : i + 1}</span>
      <div><div class="row between"><h2 class="h3">${esc(s.title)}</h2>${s.who ? `<span class="tag ${s.who === "teacher" ? "green" : "pink"}">${s.who === "teacher" ? esc(T) : esc(Lname)}</span>` : ""}</div>
        ${s.state === "todo" && !["problem"].includes(s.key) ? "" : `<div class="jbody">${body[s.key]}</div>`}</div></li>`).join("")}</ol>`;
}

function switchHint(role, j) {
  const p = role === "teacher" ? j.teacher : j.learner;
  return `<p class="small muted">This step is ${esc(p?.name)}'s.</p><button data-act="become" data-person="${p?.id}">Continue as ${esc(p?.name)}</button>`;
}

function resultBlock(j) {
  const at = (kind) => j.attempts.filter((x) => x.kind === kind && x.status === "complete").at(-1)?.result;
  const a = at("apply"), c = at("counterfactual");
  if (!a && !c) return `<p class="small muted">Shows whether ${esc(j.learner?.name)} applied the judgment, and whether she knew when not to.</p>`;
  const line = (label, ok, text) => `<div class="row"><span class="tag ${ok ? "green" : "red"}">${ok ? "✓" : "✗"} ${label}</span><span class="small">${text}</span></div>`;
  return `<div class="stack">
    ${a ? line("New case", a.finalCorrect, a.initialCorrect ? "Reached Amma's decision on the first try." : a.finalCorrect ? `Reached it after ${a.interventions.length} hint(s).` : "Did not reach it.") : ""}
    ${c ? line("Counterexample", c.initialCorrect, c.initialCorrect ? "Recognised that Amma's early stop does not apply to store-bought butter." : `${c.overgeneralized ? "Overgeneralized at first: stopped at the same minute although the signals said otherwise." : "Missed the boundary at first."}${c.finalCorrect ? ` Recognised the signals after ${c.interventions.length} hint(s).` : ""}`) : ""}
    <p class="honest">These are simulated cases with designer-written answers (ground truth: synthetic). They show understanding, not proven skill at the stove.</p>
    ${j.judgment ? `<a class="btn" href="#/knowledge/${j.judgment.id}">${icon("knowledge", 15)} See the preserved knowledge</a>` : ""}</div>`;
}

// ---------------------------------------------------------------- skills (capture)
const SRC_LABEL = { "live:camera": "Live camera", "live:screen": "Live screen", manual: "Narrate or type the steps" };
export function skillsView() {
  if (!people && has("ORG_ADMIN", "WORKFLOW_OWNER")) loadPeople();
  const teacher = has("EXPERT");
  return `<div class="page-head"><div><h1>Capture a skill</h1><p>Show it the way you normally would. Agamya stays quiet while you work and asks only about choices that matter.</p></div></div>
    <div class="skill-grid">${state.workflows.map((w) => `<article class="card pad stack skill">
      <div class="row between"><h2>${esc(w.name)}</h2><span class="row">${w.source === "demo" ? '<span class="tag sky">sample</span>' : ""}${has("ORG_ADMIN", "WORKFLOW_OWNER", "KT_COORDINATOR") ? `<button class="ghost sm danger" data-act="delete-skill" data-id="${w.id}" data-name="${esc(w.name)}">Delete</button>` : ""}</span></div>
      <p class="small muted">${esc(w.description)}</p>
      <div class="row small">${["camera", "microphone", "documents"].filter((k) => w.modalities?.[k]).map((k) => `<span class="mod">${icon(k === "microphone" ? "mic" : k === "documents" ? "doc" : "camera", 12)} ${k === "documents" ? "written recipe" : k}</span>`).join("")}</div>
      ${teacher ? (startFor?.id === w.id ? startForm(startFor) : `<div><button class="primary" data-act="pick-skill" data-id="${w.id}">${icon("capture", 15)} Start a session</button></div>`) : ""}
    </article>`).join("") || `<div class="card empty">${orb("observing", 72)}<p>No skills yet.</p></div>`}</div>
    ${has("ORG_ADMIN", "WORKFLOW_OWNER") ? newSkillForm() : ""}`;
}

function startForm(w) {
  const srcs = w.capture_sources.concat(w.capture_sources.includes("manual") ? [] : ["manual"]);
  start.source = srcs.includes(start.source) ? start.source : srcs[0];
  const sim = w.simSources.find((x) => x.id === start.source);
  if (sim && !sim.cases.some((c) => c.id === start.caseRef)) start.caseRef = sim.cases[0].id;
  return `<div class="stack"><label class="field">Observe through<select id="lv-source">${srcs.map((s) => `<option value="${s}" ${s === start.source ? "selected" : ""}>${esc(w.simSources.find((x) => x.id === s)?.label ?? SRC_LABEL[s] ?? s)}</option>`).join("")}</select></label>
    ${sim ? `<label class="field">Situation<select id="lv-case">${sim.cases.map((c) => `<option value="${c.id}" ${c.id === start.caseRef ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select></label><p class="small muted">Simulated feed: rendered frames that go through the same path as a real camera.</p>` : ""}
    <div class="row"><button class="primary" data-act="start-skill" data-id="${w.id}" ${state.busy ? "disabled" : ""}>Begin</button><button class="ghost" data-act="cancel-skill">Cancel</button></div></div>`;
}

const form = { learners: new Set(), camera: true, microphone: true };
function newSkillForm() {
  const learners = (people ?? []).filter((p) => p.roles.includes("LEARNER"));
  return `<section class="card pad stack" style="max-width:820px;margin-top:22px"><h2>Add a skill</h2>
    <div class="grid cols-2"><label class="field">Name<input data-draft="sk-name" placeholder="Rolling soft rotis"></label>
      <label class="field">In a sentence<input data-draft="sk-desc" placeholder="How Nani knows the dough is ready"></label></div>
    <div><div class="eyebrow" style="margin-bottom:6px">What may Agamya observe?</div><div class="row">
      <button class="chip" aria-pressed="${form.camera}" data-act="sk-input" data-k="camera">${icon("camera", 14)} Camera</button><button class="chip" aria-pressed="${form.microphone}" data-act="sk-input" data-k="microphone">${icon("mic", 14)} Voice</button></div></div>
    <label class="field">Written recipe or instructions <span class="faint">(optional; much of this knowledge is never written down)</span><textarea data-draft="sk-doc" rows="3"></textarea></label>
    ${learners.length ? `<div><div class="eyebrow" style="margin-bottom:6px">Who will learn it?</div><div class="row">${learners.map((p) => `<button class="chip" aria-pressed="${form.learners.has(p.id)}" data-act="sk-learner" data-id="${p.id}">${esc(p.display_name)}</button>`).join("")}</div></div>` : `<p class="small muted">Invite learners from <a href="#/people">People</a>.</p>`}
    <p class="small muted">Adding learners does not share anything with them. You decide that per piece of knowledge, after you approve it.</p>
    <div><button class="primary" data-act="sk-create" ${state.busy ? "disabled" : ""}>${icon("plus", 15)} Add skill</button></div></section>`;
}

// ---------------------------------------------------------------- sharing & permissions
export function sharingView() {
  if (!mine) { loadMine(); return `<span class="thinking">Loading</span>`; }
  if (!people) loadPeople();
  const rows = mine.mine.filter((k) => k.artifactId);
  const perms = [
    ["capture", "Recording and analysis", "Asked every time capture starts, per input (camera, voice). You can pause, exclude an input or delete any moment.", "Asked each session"],
    ["validate", "Saving as knowledge", "Only what you approve is saved. You can correct anything Agamya understood first.", "Only on your approval"],
    ["users", "Sharing", "Per piece of knowledge: only you, people you name, or everyone in this space. Restricted knowledge can only go to named people.", "Your choice, below"],
    ["eyeoff", "Public publication", "Agamya has no public pages. Nothing you preserve is published.", "Not offered"],
    ["shield", "Use to train AI models", "Agamya does not use your knowledge for model training. It is sent to Gemini on Vertex AI only to process your own sessions and lessons.", "Not offered"],
  ];
  return `<div class="page-head"><div><h1>Sharing &amp; permissions</h1><p>Consent to record is not consent to share. Each permission below is separate, and the person who contributed the knowledge holds it.</p></div></div>
    <section class="card pad"><ul class="perm-list">${perms.map(([i, t, d, v]) => `<li><span class="perm-ico">${icon(i, 17)}</span><div><b>${t}</b><span class="small muted">${d}</span></div><span class="tag ${v === "Not offered" ? "" : "green"}">${v}</span></li>`).join("")}</ul></section>
    <h2 style="margin:22px 0 10px">Your knowledge</h2>
    ${rows.length ? `<div class="stack">${rows.map(shareRow).join("")}</div>` : `<div class="card empty"><p>Nothing approved yet.</p></div>`}`;
}

function shareRow(k) {
  const d = detailCache[k.artifactId];
  const e = editing[k.artifactId];
  const others = (people ?? []).filter((p) => p.id !== state.me.personId);
  return `<article class="card pad share-row"><div class="row between"><div><b>${esc(k.title)}</b><div class="small muted">${esc(k.workflowName)} · ${ago(k.createdAt)}</div></div>
      <div class="row">${k.withdrawn ? '<span class="tag">withdrawn</span>' : visTag(k.visibility, k.sharedCount)}${k.restricted ? '<span class="tag amber">restricted</span>' : ""}
      ${k.withdrawn ? "" : `<button class="sm" data-act="share-edit" data-id="${k.artifactId}" aria-expanded="${Boolean(e)}">${e ? "Close" : "Change"}</button>`}<a class="btn sm ghost" href="#/knowledge/${k.id}">Open</a></div></div>
    ${e ? `<div class="stack" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
      <div class="seg" role="group" aria-label="Who can see this">${Object.entries(VIS).map(([v, [l]]) => `<button aria-pressed="${e.visibility === v}" data-act="share-vis" data-id="${k.artifactId}" data-v="${v}" ${e.restricted && v === "organization" ? "disabled title=\"Restricted knowledge can only go to named people\"" : ""}>${l}</button>`).join("")}</div>
      ${e.visibility === "named" ? `<div class="row">${others.map((p) => `<button class="chip" aria-pressed="${e.named.has(p.id)}" data-act="share-person" data-id="${k.artifactId}" data-p="${p.id}">${esc(p.display_name)}</button>`).join("") || '<span class="small muted">No one else in this space yet.</span>'}</div>` : ""}
      <label class="check"><input type="checkbox" data-share-restricted="${k.artifactId}" ${e.restricted ? "checked" : ""}> Restricted: sensitive or not to be shared beyond the people I name</label>
      ${e.restricted ? `<label class="field">Note for learners<input data-draft="rn-${k.artifactId}" placeholder="Family only. Please don't share outside."></label>` : ""}
      <div class="row"><button class="primary sm" data-act="share-save" data-id="${k.artifactId}" ${state.busy ? "disabled" : ""}>Save</button>
        <button class="sm danger" data-act="withdraw" data-id="${k.artifactId}">Withdraw this knowledge</button><span class="small muted">Withdrawing removes it from lessons and deletes its evidence media.</span></div></div>` : ""}
  </article>`;
}

// ---------------------------------------------------------------- events
export async function livingClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "start-journey") return act("start", async () => { const s = await api("POST", "/api/sessions", { workflowId: journey.workflow.id, source: "sim:kitchen-camera", caseRef: "K1" }); setWorkflow(journey.workflow.id); go(`#/session/${s.id}`); });
  if (a === "share-learner") return act("share", async () => { const l = journey.learner; await api("POST", `/api/knowledge/${journey.artifact.id}/sharing`, { visibility: "named", sharedWith: [l.id] }); journey = null; toast(`Shared with ${l.name} only.`); });
  if (a === "become") return act("switch", async () => { await api("POST", "/api/samples/switch", { personId: t.dataset.person }); location.hash = "#/journey"; location.reload(); });
  if (a === "pick-skill") return act("skill", async () => { startFor = await api("GET", `/api/workflows/${t.dataset.id}`); start.source = null; start.caseRef = null; });
  if (a === "cancel-skill") { startFor = null; return render(); }
  if (a === "start-skill") return act("start", async () => { setWorkflow(t.dataset.id); const s = await api("POST", "/api/sessions", { workflowId: t.dataset.id, source: start.source, caseRef: start.caseRef }); startFor = null; go(`#/session/${s.id}`); });
  if (a === "sk-input") { form[t.dataset.k] = !form[t.dataset.k]; return render(); }
  if (a === "sk-learner") { form.learners.has(t.dataset.id) ? form.learners.delete(t.dataset.id) : form.learners.add(t.dataset.id); return render(); }
  if (a === "sk-create") {
    if (!draft("sk-name")) return toast("Give the skill a name.", true);
    const doc = draft("sk-doc");
    return act("create", async () => {
      const w = await api("POST", "/api/workflows", { name: draft("sk-name"), description: draft("sk-desc"), kind: "physical", modalities: { camera: form.camera, microphone: form.microphone, documents: Boolean(doc), screen: false, app_events: false },
        captureSources: [form.camera ? "live:camera" : null, "manual"].filter(Boolean), documents: doc ? [{ title: "Written instructions", text: doc }] : [], learnerPersonIds: [...form.learners] });
      state.workflows = await api("GET", "/api/workflows"); setWorkflow(w.id); ["sk-name", "sk-desc", "sk-doc"].forEach((k) => (state.drafts[k] = "")); form.learners.clear();
      toast("Skill added. Start a session when you're ready.");
    });
  }
  if (a === "share-edit") {
    const id = t.dataset.id;
    if (editing[id]) { delete editing[id]; return render(); }
    const k = mine.mine.find((x) => x.artifactId === id);
    const d = detailCache[id] ?? (detailCache[id] = await api("GET", `/api/judgments/${k.id}`));
    editing[id] = { visibility: d.artifact.governance.visibility, named: new Set(d.artifact.governance.sharedWith.map((p) => p.id)), restricted: d.artifact.governance.restricted };
    state.drafts[`rn-${id}`] = d.artifact.governance.restrictionNote ?? "";
    return render();
  }
  if (a === "share-vis") { editing[t.dataset.id].visibility = t.dataset.v; return render(); }
  if (a === "share-person") { const s = editing[t.dataset.id].named; s.has(t.dataset.p) ? s.delete(t.dataset.p) : s.add(t.dataset.p); return render(); }
  if (a === "share-save") {
    const id = t.dataset.id, e2 = editing[id];
    return act("share", async () => {
      await api("POST", `/api/knowledge/${id}/sharing`, { visibility: e2.visibility, sharedWith: e2.visibility === "named" ? [...e2.named] : [], restricted: e2.restricted, restrictionNote: draft(`rn-${id}`) });
      delete editing[id]; delete detailCache[id]; mine = null; toast("Sharing updated.");
    });
  }
  if (a === "withdraw") {
    if (!confirm("Withdraw this knowledge? It is removed from everyone's lessons and its evidence media is deleted. This cannot be undone.")) return;
    return act("withdraw", async () => { await api("POST", `/api/knowledge/${t.dataset.id}/withdraw`); delete editing[t.dataset.id]; mine = null; toast("Withdrawn."); });
  }
}

export function livingChange(e) {
  const t = e.target;
  if (t.id === "lv-source") { start.source = t.value; start.caseRef = null; return render(); }
  if (t.id === "lv-case") { start.caseRef = t.value; return; }
  if (t.dataset.shareRestricted) { const ed = editing[t.dataset.shareRestricted]; ed.restricted = t.checked; if (t.checked && ed.visibility === "organization") ed.visibility = "named"; return render(); }
}
