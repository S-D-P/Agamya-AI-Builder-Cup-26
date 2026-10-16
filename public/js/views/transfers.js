// AGAMYA FOR WORK: knowledge transfers. A manager plans "Dana → Jordan on month-end exceptions"; Dana sees exactly what
// will be captured and who will see it, starts the capture from the plan; the manager sees what transferred.
import { state, api, esc, render, act, go, draft, has, ago, toast, setWorkflow } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";

let list = null, detail = null, people = null, wfDetail = null;
const startSel = { source: null, caseRef: null };
const plan = { workflowId: null, expert: null, learner: null };
export function invalidateTransfers() { list = null; detail = null; }

export const STAGE = {
  scheduled: ["Scheduled", ""], capturing: ["Capturing", "sky"], awaiting_approval: ["Awaiting the expert's approval", "amber"], ready_for_learner: ["Ready for the learner", "green"],
  learning: ["Learner practising", "sky"], demonstrated_in_simulation: ["Demonstrated in simulation", "green"], needs_supervision: ["Needs supervision", "red"],
  nothing_to_transfer: ["No judgment found", ""], cancelled: ["Cancelled", ""],
};
const stageTag = (s) => `<span class="tag ${STAGE[s]?.[1] ?? ""}">${esc(STAGE[s]?.[0] ?? s)}</span>`;
export const MASTERY = { not_started: ["Not started", ""], in_progress: ["In progress", "sky"], demonstrated_in_simulation: ["Demonstrated in simulation", "green"], needs_supervision: ["Needs supervision", "red"] };
export const masteryTag = (s) => `<span class="tag ${MASTERY[s]?.[1] ?? ""}">${esc(MASTERY[s]?.[0] ?? s)}</span>`;

