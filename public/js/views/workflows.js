// Workflows as first-class objects: list, clean creation, detail (what the AI learned from the documents, people, actions).
import { state, api, esc, render, act, go, draft, has, poll, setWorkflow, toast } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { workflowCard } from "./command.js";

let detail = null, people = null;
const form = { kind: "physical", inputs: { camera: true, microphone: true, documents: true, screen: false, app_events: false }, sources: ["sim:loom-camera"], files: [], experts: new Set(), learners: new Set() };

export function workflowsView(r) {
  if (r.id === "new") return createView();
  if (r.id) return detailView(r.id);
  return `<div class="page-head"><div><h1>Workflows</h1><p>Each one is configuration: what to observe, what is documented, who knows it, who is learning it.</p></div>
    ${has("ORG_ADMIN", "WORKFLOW_OWNER") ? `<a class="btn primary" href="#/workflows/new">${icon("plus", 15)} New workflow</a>` : ""}</div>
    <div class="wf-grid">${state.workflows.map(workflowCard).join("")}</div>`;
}

// ---------------------------------------------------------------- create
function createView() {
  if (!has("ORG_ADMIN", "WORKFLOW_OWNER")) return `<div class="card pad">You need the workflow owner role to create workflows.</div>`;
  if (!people) { people = "loading"; api("GET", "/api/people").then((p) => { people = p; render(); }).catch(() => { people = []; render(); }); }
  if (people === "loading") return `<span class="thinking">Loading</span>`;
  const inputs = [["screen", "screen", "Screen"], ["camera", "camera", "Camera"], ["microphone", "mic", "Microphone"], ["documents", "doc", "Documents"], ["app_events", "event", "Application events"]];
  const sources = [["live:screen", "Live screen"], ["live:camera", "Live camera"], ["manual", "Narration / typed steps"], ["sim:loom-camera", "Loom camera (simulated)"], ["sim:kitchen-camera", "Kitchen camera (simulated)"], ["sim:payments-console", "Mainframe console (simulated)"], ["sim:revenue-sheet", "Spreadsheet (simulated)"]];
  const pick = (set, kind) => people.map((p) => `<button class="chip" aria-pressed="${set.has(p.id)}" data-act="pick" data-kind="${kind}" data-id="${p.id}">${esc(p.display_name)}</button>`).join("");
  return `<div class="page-head"><div><div class="eyebrow">New workflow</div><h1>Teach the platform a new kind of work</h1><p>No code and no prompts: describe it, choose what may be observed, add the documentation, choose people.</p></div></div>
  <div class="card pad stack" style="max-width:920px">
    <div class="grid cols-2"><label class="field">Name<input data-draft="nw-name" data-focus="nw-name" placeholder="Payment exception handling"></label>
      <label class="field">Kind of work<div class="seg" role="group" aria-label="Kind of work">${["software", "physical", "document", "hybrid"].map((k) => `<button aria-pressed="${form.kind === k}" data-act="kind" data-v="${k}">${k}</button>`).join("")}</div></label></div>
    <label class="field">Description<textarea data-draft="nw-desc" rows="2" placeholder="How the operations team handles unusual payment cases."></textarea></label>
    <div><div class="eyebrow" style="margin-bottom:6px">What may be observed</div><div class="row">${inputs.map(([k, i, l]) => `<button class="chip" aria-pressed="${form.inputs[k]}" data-act="input" data-k="${k}">${icon(i, 14)} ${l}</button>`).join("")}</div></div>
    <div><div class="eyebrow" style="margin-bottom:6px">Observe through</div><div class="row">${sources.map(([k, l]) => `<button class="chip" aria-pressed="${form.sources.includes(k)}" data-act="source" data-k="${k}">${esc(l)}</button>`).join("")}</div></div>
    <div><div class="eyebrow" style="margin-bottom:6px">Documentation</div>
      <label class="card pad" style="display:flex;align-items:center;gap:12px;cursor:pointer;border-style:dashed">${icon("doc", 22)}<span><b>Add SOPs, runbooks or guides</b><br><span class="small muted">Text, Markdown or PDF · checked by file signature · PDFs with active content are rejected</span></span><input type="file" id="nw-files" multiple accept=".txt,.md,.pdf,text/plain,application/pdf" class="sr-only"></label>
      <div class="row small" style="margin-top:8px">${form.files.map((f) => `<span class="tag">${icon("doc", 12)} ${esc(f.title)}</span>`).join("")}<button class="ghost sm" data-act="sample">Use sample: Studio Weaving Guide</button></div></div>
    <div class="grid cols-2"><div><div class="eyebrow" style="margin-bottom:6px">Experts</div><div class="row">${pick(form.experts, "experts")}</div></div>
      <div><div class="eyebrow" style="margin-bottom:6px">Learners</div><div class="row">${pick(form.learners, "learners")}</div></div></div>
    <div class="row"><button class="primary" data-act="create" ${state.busy ? "disabled" : ""}>${icon("spark", 15)} Start learning</button>${state.busy === "create" ? `<span class="thinking">Saving securely</span>` : ""}</div>
  </div>`;
}

