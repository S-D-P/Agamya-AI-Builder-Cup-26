// KT MISSIONS: list → guided creation (identity, template, brief, review) → overview with a derived lifecycle stage.
// The mission orchestrates capture, the Missing Knowledge Detective, the Judgment Stress Test and assessments; nothing
// here decides access (the server does) and nothing marks success that the records do not show.
import { requestButton } from "./access.js";
import { state, api, esc, render, act, draft, toast, go, ago } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { t, langSelect, langAttr, scriptLang } from "../i18n.js";
import { announce } from "../a11y.js";

const loading = Symbol("loading");
let list = null, current = null, review = null, templates = null, people = null, groups = null, wfDetail = null;
let wiz = null; // { step, missionId, form }

// People and groups change elsewhere (Groups, People): reload them whenever missions are entered again.
export function invalidateMissions() { list = null; current = null; review = null; wfDetail = null; people = null; groups = null; }

const STAGES = [["draft", "Draft"], ["awaiting_participants", "Awaiting participants"], ["ready_to_capture", "Ready to capture"], ["capturing", "Capturing"], ["knowledge_review", "Knowledge review"], ["transfer_assessment", "Transfer assessment"], ["completed", "Completed"]];
const OTHER = { paused: "Paused", blocked: "Blocked", cancelled: "Cancelled", completed_with_exceptions: "Completed with recorded exceptions" };
const stageLabel = (s) => STAGES.find(([k]) => k === s)?.[1] ?? OTHER[s] ?? s;
const REQ = { satisfied: ["Satisfied", "green", "validate"], partial: ["Partially satisfied", "amber", "clock"], unresolved: ["Unresolved", "", "question"], not_applicable: ["Not applicable", "", "eyeoff"] };
const BASIS = { AI_VERIFIED: "checked by AI against a verified quote", AI_INFERRED: "AI suggestion, not verified", PERSON: "decided by a person", NONE: "not checked yet" };
const KIND = { outcome: "Expected outcome", decision: "Decision to demonstrate", blind_spot: "Blind spot / exception", question: "Question for the expert", acceptance: "Acceptance criterion" };
const RESULT = { demonstrated_in_simulation: ["Demonstrated in simulation", "green"], needs_supervision: ["Requires supervision", "red"], in_progress: ["Needs further practice", "amber"], not_started: ["Not assessed yet", ""] };
const LISTS = [["objectives", "Objectives"], ["outcomes", "Expected learning outcomes"], ["decisions", "Decisions or skills the receiver must demonstrate"], ["blindSpots", "Known blind spots, exceptions, edge cases, past failures"], ["questions", "Questions the expert should address"], ["acceptance", "Acceptance criteria"], ["constraints", "Safety, confidentiality, regulatory or operational constraints"]];
const TEXTS = [["scope", "Scope"], ["outOfScope", "Out of scope"], ["sops", "Existing instructions, documentation or SOPs (summary or references)"], ["captureNotes", "Preferred capture methods (notes)"], ["languageNotes", "Language preferences"], ["retentionNotes", "Retention and sharing requirements (within organization policy)"]];
const METHOD_HELP = { audio: "Narration or conversation. Microphone only.", audio_video: "Camera frames when something changes, plus voice.", screen: "Screen frames when something changes, plus narration.", text: "Typed steps, documents and manual observations. Always available." };

