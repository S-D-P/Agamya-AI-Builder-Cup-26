// LEARNER PROGRESS: per learner, per piece of approved knowledge in the selected workflow. Demonstrated transfer, not
// content consumed. Status comes from decisions on a new case and a counterexample; gaps from the evaluation.
import { api, esc, render, toast, workflow, has } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { masteryTag } from "./transfers.js";

let data = null;
export function invalidateProgress() { data = null; }

export function progressView() {
  const w = workflow();
  if (!w) return `<div class="card pad">No workflow yet.</div>`;
  if (!data || data.wf !== w.id) { api("GET", `/api/progress?workflow=${w.id}`).then((p) => { data = { wf: w.id, p }; render(); }).catch((e) => { data = { wf: w.id, error: e.message }; render(); toast(e.message, true); }); return `<span class="thinking">Loading progress</span>`; }
  if (data.error) return `<div class="card pad">${icon("lock", 16)} ${esc(data.error)}</div>`;
  const p = data.p;
  const counts = { demonstrated_in_simulation: 0, needs_supervision: 0, in_progress: 0, not_started: 0 };
  for (const l of p.learners) for (const i of l.items) counts[i.status]++;
  return `<div class="page-head"><div><div class="eyebrow">${esc(p.workflow.name)}</div><h1>${has("LEARNER") && !has("ORG_ADMIN", "WORKFLOW_OWNER", "REVIEWER") ? "My progress" : "Learner progress"}</h1>
      <p>For each piece of approved knowledge: did the learner make the expert's decision in a new case, and did they recognise a case where the rule does not apply?</p></div></div>
    ${!p.knowledgeCount ? `<div class="card empty">${orb("observing", 72)}<p>No approved, shared knowledge in this workflow yet.</p></div>` : `
    <div class="tiles" style="margin-bottom:14px">${Object.entries(counts).map(([k, n]) => `<div class="signal"><span class="v">${n}</span><span class="k">${masteryTag(k)}</span></div>`).join("")}</div>
    <div class="table-wrap" role="region" aria-label="Learner progress" tabindex="0"><table class="t"><thead><tr><th>Learner</th><th>Knowledge</th><th>Status</th><th>New case</th><th>Counterexample</th><th>Gaps</th></tr></thead><tbody>
      ${p.learners.flatMap((l) => l.items.map((i, n) => `<tr>${n === 0 ? `<td rowspan="${l.items.length}"><b>${esc(l.learner.name)}</b></td>` : ""}<td><a href="#/knowledge/${i.judgmentId}">${esc(i.title)}</a><div class="small muted">from ${esc(i.expertName)}</div></td>
        <td>${masteryTag(i.status)}</td><td>${i.apply ? `${i.apply.finalCorrect ? "✓" : "✗"}${i.apply.hints ? ` <span class="small muted">${i.apply.hints} hint(s)</span>` : ""}` : '<span class="muted">—</span>'}</td>
        <td>${i.counterfactual ? (i.counterfactual.boundaryUnderstood ? "✓" : i.counterfactual.overgeneralized ? "✗ overgeneralized" : "✗") : '<span class="muted">—</span>'}</td>
        <td class="small">${i.gaps.map(esc).join("; ") || '<span class="muted">none recorded</span>'}</td></tr>`)).join("")}</tbody></table></div>`}
    <p class="honest" style="margin-top:12px">${esc(p.note)}</p>`;
}
