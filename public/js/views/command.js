// AGAMYA FOR WORK, home: what the organization knows, which transfers are under way, where knowledge is at risk.
// Every number here is computed from real records; nothing is illustrative.
import { state, api, esc, render, fmt, has, setWorkflow, go } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { signal } from "../components.js";
import { STAGE } from "./transfers.js";

let data = null, loading = false;

async function load() {
  loading = true;
  const [summary, transfers] = await Promise.all([api("GET", "/api/analytics/summary").catch(() => null), api("GET", "/api/transfers").catch(() => [])]);
  data = { summary, transfers, at: Date.now() };
  loading = false;
  render();
}

export function commandView() {
  if ((!data || Date.now() - data.at > 15000) && !loading) load();
  const s = data?.summary, k = s?.knowledge, tr = data?.transfers ?? [];
  const open = tr.filter((t) => !["cancelled"].includes(t.stage) && t.status === "scheduled");
  const demonstrated = tr.reduce((n, t) => n + (t.demonstrated ?? 0), 0);
  const loop = [["observe", "Observe"], ["spark", "Notice judgment"], ["question", "Ask why"], ["validate", "Expert approves"], ["split", "Find the boundary"], ["teach", "Test transfer"]];
  return `<section class="hero">
      <div><div class="eyebrow">${esc(state.me.org?.name)} · Agamya for Work</div>
        <h1>Keep the judgment, not just the procedure.</h1>
        <p>When an experienced colleague hands over a workflow, Agamya captures the decisions the manual doesn't cover, has the expert confirm them, and checks that the next person can apply them, including when not to.</p>
        <div class="loop" role="group" aria-label="The knowledge lifecycle">${loop.map(([i, l], n) => `${n ? `<span class="loop-arrow" aria-hidden="true">${icon("arrow", 13)}</span>` : ""}<span class="loop-step">${icon(i, 13)} ${l}</span>`).join("")}</div></div>
      ${orb(k?.awaitingValidation ? "curious" : "observing", 96)}
    </section>
    <h2 class="sr-only">Signals</h2>
    <div class="signals four" style="margin-top:16px">
      ${signal(k ? fmt(k.knowledgeCaptured) : "…", "pieces of approved knowledge", "good", "Judgments approved by the expert who taught them")}
      ${signal(data ? fmt(open.length) : "…", "open knowledge transfers")}
      ${signal(data ? fmt(demonstrated) : "…", "demonstrated in simulation", "", "A learner made the expert's decision on a new case and recognised a counterexample")}
      ${signal(s ? fmt(s.atRisk) : "…", "areas held by one person", s?.atRisk ? "risk" : "", "Approved knowledge held by a single expert with no learner who has demonstrated it")}
    </div>
    <div class="grid cols-2" style="margin-top:22px">
      <section class="card pad stack"><div class="row between"><h2>Knowledge transfers</h2><a class="btn sm" href="#/transfers">${has("ORG_ADMIN", "WORKFLOW_OWNER") ? "Plan or view" : "View"} ${icon("arrow", 14)}</a></div>
        ${tr.length ? tr.slice(0, 4).map((t) => `<a class="mini-transfer" href="#/transfers/${t.id}"><span><b>${esc(t.expert.name)}</b> → <b>${esc(t.learner.name)}</b><span class="small muted"> · ${esc(t.workflowName)}</span></span><span class="tag ${STAGE[t.stage]?.[1] ?? ""}">${esc(STAGE[t.stage]?.[0] ?? t.stage)}</span></a>`).join("") : `<p class="small muted">No transfers yet.</p>`}</section>
      <section class="card pad stack"><div class="row between"><h2>Workflows</h2>${has("ORG_ADMIN", "WORKFLOW_OWNER") ? `<a class="btn sm" href="#/workflows/new">${icon("plus", 14)} New</a>` : ""}</div>
        ${state.workflows.map((w) => { const r = s?.risk?.find((x) => x.workflowId === w.id); return `<button class="mini-transfer" data-act="open-wf" data-id="${w.id}"><span><b>${esc(w.name)}</b><span class="small muted"> · ${w.knowledge} approved · ${w.experts} expert(s)</span></span>${r && r.level !== "unknown" ? `<span class="row small"><span class="dot ${r.level === "red" ? "red" : r.level === "yellow" ? "amber" : "green"}"></span>${r.level === "red" ? "single holder" : r.level === "yellow" ? "thin coverage" : "covered"}</span>` : ""}</button>`; }).join("") || `<p class="small muted">No workflows yet.</p>`}</section>
    </div>`;
}

export function workflowCard(w) {
  const mods = [["screen", "screen", "Screen"], ["camera", "camera", "Camera"], ["microphone", "mic", "Voice"], ["app_events", "event", "App events"], ["documents", "doc", "Docs"]].filter(([k]) => w.modalities?.[k]);
  return `<article class="card wf-card" data-act="open-wf" data-id="${w.id}">
    <div class="row between"><span class="eyebrow">${esc(w.kind)} work${w.source === "demo" ? " · sample" : ""}</span>${has("ORG_ADMIN", "WORKFLOW_OWNER", "KT_COORDINATOR") ? `<button class="ghost sm danger" data-act="delete-skill" data-id="${w.id}" data-name="${esc(w.name)}">Delete</button>` : ""}</div>
    <h2 class="wf-title"><button class="link" data-act="open-wf" data-id="${w.id}">${esc(w.name)}</button></h2>
    <p class="small muted">${esc(w.description)}</p>
    <div class="mods">${mods.map(([, i, l]) => `<span class="mod">${icon(i, 12)} ${l}</span>`).join("")}</div>
    <dl class="kv"><dt>Experts</dt><dd>${w.experts}</dd><dt>Approved knowledge</dt><dd>${w.knowledge}</dd><dt>Experts with approved knowledge</dt><dd>${w.knowledge_holders}</dd></dl>
    ${w.status === "learning" ? `<span class="thinking small">Reading the documentation</span>` : ""}
  </article>`;
}

export function commandClick(e) {
  const t = e.target.closest("[data-act]");
  if (t?.dataset.act === "open-wf") { setWorkflow(t.dataset.id); go(`#/workflows/${t.dataset.id}`); }
}
export function invalidateCommand() { data = null; }