// ---------------------------------------------------------------- list
export function missionsView(r) {
  if (r.id === "new") return wizardView();
  if (r.id && r.sub === "review") return reviewView(r.id);
  if (r.id) return overviewView(r.id);
  if (!list) { api("GET", "/api/missions").then((x) => { list = x; render(); }).catch((e) => toast(e.message, true)); return `<span class="thinking">Loading missions</span>`; }
  return `<div class="page-head"><div><div class="eyebrow">Knowledge transfer</div><h1>${t("KT missions")}</h1><p>A mission coordinates one knowledge transfer: who holds the expertise, who must receive it, what they must be able to do, and the evidence that they can.</p></div>
    ${list.canCreate ? `<a class="btn primary" href="#/missions/new">${icon("plus", 15)} New mission</a>` : ""}</div>
  ${list.missions.length ? `<div class="table-wrap card" role="region" aria-label="Missions" tabindex="0"><table class="t"><caption class="sr-only">Missions you can see</caption><thead><tr><th scope="col">Mission</th><th scope="col">Status</th><th scope="col">Expert(s)</th><th scope="col">Receivers</th><th scope="col">Due</th><th scope="col">Your part</th></tr></thead><tbody>
    ${list.missions.map((m) => `<tr><th scope="row"><a href="#/missions/${m.id}"${langAttr(scriptLang(m.name))}>${esc(m.name)}</a><div class="small muted">${esc(m.template.replace(/_/g, " "))}${m.domain ? ` · ${esc(m.domain)}` : ""}</div></th>
      <td><span class="tag">${esc(m.status === "active" ? "In progress" : stageLabel(m.status))}</span></td><td>${esc(m.experts || "—")}</td><td>${m.receivers}</td><td>${m.targetDate ? esc(String(m.targetDate).slice(0, 10)) : "—"}</td><td>${esc(m.myRole ?? "viewer")}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="card empty">${orb("curious", 80)}<p>No missions yet.</p>${list.canCreate ? `<a class="btn primary" href="#/missions/new">Plan the first one</a>` : ""}</div>`}`;
}

// ---------------------------------------------------------------- wizard
function blankForm() {
  return { name: "", description: "", businessContext: "", domain: "", targetDate: "", language: state.me?.user?.language === "mr" ? "mr" : "en", experts: [], receivers: [], receiverGroups: [], templateKey: "general", templateId: null, captureMethods: null,
    brief: Object.fromEntries([...LISTS.map(([k]) => [k, ""]), ...TEXTS.map(([k]) => [k, ""])]) };
}
function loadWizardData() {
  // Fetch once (a placeholder stops re-renders from refetching); on failure show an empty list instead of loading forever.
  if (!templates) { templates = loading; api("GET", "/api/templates").then((x) => { templates = x; render(); }).catch((e) => { templates = { builtIn: [], organization: [], captureMethods: {}, canSave: false }; toast(e.message, true); render(); }); }
  if (!people) { people = loading; api("GET", "/api/people").then((x) => { people = x; render(); }).catch(() => { people = []; render(); }); }
  if (!groups) api("GET", "/api/groups").then((x) => { groups = x.groups; render(); }).catch(() => { groups = []; render(); });
}
function tplOf(f) { return f.templateId ? templates.organization.find((x) => x.id === f.templateId) : templates.builtIn.find((x) => x.key === f.templateKey); }

function wizardView() {
  if (!wiz) wiz = { step: 1, missionId: null, form: blankForm(), suggested: null, flags: [] };
  loadWizardData();
  if (!templates || !people || !groups || templates === loading || people === loading) return `<span class="thinking">Loading</span>`;
  const steps = ["Mission identity", "Template", "Mission brief", "Review and invite"];
  return `<div class="page-head"><div><div class="eyebrow">New KT mission</div><h1>${esc(steps[wiz.step - 1])}</h1></div><a class="btn ghost" href="#/missions">Cancel</a></div>
    <ol class="wizard-steps" aria-label="Steps">${steps.map((s, i) => `<li ${i + 1 === wiz.step ? 'aria-current="step"' : ""} class="${i + 1 < wiz.step ? "done" : i + 1 === wiz.step ? "now" : ""}"><span aria-hidden="true">${i + 1}</span> ${esc(s)}${i + 1 < wiz.step ? '<span class="sr-only"> (done)</span>' : ""}</li>`).join("")}</ol>
    <div class="card pad stack wizard" id="wizard-body">${[step1, step2, step3, step4][wiz.step - 1]()}</div>`;
}

const personRows = (pred) => people.filter((p) => p.has_login && pred(p));
function checkboxList(name, rows, selected, describe) {
  // Stable ids: a background re-render restores focus to the same checkbox (core render() keys focus by id).
  return rows.length ? `<div class="pick-grid">${rows.map((p) => `<label class="check" for="wf-${name}-${p.id}"><input type="checkbox" id="wf-${name}-${p.id}" data-wf="${name}" value="${p.id}" ${selected.includes(p.id) ? "checked" : ""}> ${esc(p.display_name ?? p.name)}${describe ? ` <span class="small muted">${esc(describe(p))}</span>` : ""}</label>`).join("")}</div>` : `<p class="small muted">Nobody yet.</p>`;
}

function step1() {
  const f = wiz.form;
  const roleText = (p) => (p.roles.includes("EXPERT") ? "expert" : p.roles.includes("LEARNER") ? "receiver" : p.roles.includes("KT_COORDINATOR") ? "coordinator" : p.roles.some((r) => ["ORG_OWNER", "ORG_ADMIN"].includes(r)) ? "administrator" : "member");
  return `<div class="grid cols-2">
    <label class="field" for="wm-name">Mission name <span class="req" aria-hidden="true">*</span><input id="wm-name" data-wform="name" value="${esc(f.name)}" maxlength="140" required aria-required="true" aria-describedby="wm-name-err"${langAttr(scriptLang(f.name))}><span id="wm-name-err" class="field-error" role="alert">${wiz.err?.name ? esc(wiz.err.name) : ""}</span></label>
    <label class="field" for="wm-domain">Domain or workflow category<input id="wm-domain" data-wform="domain" value="${esc(f.domain)}" maxlength="80" placeholder="Payments operations, weaving, family recipes…"></label>
    <label class="field" for="wm-desc">Description<textarea id="wm-desc" data-wform="description" rows="2">${esc(f.description)}</textarea></label>
    <label class="field" for="wm-ctx">Business or personal context<textarea id="wm-ctx" data-wform="businessContext" rows="2">${esc(f.businessContext)}</textarea></label>
    <label class="field" for="wm-date">Target completion date <span class="muted" style="font-weight:400">(optional)</span><input id="wm-date" type="date" data-wform="targetDate" value="${esc(f.targetDate)}"></label>
    ${langSelect("wm-lang", f.language, "Language of the knowledge", { hint: " · questions, cases and answers use this language; the interface language is separate" })}
  </div>
  <fieldset aria-describedby="wm-exp-err"><legend><b>Subject matter expert(s)</b> <span class="req" aria-hidden="true">*</span><span class="sr-only"> required</span></legend>${checkboxList("experts", personRows(() => true), f.experts, roleText)}<p id="wm-exp-err" class="field-error" role="alert">${wiz.err?.experts ? esc(wiz.err.experts) : ""}</p></fieldset>
  <fieldset><legend><b>Receivers</b> (individuals)</legend>${checkboxList("receivers", personRows(() => true), f.receivers, roleText)}</fieldset>
  <fieldset><legend><b>Receiver groups</b></legend>${groups.length ? checkboxList("receiverGroups", groups.map((g) => ({ id: g.id, name: g.name, members: g.members })), f.receiverGroups, (g) => `${g.members} member${g.members === 1 ? "" : "s"}`) : `<p class="small muted">No groups yet. <a href="#/groups">Create one</a>.</p>`}
    <p class="small muted">Group members are resolved when you send the mission; duplicates are removed and you see every resolved person before sending.</p></fieldset>
  <p class="small muted">You will be the coordinator. You can be asked to correct anything on the review step before invitations go out.</p>
  <div class="row"><button class="primary" data-act="wiz-next">Next: template ${icon("arrow", 14)}</button></div>`;
}

function step2() {
  const f = wiz.form;
  const all = [...templates.builtIn.map((x) => ({ ...x, id: null })), ...templates.organization];
  const tpl = tplOf(f);
  const methods = f.captureMethods ?? tpl.captureMethods;
  return `<fieldset><legend><b>Choose a starting point</b>: templates configure the process, never the content.</legend>
    <div class="tpl-grid">${all.map((x) => { const on = x.id ? f.templateId === x.id : !f.templateId && f.templateKey === x.key;
      return `<label class="tpl-card ${on ? "on" : ""}" for="tpl-${x.id ?? x.key}"><input type="radio" id="tpl-${x.id ?? x.key}" name="tpl" value="${x.id ?? x.key}" data-custom="${x.id ? "1" : ""}" ${on ? "checked" : ""}> <span><b>${esc(x.name)}</b>${x.custom ? ' <span class="tag sky">organization</span>' : ""}<br><span class="small muted">${esc(x.description)}</span></span></label>`; }).join("")}</div></fieldset>
  <div class="grid cols-2"><div class="card pad small stack"><b>Starter questions</b><ul>${tpl.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul><b>Expected outputs</b><ul>${tpl.outputs.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>
    <div class="card pad small stack"><b>Assessment criteria</b><ul>${tpl.criteria.map((q) => `<li>${esc(q)}</li>`).join("")}</ul><b>Approval</b><p>${esc(tpl.approvals.join(" → "))}</p><b>Retention</b><p>${esc(tpl.retention.note)}</p></div></div>
  <fieldset><legend><b>Capture methods allowed in this mission</b></legend><div class="stack">${Object.entries(templates.captureMethods).map(([k, m]) => `<label class="check" for="wm-method-${k}"><input type="checkbox" id="wm-method-${k}" data-method="${k}" ${methods.includes(k) ? "checked" : ""}> <b>${esc(m.label)}</b> <span class="small muted">${esc(METHOD_HELP[k])}</span></label>`).join("")}</div>
    <p class="small muted">Choose what the knowledge needs; not every mission needs every modality. The expert still consents per session.</p></fieldset>
  <p class="small muted">The template's questions and criteria are copied into the brief, where you can change them.</p>
  <div class="row"><button data-act="wiz-back">${icon("arrow", 14)} Back</button><button class="primary" data-act="wiz-create" ${state.busy ? "disabled" : ""}>Save draft and write the brief</button>
    ${templates.canSave ? `<button class="ghost sm" data-act="tpl-save">Save these settings as an organization template</button>` : ""}</div>`;
}

function step3() {
  const b = wiz.form.brief;
  return `<p class="small muted">The brief tells Moti what this mission must achieve and what to pay attention to. It guides questions and checks; it can never change who may see anything, consent, or safety rules. One item per line.</p>
  <section class="card pad small stack" aria-labelledby="up-h"><h2 id="up-h" class="h3">${icon("doc", 14)} Upload a README-style brief <span class="muted" style="font-weight:400">(optional)</span></h2>
    <label class="field" for="brief-file">Text, Markdown or PDF, up to ${Math.round(4)} MB<input id="brief-file" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown,application/pdf" aria-describedby="brief-file-help"></label>
    <span id="brief-file-help" class="small muted">Headings such as "## Objectives", "## Blind spots", "## Acceptance criteria" are recognised. The file is treated as data, never as instructions. PDF is stored for the AI to read; its text is not filled into the fields.</span>
    ${wiz.suggested ? `<div class="callout small stack" role="status"><b>Fields found in your document</b> (nothing applied yet):<ul>${LISTS.filter(([k]) => wiz.suggested[k]?.length).map(([k, l]) => `<li>${esc(l)}: ${wiz.suggested[k].length}</li>`).join("")}${TEXTS.filter(([k]) => wiz.suggested[k]).map(([k, l]) => `<li>${esc(l)}</li>`).join("")}</ul>
      ${wiz.flags.length ? `<p class="callout amber">This document contains text that looks like instructions to an AI (${esc(wiz.flags.join(", "))}). It will only ever be treated as data.</p>` : ""}
      <div class="row"><button class="sm primary" data-act="brief-apply">Use these fields</button><button class="sm" data-act="brief-ignore">Ignore</button></div></div>` : ""}</section>
  <div class="grid cols-2">${LISTS.map(([k, l]) => `<label class="field" for="bf-${k}">${esc(l)}<textarea id="bf-${k}" data-brief="${k}" rows="3"${langAttr(scriptLang(b[k]))}>${esc(b[k])}</textarea></label>`).join("")}
    ${TEXTS.map(([k, l]) => `<label class="field" for="bf-${k}">${esc(l)}<textarea id="bf-${k}" data-brief="${k}" rows="2"${langAttr(scriptLang(b[k]))}>${esc(b[k])}</textarea></label>`).join("")}</div>
  <div class="row"><button data-act="wiz-back">${icon("arrow", 14)} Back</button><button class="primary" data-act="wiz-brief" ${state.busy ? "disabled" : ""}>Save brief and review</button></div>`;
}

function step4() {
  if (!review || review.id !== wiz.missionId) { api("GET", `/api/missions/${wiz.missionId}/review`).then((r) => { review = r; render(); }).catch((e) => toast(e.message, true)); return `<span class="thinking">Preparing the review</span>`; }
  return `${reviewBody(review)}<div class="row"><button data-act="wiz-back">${icon("arrow", 14)} Back to the brief</button><button data-act="wiz-goto" data-step="1">Change people</button>
    <button class="accent" data-act="send" data-id="${review.id}" ${state.busy ? "disabled" : ""}>${icon("validate", 15)} Send invitations</button></div>`;
}

function reviewBody(r) {
  const issues = [...r.experts, ...r.receivers].filter((p) => p.issue);
  return `<div class="grid cols-2"><section class="stack small" aria-labelledby="rv-m"><h2 id="rv-m" class="h3">Mission</h2><dl class="kv left"><dt>Name</dt><dd${langAttr(scriptLang(r.name))}>${esc(r.name)}</dd><dt>Template</dt><dd>${esc(r.template)}</dd><dt>Due</dt><dd>${esc(r.targetDate ? String(r.targetDate).slice(0, 10) : "no date")}</dd><dt>Knowledge language</dt><dd>${esc(r.language)}</dd><dt>Capture</dt><dd>${esc(r.captureMethods.join(", "))}</dd></dl>
      <h3>Expected deliverables</h3><ul>${r.deliverables.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></section>
    <section class="stack small" aria-labelledby="rv-p"><h2 id="rv-p" class="h3">People who will be invited</h2>
      <div class="table-wrap" role="region" aria-label="Invitee table" tabindex="0"><table class="t"><caption class="sr-only">Experts and resolved receivers</caption><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Assigned</th></tr></thead><tbody>
      ${r.experts.map((p) => `<tr><td>${esc(p.name)}</td><td>Subject matter expert</td><td>individually${p.issue ? `<div class="field-error">${esc(p.issue)}</div>` : ""}</td></tr>`).join("")}
      ${r.receivers.map((p) => `<tr><td>${esc(p.name)}</td><td>Receiver</td><td>${esc(p.via)}${p.issue ? `<div class="field-error">${esc(p.issue)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>
      ${r.groups.length ? `<p>Groups: ${r.groups.map((g) => `${esc(g.name)} (${g.members})`).join(", ")}. Each person appears once.</p>` : ""}
      ${issues.length ? `<p class="callout amber" role="alert">${issues.length} participant${issues.length === 1 ? "" : "s"} cannot take part yet (see above). Fix their role in Administration or remove them.</p>` : ""}</section></div>
  <section class="stack small" aria-labelledby="rv-moti"><h2 id="rv-moti" class="h3">${icon("spark", 14)} Moti's summary of the brief</h2>${motiBlock(r.moti)}</section>
  <section class="callout small stack" aria-labelledby="rv-acc"><h2 id="rv-acc" class="h3">${icon("shield", 14)} Access, consent and retention</h2><p><b>Access:</b> ${esc(r.access)}</p><p><b>Consent:</b> ${esc(r.consent)}</p><p><b>Retention:</b> ${esc(r.retention?.note ?? "")}</p><p><b>Notifications:</b> ${esc(r.notifications)}</p></section>`;
}

function motiBlock(m) {
  const li = (a) => (a.length ? `<ul>${a.map((x) => `<li${langAttr(scriptLang(x))}>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">none given</p>`);
  return `<div class="grid cols-2"><div><b>Purpose</b><p${langAttr(scriptLang(m.purpose))}>${esc(m.purpose || "not stated")}</p><b>Expected outcomes</b>${li(m.outcomes)}<b>Decisions to demonstrate</b>${li(m.decisions)}</div>
    <div><b>Constraints</b>${li(m.constraints)}<b>Out of scope</b><p${langAttr(scriptLang(m.outOfScope))}>${esc(m.outOfScope || "not stated")}</p><b>Focus for questions</b><p>${m.focus.blindSpots} blind spot(s), ${m.focus.questions} question(s), ${m.focus.acceptance} acceptance criteria</p></div></div>
    <p class="small muted">${esc(m.note)}</p>`;
}

// ---------------------------------------------------------------- review page (existing draft)
function reviewView(id) {
  if (!review || review.id !== id) { api("GET", `/api/missions/${id}/review`).then((r) => { review = r; render(); }).catch((e) => toast(e.message, true)); return `<span class="thinking">Loading</span>`; }
  return `<div class="page-head"><div><div class="eyebrow">Review before sending</div><h1${langAttr(scriptLang(review.name))}>${esc(review.name)}</h1></div><a class="btn ghost" href="#/missions/${id}">Back</a></div>
    <div class="card pad stack">${reviewBody(review)}${review.status === "draft" ? `<div class="row"><button data-act="edit-draft" data-id="${id}">Edit</button><button class="accent" data-act="send" data-id="${id}" ${state.busy ? "disabled" : ""}>${icon("validate", 15)} Send invitations</button></div>` : `<p class="small muted">Already sent.</p>`}</div>`;
}

// ---------------------------------------------------------------- overview
function overviewView(id) {
  if (!current || current.id !== id) { api("GET", `/api/missions/${id}`).then((m) => { current = m; render(); }).catch((e) => { toast(e.message, true); go("#/missions"); }); return `<span class="thinking">Loading mission</span>`; }
  const m = current;
  if (m.assessing) setTimeout(() => { if (current?.id === id && location.hash.startsWith(`#/missions/${id}`)) api("GET", `/api/missions/${id}`).then((x) => { current = x; render(); }); }, 2500);
  if (m.me.expert && m.workflowId && (!wfDetail || wfDetail.id !== m.workflowId)) api("GET", `/api/workflows/${m.workflowId}`).then((w) => { wfDetail = w; render(); }).catch(() => {});
  const idx = STAGES.findIndex(([k]) => k === m.stage);
  return `<div class="page-head"><div><div class="eyebrow">KT mission · ${esc(m.template?.name ?? m.template?.key ?? "")}${m.domain ? ` · ${esc(m.domain)}` : ""}</div><h1${langAttr(scriptLang(m.name))}>${esc(m.name)}</h1>
      <p>${m.description ? `<span${langAttr(scriptLang(m.description))}>${esc(m.description)}</span> · ` : ""}Coordinator: ${esc(m.coordinator ?? "—")}${m.targetDate ? ` · due ${esc(String(m.targetDate).slice(0, 10))}` : ""}</p></div>
    ${m.me.manage ? statusControls(m) : ""}</div>
  <ol class="stage-line" aria-label="Mission stage">${STAGES.map(([k, l], i) => `<li class="${i < idx ? "done" : i === idx ? "now" : ""}" ${i === idx ? 'aria-current="step"' : ""}>${esc(l)}${i < idx ? '<span class="sr-only"> (passed)</span>' : ""}</li>`).join("")}</ol>
  ${idx < 0 ? `<p class="callout amber"><b>${esc(stageLabel(m.stage))}.</b> ${esc(m.statusNote ?? m.exceptionNote ?? "")}</p>` : ""}
  ${m.next ? `<section class="callout next-action stack" aria-labelledby="nx-h"><h2 id="nx-h" class="h3">${icon("arrow", 14)} Next</h2><p>${esc(m.next.label)}</p>
    ${m.next.href ? `<div><a class="btn primary sm" href="${esc(m.next.href)}">Go</a></div>` : ""}${m.next.act === "confirm" ? "" : ""}</section>` : ""}
  ${m.me.status === "invited" || m.me.status === "pending" ? `<section class="card pad row between wrap" aria-label="Your invitation"><span>You were asked to take part as <b>${m.me.expert ? "subject matter expert" : "receiver"}</b>.</span><span class="row"><button class="primary sm" data-act="m-respond" data-v="1">Accept</button><button class="sm" data-act="m-respond" data-v="0">Decline</button></span></section>` : ""}
  ${m.moti && m.me.expert ? motiSection(m) : ""}
  ${m.me.expert && m.briefConfirmed && ["ready_to_capture", "awaiting_participants", "capturing", "knowledge_review"].includes(m.stage) && m.status === "active" ? captureSection(m) : ""}
  <div class="grid cols-2" style="margin-top:16px">
    <section class="card pad stack" aria-labelledby="pp-h"><h2 id="pp-h" class="h3">Participants</h2>
      <div class="table-wrap" role="region" aria-label="Participant table" tabindex="0"><table class="t"><caption class="sr-only">Participants and their status</caption><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th></tr></thead><tbody>
      ${m.participants.map((p) => `<tr><td>${esc(p.name)}${p.viaGroup ? `<div class="small muted">via ${esc(p.viaGroup)}</div>` : ""}</td><td>${p.role === "expert" ? "Subject matter expert" : "Receiver"}</td><td><span class="tag ${p.status === "accepted" ? "green" : p.status === "declined" ? "red" : ""}">${esc(p.status)}</span>${p.issue ? `<div class="field-error">${esc(p.issue)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>
      ${m.status === "draft" && m.me.manage ? `<a class="btn sm" href="#/missions/${m.id}/review">Review and send</a>` : ""}</section>
    <section class="card pad stack" aria-labelledby="br-h"><h2 id="br-h" class="h3">Brief</h2>${briefSection(m)}</section>
  </div>
  ${m.requirements.length ? requirementsSection(m) : ""}
  <section class="card pad stack" style="margin-top:16px" aria-labelledby="kn-h"><h2 id="kn-h" class="h3">Captured knowledge</h2>
    ${m.knowledge.length ? `<div class="table-wrap" role="region" aria-label="Knowledge table" tabindex="0"><table class="t"><caption class="sr-only">Knowledge captured in this mission</caption><thead><tr><th scope="col">Knowledge</th><th scope="col">Status</th><th scope="col">Open gaps</th><th scope="col">Practice cases</th></tr></thead><tbody>
      ${m.knowledge.map((k) => `<tr><td>${k.id ? `<a href="#/knowledge/${k.id}"${langAttr(scriptLang(k.title))}>${esc(k.title)}</a>` : `${esc(k.title)} ${requestButton(k.requestArtifactId)}`} <span class="small muted">v${k.version} · ${esc(k.expert)}</span></td><td>${esc(k.status === "approved" ? "Approved by the expert" : k.status === "observed" ? "Awaiting the expert's review" : k.status)}</td><td>${k.openGaps}</td><td>${k.tests.approved} approved${k.tests.draft ? `, ${k.tests.draft} awaiting review` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="small muted">Nothing captured yet. A recording alone never completes a mission: knowledge must be reviewed and approved by the expert.</p>`}
    ${m.sessions.length ? `<p class="small">Capture sessions: ${m.sessions.map((s) => `<a href="#/session/${s.id}">${esc(s.expert)} · ${esc(s.status)} · ${ago(s.createdAt)}</a>`).join(" · ")}</p>` : ""}</section>
  ${resultsSection(m)}
  ${m.completion && m.status === "active" && m.me.manage ? completionSection(m) : ""}`;
}

function statusControls(m) {
  if (["completed", "completed_with_exceptions", "cancelled"].includes(m.status)) return "";
  return `<div class="row wrap" role="group" aria-label="Mission status">${m.status === "draft" ? `<a class="btn sm primary" href="#/missions/${m.id}/review">Review and send</a>` : ""}
    ${m.status === "active" ? `<button class="sm" data-act="m-status" data-v="paused">Pause</button><button class="sm" data-act="m-status" data-v="blocked">Mark blocked</button>` : ""}
    ${["paused", "blocked"].includes(m.status) ? `<button class="sm primary" data-act="m-status" data-v="active">Resume</button>` : ""}
    <button class="sm ghost danger" data-act="m-status" data-v="cancelled">Cancel mission</button></div>`;
}

function motiSection(m) {
  return `<section class="card pad stack moti-brief" style="margin-top:16px" aria-labelledby="mt-h"><div class="row">${orb(m.briefConfirmed ? "confirmed" : "curious", 52, { caption: false })}<div><h2 id="mt-h" class="h3">${m.briefConfirmed ? "You confirmed Moti's summary of the brief" : "Before you start: is this what the mission is about?"}</h2>
    <p class="small muted">Moti repeats the coordinator's brief; it adds nothing. During capture it uses the brief to choose which questions matter. You can always say something is wrong or out of scope.</p></div></div>
    ${motiBlock(m.moti)}
    ${m.briefConfirmed ? "" : `<div class="row"><button class="primary" data-act="m-confirm">${icon("validate", 14)} Yes, this is right</button><span class="small muted">If it is wrong, tell ${esc(m.coordinator ?? "the coordinator")} before capturing.</span></div>`}</section>`;
}

function captureSection(m) {
  const sim = wfDetail?.simSources ?? [];
  const support = { audio: Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder), audio_video: Boolean(navigator.mediaDevices?.getUserMedia), screen: Boolean(navigator.mediaDevices?.getDisplayMedia), text: true };
  const sel = state.drafts["m-method"] ?? (m.captureMethods.find((c) => support[c.key])?.key ?? "text");
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="cp-h"><h2 id="cp-h" class="h3">${icon("capture", 15)} Capture for this mission</h2>
    <fieldset><legend>How should this knowledge be captured?</legend><div class="stack">
      ${m.captureMethods.map((c) => `<label class="check" for="m-method-${c.key}"><input type="radio" id="m-method-${c.key}" name="m-method" value="${c.key}" ${sel === c.key ? "checked" : ""} ${support[c.key] ? "" : "disabled"}> <b>${esc(c.label)}</b> <span class="small muted">${esc(METHOD_HELP[c.key])}</span>${support[c.key] ? "" : ` <span class="field-error">Not available in this browser${c.key === "screen" ? " (screen sharing needs a desktop browser)" : ""}; choose another method or type the steps.</span>`}</label>`).join("")}
      ${sim.length ? sim.map((s) => `<label class="check" for="m-method-sim-${esc(s.id.replace(/[^a-z0-9-]/gi, "-"))}"><input type="radio" id="m-method-sim-${esc(s.id.replace(/[^a-z0-9-]/gi, "-"))}" name="m-method" value="sim:${esc(s.id)}" ${sel === `sim:${s.id}` ? "checked" : ""}> <b>${esc(s.label)}</b> <span class="small muted">Simulated feed for the sample (labelled as such)</span></label>`).join("") : ""}
    </div></fieldset>
    <p class="small muted">Next you will see exactly what will be captured, why, who can see it, that AI will process it, and how long it is kept, and you agree before anything is recorded. You can pause, exclude an input, or delete any moment.</p>
    <div><button class="primary" data-act="m-capture" ${state.busy ? "disabled" : ""}>${icon("capture", 14)} Continue to consent</button></div></section>`;
}

function briefSection(m) {
  const b = m.brief;
  const li = (a) => (a?.length ? `<ul>${a.map((x) => `<li${langAttr(scriptLang(x))}>${esc(x)}</li>`).join("")}</ul>` : "");
  return `${b.objectives?.length ? `<b>Objectives</b>${li(b.objectives)}` : ""}${b.outcomes?.length ? `<b>Expected outcomes</b>${li(b.outcomes)}` : ""}
    ${b.constraints?.length ? `<b>Constraints</b>${li(b.constraints)}` : ""}${b.outOfScope ? `<b>Out of scope</b><p${langAttr(scriptLang(b.outOfScope))}>${esc(b.outOfScope)}</p>` : ""}
    ${m.me.receiver && !m.me.manage ? `<p class="small muted">Blind spots, questions and acceptance criteria are shown to the expert and coordinator only, so the assessment stays fair.</p>` : ""}
    ${m.me.manage && m.status !== "draft" ? `<p class="small muted">Brief version ${m.briefVersion}${m.briefConfirmed ? ", confirmed by the expert" : ", not yet confirmed by the expert"}.</p>` : ""}`;
}

function requirementsSection(m) {
  const canDecide = m.me.manage || m.me.expert;
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="rq-h"><div class="row between wrap"><h2 id="rq-h" class="h3">${icon("check", 15)} What the brief requires, and the evidence</h2>${m.assessing ? `<span class="thinking small" role="status">Moti is checking the captured knowledge</span>` : ""}</div>
    <p class="small muted">"Satisfied" by AI needs a verified quote from observed or expert-stated knowledge; otherwise it is downgraded. A person's decision is shown as such and is never overwritten by the AI.</p>
    <div class="table-wrap" role="region" aria-label="Requirement table" tabindex="0"><table class="t req-table"><caption class="sr-only">Mission requirements with status and evidence</caption><thead><tr><th scope="col">Requirement</th><th scope="col">Status</th><th scope="col">Evidence or reason</th>${canDecide ? '<th scope="col"><span class="sr-only">Decide</span></th>' : ""}</tr></thead><tbody>
    ${m.requirements.map((r) => { const [l, tone, ic] = REQ[r.status];
      return `<tr><td><span class="small muted">${esc(KIND[r.kind])}</span><div${langAttr(scriptLang(r.text))}>${esc(r.text)}</div></td>
        <td><span class="tag ${tone}">${icon(ic, 11)} ${esc(l)}</span><div class="small muted">${esc(BASIS[r.basis])}${r.decidedBy ? ` (${esc(r.decidedBy)})` : ""}</div></td>
        <td class="small">${r.evidence?.length ? r.evidence.map((e) => `<q${langAttr(scriptLang(e.quote))}>${esc(e.quote)}</q> <span class="muted">· ${esc(e.field)}, ${esc(String(e.fieldStatus ?? "").toLowerCase().replace("_", " "))}</span>${e.judgmentId ? ` <a href="#/knowledge/${e.judgmentId}">open</a>` : ""}`).join("<br>") : ""}<div class="muted"${langAttr(scriptLang(r.explanation))}>${esc(r.explanation)}</div></td>
        ${canDecide ? `<td><details><summary>Decide</summary><div class="stack" style="margin-top:6px"><label class="field" for="rq-st-${r.id}">Status<select id="rq-st-${r.id}">${Object.entries(REQ).map(([k, [lab]]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${esc(lab)}</option>`).join("")}</select></label>
          <label class="field" for="rq-note-${r.id}">What shows this (required for Satisfied)<input id="rq-note-${r.id}" data-draft="rq-note-${r.id}" maxlength="500"></label><button class="sm" data-act="rq-decide" data-id="${r.id}">Save decision</button></div></details></td>` : ""}</tr>`; }).join("")}</tbody></table></div></section>`;
}

function resultsSection(m) {
  if (!m.results.length) return m.me.receiver ? `<section class="card pad" style="margin-top:16px"><h2 class="h3">Your assessment</h2><p class="small muted">Available once the expert has approved the knowledge and its practice cases.</p></section>` : "";
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="rs-h"><h2 id="rs-h" class="h3">Transfer assessment results</h2>
    <p class="small muted">Results from simulated cases only. "Demonstrated in simulation" is not certification or permission to do the real work.</p>
    <div class="table-wrap" role="region" aria-label="Result table" tabindex="0"><table class="t"><caption class="sr-only">Assessment results per receiver and knowledge</caption><thead><tr><th scope="col">Receiver</th><th scope="col">Knowledge</th><th scope="col">Result</th><th scope="col">Gaps</th></tr></thead><tbody>
    ${m.results.map((x) => { const [l, tone] = RESULT[x.status] ?? [x.status, ""]; return `<tr><td>${esc(x.name)}</td><td>${esc(x.title)}</td><td><span class="tag ${tone}">${esc(l)}</span></td><td class="small">${esc((x.gaps ?? []).join("; ") || "—")}</td></tr>`; }).join("")}</tbody></table></div>
    ${m.me.receiver ? `<a class="btn sm" href="#/learn">Go to your lessons</a>` : ""}</section>`;
}

function completionSection(m) {
  const c = m.completion;
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="cm-h"><h2 id="cm-h" class="h3">Completion</h2>
    <ul class="plain"><li>${c.requirementsOpen ? `<span class="tag amber">${c.requirementsOpen} open</span> required item(s) not yet satisfied or not applicable` : `<span class="tag green">${icon("validate", 11)} done</span> every required item satisfied or not applicable`}</li>
      <li>${c.approvedKnowledge ? `<span class="tag green">${icon("validate", 11)} done</span> ${c.approvedKnowledge} piece(s) of approved knowledge` : `<span class="tag amber">missing</span> no approved knowledge`}</li>
      <li>${c.receiversWithoutResults.length ? `<span class="tag amber">waiting</span> no assessment result for ${esc(c.receiversWithoutResults.join(", "))}` : `<span class="tag green">${icon("validate", 11)} done</span> every receiver has a result`}</li></ul>
    ${c.ready ? `<div><button class="accent" data-act="m-complete">${icon("validate", 14)} Complete the mission</button></div>`
      : `<details><summary>Close it anyway with a recorded exception</summary><div class="stack" style="margin-top:8px"><label class="field" for="m-exc">Exception (who decided, why, what remains)<textarea id="m-exc" data-draft="m-exc" rows="2" maxlength="1000"></textarea></label><div><button class="sm danger" data-act="m-complete-exc">Record exception and close</button></div></div></details>`}</section>`;
}

// ---------------------------------------------------------------- events
const formFromInputs = () => {
  const f = wiz.form;
  document.querySelectorAll("[data-wform]").forEach((el) => { f[el.dataset.wform] = el.value; });
  const lang = document.getElementById("wm-lang"); if (lang) f.language = lang.value;
  for (const k of ["experts", "receivers", "receiverGroups"]) { const els = document.querySelectorAll(`[data-wf="${k}"]`); if (els.length) f[k] = [...els].filter((x) => x.checked).map((x) => x.value); }
  const ms = document.querySelectorAll("[data-method]"); if (ms.length) f.captureMethods = [...ms].filter((x) => x.checked).map((x) => x.dataset.method);
  document.querySelectorAll("[data-brief]").forEach((el) => { f.brief[el.dataset.brief] = el.value; });
};
const briefPayload = (b) => Object.fromEntries([...LISTS.map(([k]) => [k, String(b[k] ?? "").split("\n").map((x) => x.trim()).filter(Boolean)]), ...TEXTS.map(([k]) => [k, String(b[k] ?? "")])]);
// Each step moves focus to its heading (announced as the new context); Tab then continues into the step.
const focusWizard = () => setTimeout(() => { const h = document.querySelector("main h1"); if (h) { h.setAttribute("tabindex", "-1"); h.focus(); } }, 30);

export async function missionsClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  if (a === "wiz-next") {
    formFromInputs();
    wiz.err = {};
    if (!wiz.form.name.trim()) wiz.err.name = "Give the mission a name.";
    if (!wiz.form.experts.length) wiz.err.experts = "Choose at least one subject matter expert.";
    if (Object.keys(wiz.err).length) { render(); announce(Object.values(wiz.err).join(" ")); toast(Object.values(wiz.err).join(" "), true); document.getElementById("wm-name")?.focus(); return; }
    wiz.step = 2; render(); announce("Step 2 of 4: template."); focusWizard(); return;
  }
  if (a === "wiz-back") { formFromInputs(); wiz.step = Math.max(1, wiz.step - 1); review = null; render(); announce(`Step ${wiz.step} of 4.`); focusWizard(); return; }
  if (a === "wiz-goto") { wiz.step = Number(el.dataset.step); review = null; render(); focusWizard(); return; }
  if (a === "wiz-create") {
    formFromInputs();
    const f = wiz.form, tpl = tplOf(f);
    if (!wiz.missionId) { f.brief.questions = f.brief.questions || tpl.questions.join("\n"); f.brief.acceptance = f.brief.acceptance || tpl.criteria.join("\n"); }
    const payload = { name: f.name.trim(), description: f.description, businessContext: f.businessContext, domain: f.domain, targetDate: f.targetDate || null, language: f.language,
      experts: f.experts, receivers: f.receivers, receiverGroups: f.receiverGroups, captureMethods: f.captureMethods ?? tpl.captureMethods, brief: briefPayload(f.brief), ...(f.templateId ? { templateId: f.templateId } : { templateKey: f.templateKey }) };
    return act("mission", async () => {
      if (wiz.missionId) { const { templateKey, templateId, ...rest } = payload; await api("POST", `/api/missions/${wiz.missionId}`, rest); }
      else { const r = await api("POST", "/api/missions", payload); wiz.missionId = r.id; }
      wiz.step = 3; announce("Draft saved. Step 3 of 4: the mission brief."); focusWizard();
    });
  }
  if (a === "tpl-save") {
    formFromInputs();
    const tpl = tplOf(wiz.form);
    const name = prompt("Name for this organization template", `${tpl.name} (ours)`);
    if (!name) return;
    return act("tpl", async () => { await api("POST", "/api/templates", { baseKey: tpl.key, config: { name, captureMethods: wiz.form.captureMethods ?? tpl.captureMethods } }); templates = await api("GET", "/api/templates"); toast("Template saved."); });
  }
  if (a === "brief-apply") { for (const [k] of LISTS) if (wiz.suggested[k]?.length) wiz.form.brief[k] = wiz.suggested[k].join("\n"); for (const [k] of TEXTS) if (wiz.suggested[k]) wiz.form.brief[k] = wiz.suggested[k]; wiz.suggested = null; render(); announce("Fields filled from your document. Review them before saving."); return; }
  if (a === "brief-ignore") { wiz.suggested = null; render(); return; }
  if (a === "wiz-brief") {
    formFromInputs();
    return act("mission", async () => { await api("POST", `/api/missions/${wiz.missionId}`, { brief: briefPayload(wiz.form.brief) }); review = null; wiz.step = 4; announce("Brief saved. Step 4 of 4: review before sending."); focusWizard(); });
  }
  if (a === "send") {
    return act("mission", async () => {
      const r = await api("POST", `/api/missions/${el.dataset.id}/send`);
      announce(`Invitations sent to ${r.invited} people.`); toast(`Invitations sent to ${r.invited} ${r.invited === 1 ? "person" : "people"} (in-app only).`);
      const id = el.dataset.id; wiz = null; review = null; list = null; current = null; go(`#/missions/${id}`);
    });
  }
  if (a === "edit-draft") { const m = await api("GET", `/api/missions/${el.dataset.id}`); wiz = { step: 1, missionId: m.id, form: { ...blankForm(), name: m.name, description: m.description, domain: m.domain, language: m.language, brief: Object.fromEntries(Object.entries(m.brief).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : v])) }, suggested: null, flags: [] }; go("#/missions/new"); return; }
  const id = current?.id;
  if (a === "m-respond") return act("mission", async () => { await api("POST", `/api/missions/${id}/respond`, { accept: el.dataset.v === "1" }); current = await api("GET", `/api/missions/${id}`); announce(el.dataset.v === "1" ? "You accepted the mission." : "You declined the mission."); });
  if (a === "m-confirm") return act("mission", async () => { await api("POST", `/api/missions/${id}/confirm-brief`); current = await api("GET", `/api/missions/${id}`); announce("Brief confirmed. You can start capturing."); });
  if (a === "m-capture") {
    const v = document.querySelector('input[name="m-method"]:checked')?.value ?? "text";
    return act("mission", async () => { const s = await api("POST", `/api/missions/${id}/capture`, v.startsWith("sim:") ? { source: v } : { method: v }); current = null; go(`#/session/${s.id}`); });
  }
  if (a === "m-status") {
    const v = el.dataset.v;
    if (v === "cancelled" && !confirm("Cancel this mission? Captured knowledge stays; the mission closes.")) return;
    return act("mission", async () => { await api("POST", `/api/missions/${id}/status`, { status: v }); current = await api("GET", `/api/missions/${id}`); announce(`Mission ${stageLabel(v).toLowerCase()}.`); });
  }
  if (a === "rq-decide") {
    const rid = el.dataset.id, status = document.getElementById(`rq-st-${rid}`).value;
    return act("mission", async () => { await api("POST", `/api/requirements/${rid}/decide`, { status, note: draft(`rq-note-${rid}`) }); current = await api("GET", `/api/missions/${id}`); announce("Decision saved."); });
  }
  if (a === "m-complete") return act("mission", async () => { await api("POST", `/api/missions/${id}/complete`, {}); current = await api("GET", `/api/missions/${id}`); announce("Mission completed."); });
  if (a === "m-complete-exc") {
    const note = draft("m-exc");
    if (!note) { toast("Write the exception first.", true); document.getElementById("m-exc")?.focus(); return; }
    return act("mission", async () => { await api("POST", `/api/missions/${id}/complete`, { exceptionNote: note }); current = await api("GET", `/api/missions/${id}`); announce("Mission closed with a recorded exception."); });
  }
}

// Keep the wizard's state current on every edit, so any re-render (background refresh, language change) keeps it.
document.addEventListener("input", (e) => { if (wiz && e.target.closest?.("#wizard-body") && (e.target.dataset.wform || e.target.dataset.brief)) formFromInputs(); });

export async function missionsChange(e) {
  const el = e.target;
  if (wiz && el.closest?.("#wizard-body") && (el.dataset.wf || el.dataset.method || el.id === "wm-lang" || el.dataset.wform)) { formFromInputs(); return; }
  if (el.name === "tpl") { formFromInputs(); if (el.dataset.custom) { wiz.form.templateId = el.value; } else { wiz.form.templateId = null; wiz.form.templateKey = el.value; } wiz.form.captureMethods = null; render(); document.querySelector(`input[name="tpl"][value="${el.value}"]`)?.focus(); return; }
  if (el.name === "m-method") { state.drafts["m-method"] = el.value; return; }
  if (el.id === "brief-file" && el.files?.[0]) {
    const file = el.files[0];
    if (file.size > 4 * 1024 * 1024) { toast("That file is larger than 4 MB.", true); el.value = ""; return; }
    const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const body = pdf ? { title: file.name, dataBase64: await toBase64(file) } : { title: file.name, text: await file.text() };
    return act("upload", async () => {
      const r = await api("POST", `/api/missions/${wiz.missionId}/brief-document`, body);
      wiz.suggested = r.suggestedBrief; wiz.flags = (r.injectionFlags ?? []).map((x) => (typeof x === "string" ? x : x.kind ?? "instruction-like text"));
      announce(r.suggestedBrief ? "Document read. Review the fields found before using them." : r.note);
      if (!r.suggestedBrief) toast(r.note);
    });
  }
}
const toBase64 = (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(file); });