// ---------------------------------------------------------------- detail
function detailView(id) {
  if (!detail || detail.id !== id) {
    api("GET", `/api/workflows/${id}`).then((d) => { detail = d; render(); }).catch((e) => { toast(e.message, true); go("#/workflows"); });
    return `<span class="thinking">Loading workflow</span>`;
  }
  const w = detail;
  if (w.status === "learning") poll(`wf-${id}`, async () => { detail = await api("GET", `/api/workflows/${id}`); render(); return detail.status === "learning"; }, 1500);
  const experts = w.people.filter((p) => p.participation === "EXPERT"), learners = w.people.filter((p) => p.participation === "LEARNER");
  const p = w.profile ?? {};
  return `<div class="page-head"><div><div class="eyebrow">${esc(w.kind)} work · ${w.source === "demo" ? "sample workflow" : "created here"}</div><h1>${esc(w.name)}</h1><p>${esc(w.description)}</p></div>
    <div class="row">${has("EXPERT") ? `<a class="btn primary" href="#/capture">${icon("capture", 15)} Capture expertise</a>` : ""}${has("ORG_ADMIN", "WORKFLOW_OWNER") ? `<a class="btn" href="#/transfers/new">${icon("users", 15)} Plan a transfer</a>` : ""}${has("EXPERT", "WORKFLOW_OWNER", "REVIEWER", "ORG_ADMIN") ? `<a class="btn" href="#/knowledge">${icon("knowledge", 15)} Knowledge</a>` : ""}${has("LEARNER") ? `<a class="btn" href="#/learn">${icon("learn", 15)} Lessons</a>` : ""}</div></div>
  ${w.status === "learning" ? `<div class="card pad row">${orb("learning", 64)}<div><b>Reading the documentation to understand this new domain</b><p class="small muted">Gemini extracts the documented procedures as written and notes where unwritten knowledge is likely.</p></div></div>` : ""}
  <div class="grid cols-2" style="margin-top:12px">
    <section class="card pad stack"><h2>What I understood</h2><p>${esc(p.domainSummary ?? "")}</p>
      ${w.procedures.map((pr) => `<div class="callout"><b>${esc(pr.title)}</b> <span class="tag ${pr.source === "curated" ? "sky" : "green"}">${pr.source === "curated" ? "curated" : "from document"}</span><div class="small muted">Default: ${esc(pr.default_decision)}</div><ol class="small">${pr.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>`).join("")}
      ${p.likelyTacitAreas?.length ? `<div><div class="eyebrow">Where unwritten knowledge is likely</div><ul class="small">${p.likelyTacitAreas.slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${p.suspiciousInstructions?.length ? `<div class="callout amber small">${icon("shield", 14)} The documents contained text that tried to instruct the AI. It was treated as data and ignored.</div>` : ""}</section>
    <section class="card pad stack"><h2>People</h2>
      <div><div class="eyebrow">Experts</div>${experts.map((x) => `<div class="row small"><span class="avatar">${esc(x.display_name[0])}</span>${esc(x.display_name)} <span class="muted">${esc(x.title)}</span></div>`).join("") || '<p class="small muted">None</p>'}</div>
      <div><div class="eyebrow">Learners</div>${learners.map((x) => `<div class="row small"><span class="avatar">${esc(x.display_name[0])}</span>${esc(x.display_name)} <span class="muted">${esc(x.title)}</span></div>`).join("") || '<p class="small muted">None</p>'}</div>
      <div><div class="eyebrow">Documents</div>${w.documents.map((d) => `<div class="row small">${icon("doc", 14)} ${esc(d.title)} ${(d.injection_flags ?? []).length ? `<span class="tag amber" title="${esc(d.injection_flags.join(", "))}">${icon("shield", 12)} instructions to the AI detected</span>` : ""}</div>`).join("")}</div>
      <div><div class="eyebrow">Inputs</div><div class="row">${Object.entries(w.modalities).filter(([, v]) => v).map(([k]) => `<span class="mod">${esc(k.replace("_", " "))}</span>`).join("")}</div></div></section>
  </div>`;
}

export async function workflowsClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "open-wf") { setWorkflow(t.dataset.id); return go(`#/workflows/${t.dataset.id}`); }
  if (a === "kind") { form.kind = t.dataset.v; return render(); }
  if (a === "input") { form.inputs[t.dataset.k] = !form.inputs[t.dataset.k]; return render(); }
  if (a === "source") { const k = t.dataset.k; form.sources = form.sources.includes(k) ? form.sources.filter((x) => x !== k) : [...form.sources, k]; return render(); }
  if (a === "pick") { const set = form[t.dataset.kind]; set.has(t.dataset.id) ? set.delete(t.dataset.id) : set.add(t.dataset.id); return render(); }
  if (a === "sample") {
    form.files = [{ title: "Studio Weaving Guide", text: await (await fetch("/samples/studio-weaving-guide.md")).text() }];
    state.drafts["nw-name"] ||= "Studio weaving: cotton warp";
    state.drafts["nw-desc"] ||= "How our master weaver keeps cotton warps from breaking.";
    return render();
  }
  if (a === "create") {
    if (!draft("nw-name")) return toast("Give the workflow a name.", true);
    if (!form.files.length) return toast("Add at least one document so the documented procedure can be learned.", true);
    return act("create", async () => {
      const w = await api("POST", "/api/workflows", { name: draft("nw-name"), description: draft("nw-desc"), kind: form.kind, modalities: form.inputs, captureSources: form.sources, documents: form.files, expertPersonIds: [...form.experts], learnerPersonIds: [...form.learners] });
      state.workflows = await api("GET", "/api/workflows");
      setWorkflow(w.id); detail = null; form.files = []; state.drafts["nw-name"] = ""; state.drafts["nw-desc"] = "";
      go(`#/workflows/${w.id}`);
    });
  }
}

export async function workflowsChange(e) {
  if (e.target.id !== "nw-files") return;
  for (const f of e.target.files) {
    if (f.size > 10_000_000) { toast(`${f.name} is larger than 10 MB`, true); continue; }
    if (f.type === "application/pdf") {
      const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(f); });
      form.files.push({ title: f.name, dataBase64: b64 });
    } else form.files.push({ title: f.name, text: await f.text() });
  }
  render();
}
export function invalidateWorkflow() { detail = null; }