export function transfersView(r) {
  if (r.id === "new") return planView();
  if (r.id) return detailView(r.id);
  if (!list) { api("GET", "/api/transfers").then((x) => { list = x; render(); }).catch((e) => toast(e.message, true)); return `<span class="thinking">Loading transfers</span>`; }
  const manager = has("ORG_ADMIN", "WORKFLOW_OWNER");
  return `<div class="page-head"><div><h1>Knowledge transfers</h1><p>${manager ? "Arrange for an experienced colleague to pass on the judgment behind a workflow, and see what the learner can now do without them." : "Transfers you are part of, as the expert or as the learner."}</p></div>
      ${manager ? `<a class="btn primary" href="#/transfers/new">${icon("plus", 15)} Plan a transfer</a>` : ""}</div>
    ${list.length ? `<div class="transfer-list">${list.map((t) => `<a class="card transfer" href="#/transfers/${t.id}">
      <div class="row between"><span class="eyebrow">${esc(t.workflowName)}</span>${stageTag(t.stage)}</div>
      <div class="pair"><span><span class="avatar" aria-hidden="true">${esc(t.expert.name[0])}</span> <b>${esc(t.expert.name)}</b><span class="small muted">expert</span></span>${icon("arrow", 16)}<span><span class="avatar alt" aria-hidden="true">${esc(t.learner.name[0])}</span> <b>${esc(t.learner.name)}</b><span class="small muted">learner</span></span></div>
      <p class="small">${esc(t.purpose)}</p>
      <div class="row between small muted"><span>${t.scheduledFor ? `${icon("calendar", 13)} ${new Date(t.scheduledFor).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : "Not scheduled"}</span><span>${t.knowledgeCount ? `${t.demonstrated}/${t.knowledgeCount} demonstrated` : ""}${t.role !== "manager" ? ` · you are the ${t.role}` : ""}</span></div></a>`).join("")}</div>`
      : `<div class="card empty">${orb("observing", 80)}<p>No transfers yet.</p>${manager ? `<a class="btn primary" href="#/transfers/new">Plan the first one</a>` : ""}</div>`}`;
}

function planView() {
  if (!has("ORG_ADMIN", "WORKFLOW_OWNER")) return `<div class="card pad">Only managers and workflow owners can plan transfers.</div>`;
  if (!people) { api("GET", "/api/people").then((p) => { people = p; render(); }); return `<span class="thinking">Loading</span>`; }
  plan.workflowId ??= state.workflows[0]?.id;
  const experts = people.filter((p) => p.roles.includes("EXPERT")), learners = people.filter((p) => p.roles.includes("LEARNER"));
  return `<div class="page-head"><div><div class="eyebrow">New knowledge transfer</div><h1>Who should learn what, from whom?</h1><p>The expert will see this purpose, what will be captured, and who will see the result before anything is recorded.</p></div></div>
  <section class="card pad stack" style="max-width:780px">
    <label class="field">Workflow<select id="tp-wf">${state.workflows.map((w) => `<option value="${w.id}" ${w.id === plan.workflowId ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select></label>
    <div class="grid cols-2"><label class="field">Expert<select id="tp-expert"><option value="">Choose…</option>${experts.map((p) => `<option value="${p.id}" ${p.id === plan.expert ? "selected" : ""}>${esc(p.display_name)}${p.title ? ` · ${esc(p.title)}` : ""}</option>`).join("")}</select></label>
      <label class="field">Learner<select id="tp-learner"><option value="">Choose…</option>${learners.map((p) => `<option value="${p.id}" ${p.id === plan.learner ? "selected" : ""}>${esc(p.display_name)}${p.title ? ` · ${esc(p.title)}` : ""}</option>`).join("")}</select></label></div>
    <label class="field">Purpose<textarea data-draft="tp-purpose" rows="2" placeholder="Dana retires next quarter. Capture how she handles the exceptions the runbook gets wrong."></textarea></label>
    <label class="field" style="max-width:280px">When <span class="faint">(optional)</span><input type="datetime-local" data-draft="tp-when"></label>
    <p class="small muted">Agamya does not send invitations by email in this version; the expert and learner see the transfer when they sign in.</p>
    <div class="row"><button class="primary" data-act="tp-create" ${state.busy ? "disabled" : ""}>Plan transfer</button><a class="btn ghost" href="#/transfers">Cancel</a></div>
  </section>`;
}

function detailView(id) {
  if (!detail || detail.id !== id) { api("GET", `/api/transfers/${id}`).then((d) => { detail = d; render(); }).catch((e) => { toast(e.message, true); go("#/transfers"); }); return `<span class="thinking">Loading</span>`; }
  const t = detail, p = t.progress;
  if (t.role === "expert" && t.status === "scheduled" && (!wfDetail || wfDetail.id !== t.workflowId)) { api("GET", `/api/workflows/${t.workflowId}`).then((w) => { wfDetail = w; render(); }); }
  return `<div class="page-head"><div><div class="eyebrow">${esc(t.workflowName)} · knowledge transfer</div><h1>${esc(t.expert.name)} → ${esc(t.learner.name)}</h1><p>${esc(t.purpose)}</p></div>
      <div class="row">${stageTag(p.stage)}${t.role === "manager" && t.status === "scheduled" ? `<button class="sm ghost" data-act="tp-status" data-v="cancelled">Cancel transfer</button>` : ""}</div></div>
  <div class="grid cols-2">
    <section class="card pad stack"><h2>${t.role === "expert" ? "Before you start" : "What the expert is told"}</h2>
      <dl class="disclose"><dt>${icon("capture", 15)} What is captured</dt><dd>${esc(t.disclosure.captured)}</dd><dt>${icon("spark", 15)} Why</dt><dd>${esc(t.disclosure.purpose)}</dd>
        <dt>${icon("users", 15)} Who sees the result</dt><dd>${esc(t.disclosure.access)}</dd><dt>${icon("clock", 15)} Retention</dt><dd>${esc(t.disclosure.retention)}</dd><dt>${icon("shield", 15)} Your controls</dt><dd>${esc(t.disclosure.controls)}</dd></dl>
      ${t.role === "expert" && t.status === "scheduled" ? startBlock(t) : ""}</section>
    <section class="card pad stack"><h2>Progress</h2>
      ${p.sessions.length ? `<div class="small">${p.sessions.map((s, i) => `<div class="row between"><span>Session ${i + 1} · ${ago(s.createdAt)}</span><a href="#/session/${s.id}">${esc(s.status.replace(/_/g, " "))}</a></div>`).join("")}</div>` : `<p class="small muted">No capture yet. ${esc(t.expert.name)} starts it from this page.</p>`}
      ${p.pendingApproval ? `<div class="callout amber small">Waiting for ${esc(t.expert.name)} to review and approve what Agamya understood.</div>` : ""}
      ${p.knowledge.map((k) => `<div class="kprog"><div class="row between"><a href="#/knowledge/${k.judgmentId}"><b>${esc(k.title)}</b></a>${masteryTag(k.status)}</div>
        <div class="row small">${k.apply ? `<span>New case: ${k.apply.finalCorrect ? "✓" : "✗"}${k.apply.hints ? ` after ${k.apply.hints} hint(s)` : ""}</span>` : `<span class="muted">New case: not attempted</span>`} · ${k.counterfactual ? `<span>Counterexample: ${k.counterfactual.boundaryUnderstood ? "✓ knew the rule didn't apply" : k.counterfactual.overgeneralized ? "✗ applied the rule where it doesn't hold" : "✗"}</span>` : `<span class="muted">Counterexample: not attempted</span>`}</div>
        ${k.gaps.length ? `<div class="small"><b>Gaps:</b> ${k.gaps.map(esc).join("; ")}</div>` : ""}
        ${k.uncertain.length ? `<details class="small"><summary>${k.uncertain.length} open question(s) in the knowledge itself</summary><ul>${k.uncertain.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></details>` : ""}</div>`).join("")}
      ${p.knowledge.length ? `<p class="honest">"Demonstrated in simulation" means the learner made the expert's decision on a new case and recognised a counterexample. It is evidence of understanding, not verified on-the-job proficiency.</p>` : ""}
      ${t.role === "learner" && p.knowledge.length ? `<a class="btn primary" href="#/learn" data-act="tp-learn" data-wf="${t.workflowId}">${icon("learn", 15)} Practise now</a>` : ""}
    </section>
  </div>`;
}

function startBlock(t) {
  if (!wfDetail || wfDetail.id !== t.workflowId) return `<span class="thinking small">Loading capture options</span>`;
  const srcs = wfDetail.capture_sources.concat(wfDetail.capture_sources.includes("manual") ? [] : ["manual"]);
  startSel.source = srcs.includes(startSel.source) ? startSel.source : srcs[0];
  const sim = wfDetail.simSources.find((x) => x.id === startSel.source);
  if (sim && !sim.cases.some((c) => c.id === startSel.caseRef)) startSel.caseRef = sim.cases[0].id;
  const label = (s) => wfDetail.simSources.find((x) => x.id === s)?.label ?? { "live:screen": "Live screen capture", "live:camera": "Live camera", manual: "Narration / typed steps" }[s] ?? s;
  return `<div class="divider"></div><label class="field">Observe through<select id="tp-source">${srcs.map((s) => `<option value="${s}" ${s === startSel.source ? "selected" : ""}>${esc(label(s))}</option>`).join("")}</select></label>
    ${sim ? `<label class="field">Task<select id="tp-case">${sim.cases.map((c) => `<option value="${c.id}" ${c.id === startSel.caseRef ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select></label><p class="small muted">Simulated feed: it goes through the same capture, storage and analysis path as real capture.</p>` : ""}
    <div><button class="primary" data-act="tp-start" ${state.busy ? "disabled" : ""}>${icon("capture", 15)} I understand, start the session</button></div>`;
}

export async function transfersClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "tp-create") {
    if (!plan.expert || !plan.learner) return toast("Choose an expert and a learner.", true);
    if (!draft("tp-purpose")) return toast("Describe the purpose; the expert will see it.", true);
    const when = draft("tp-when");
    return act("plan", async () => {
      const r = await api("POST", "/api/transfers", { workflowId: plan.workflowId, expertPersonId: plan.expert, learnerPersonId: plan.learner, purpose: draft("tp-purpose"), scheduledFor: when ? new Date(when).toISOString() : null });
      state.drafts["tp-purpose"] = ""; state.drafts["tp-when"] = ""; list = null; go(`#/transfers/${r.id}`);
    });
  }
  if (a === "tp-start") return act("start", async () => { const s = await api("POST", `/api/transfers/${detail.id}/start`, { source: startSel.source, caseRef: startSel.caseRef ?? undefined }); setWorkflow(detail.workflowId); detail = null; go(`#/session/${s.id}`); });
  if (a === "tp-status") { if (!confirm("Cancel this transfer?")) return; return act("status", async () => { await api("POST", `/api/transfers/${detail.id}/status`, { status: t.dataset.v }); detail = null; list = null; }); }
  if (a === "tp-learn") setWorkflow(t.dataset.wf);
}

export function transfersChange(e) {
  const t = e.target;
  if (t.id === "tp-wf") { plan.workflowId = t.value; return; }
  if (t.id === "tp-expert") { plan.expert = t.value || null; return; }
  if (t.id === "tp-learner") { plan.learner = t.value || null; return; }
  if (t.id === "tp-source") { startSel.source = t.value; startSel.caseRef = null; return render(); }
  if (t.id === "tp-case") { startSel.caseRef = t.value; }
}
