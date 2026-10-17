// KNOWLEDGE LOSS RADAR: for each workflow, what is at risk, what records say so, and what to do next.
// Status comes from explicit rules over real records. There is no score, ranking or prediction, and when
// there are not enough records the status says "insufficient evidence" instead of guessing.
import { requestButton } from "./access.js";
import { api, esc, render, toast, isSample } from "../core.js";
import { icon } from "../icons.js";
import { t } from "../i18n.js";

let data = null;
const STATUS = {
  insufficient_evidence: ["Insufficient evidence", "", "question", "Not enough records to say whether this knowledge is safe."],
  at_risk: ["At risk", "red", "alert", "Approved knowledge depends on one person, or its exceptions are not recorded."],
  needs_attention: ["Needs attention", "amber", "clock", "Some knowledge is incomplete, unreviewed or not yet practised."],
  covered: ["Covered", "green", "validate", "Approved, with exceptions recorded, and demonstrated in simulation by someone other than the expert."],
};

export function radarView() {
  if (!data) { api("GET", "/api/radar").then((d) => { data = d; render(); }).catch((e) => { data = { error: e.message, workflows: [] }; render(); toast(e.message, true); }); return `<span class="thinking">Reading the records</span>`; }
  if (data.error) return `<div class="card pad">${icon("lock", 16)} ${esc(data.error)}</div>`;
  const order = ["at_risk", "needs_attention", "insufficient_evidence", "covered"];
  const rows = [...data.workflows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const counts = Object.fromEntries(order.map((k) => [k, rows.filter((r) => r.status === k).length]));
  return `<div class="page-head"><div><div class="eyebrow">Continuity</div><h1>${t("Knowledge at risk")}</h1>
    <p>For each workflow: what could be lost, which records say so, and the next step. Built only from records in this workspace. There is no score and no prediction.</p></div></div>
    ${isSample() ? `<div class="callout small" role="note">${icon("alert", 14)} <b>Sample data.</b> These records come from the sample space's scripted workflows, not from a real team.</div>` : ""}
    <ul class="radar-summary" aria-label="Workflows by status">${order.map((k) => `<li><span class="tag ${STATUS[k][1]}">${icon(STATUS[k][2], 12)} ${STATUS[k][0]}</span> <b>${counts[k]}</b></li>`).join("")}</ul>
    <div class="stack">${rows.map(card).join("") || `<div class="card pad">No workflows yet.</div>`}</div>
    <details class="card pad small" style="margin-top:16px"><summary><b>How status is decided</b></summary><ul>${order.map((k) => `<li><b>${STATUS[k][0]}:</b> ${STATUS[k][3]}</li>`).join("")}</ul><p class="muted">${esc(data.rules)}</p></details>`;
}

function card(w) {
  const [label, tone, ic, why] = STATUS[w.status];
  const f = w.facts;
  return `<article class="card pad stack" aria-labelledby="rw-${w.workflow.id}">
    <div class="row between wrap"><h2 id="rw-${w.workflow.id}">${esc(w.workflow.name)}</h2><span class="tag ${tone}">${icon(ic, 12)} ${label}</span></div>
    <p class="small muted">${esc(why)}</p>
    <dl class="kv small radar-facts"><dt>Documents</dt><dd>${f.documents}</dd><dt>Capture sessions</dt><dd>${f.sessions}</dd><dt>Approved knowledge</dt><dd>${f.approved}${f.privateApproved ? ` (${f.privateApproved} private)` : ""}</dd>
      <dt>People holding it</dt><dd>${f.holders}</dd><dt>Experts / learners</dt><dd>${f.experts} / ${f.learners}</dd></dl>
    ${w.findings.length ? `<div class="stack">${w.findings.map((x) => `<section class="finding" aria-label="${esc(x.label)}"><h3 class="small">${esc(x.label)} <span class="muted">(${x.count})</span></h3>
      <ul class="plain small">${x.records.map((r) => `<li>${r.judgmentId ? `<a href="#/knowledge/${r.judgmentId}">${esc(r.title)}</a>` : `${esc(r.title)} ${requestButton(r.requestArtifactId)}`}${r.expertName ? ` · ${esc(r.expertName)}` : ""}${r.learner ? ` · learner ${esc(r.learner)}` : ""}${r.detail ? `: <span class="muted">${esc(r.detail)}</span>` : ""}</li>`).join("")}</ul>
      <p class="small"><b>Next:</b> ${x.action.href ? `<a href="#/${esc(x.action.href)}">${esc(x.action.label)}</a>` : esc(x.action.label)}</p></section>`).join("")}</div>`
      : w.status === "insufficient_evidence" ? `<p class="small"><b>Next:</b> <a href="#/capture">Capture how an expert does this work</a></p>` : ""}
  </article>`;
}
export function invalidateRadar() { data = null; }
