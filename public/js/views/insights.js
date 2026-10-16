// INSIGHTS: transfer (by ground-truth source), experiments, AI cost and efficiency, knowledge risk, gaps, engine log.
import { state, api, esc, render, act, workflow, fmt, pct, usd, has, ago } from "../core.js";
import { icon } from "../icons.js";
import { signal, bars, GT_COPY } from "../components.js";

let tab = "transfer", data = null;

async function load() {
  const w = workflow();
  const [metrics, cost, inf, insights, exps] = await Promise.all([
    api("GET", `/api/analytics/metrics?workflow=${w.id}`), api("GET", "/api/analytics/cost"), api("GET", "/api/analytics/inferences?limit=60"),
    api("GET", `/api/workflows/${w.id}/insights`), api("GET", `/api/workflows/${w.id}/experiments`),
  ]);
  data = { wf: w.id, metrics, cost, inf, insights, exps };
  render();
}

export function insightsView() {
  if (!has("ORG_ADMIN", "WORKFLOW_OWNER", "REVIEWER")) return `<div class="card pad">${icon("lock", 16)} Insights are available to admins, workflow owners and reviewers.</div>`;
  if (!workflow()) return `<div class="card pad">No workflow in this space yet. Insights appear after the first captured session. Measured outcomes are also on the <a href="#/impact">Impact</a> page.</div>`;
  if (!data || data.wf !== workflow().id) { load(); return `<span class="thinking">Gathering evidence</span>`; }
  const tabs = [["transfer", "Transfer"], ["cost", "AI cost & efficiency"], ["risk", "Knowledge risk"], ["gaps", "Gaps & conflicts"], ["log", "Engine log"]];
  return `<div class="page-head"><div><div class="eyebrow">${esc(workflow().name)}</div><h1>Insights</h1><p>Measured, with the method and limits stated next to every number.</p></div>
    <div class="seg" role="group" aria-label="Insight sections">${tabs.map(([k, l]) => `<button aria-pressed="${tab === k}" data-act="tab" data-v="${k}">${l}</button>`).join("")}</div></div>
    ${({ transfer, cost, risk, gaps, log })[tab]()}`;
}

function transfer() {
  const k = data.metrics.knowledge, t = data.metrics.transfer;
  const hv = t.humanValidated;
  return `<div class="tiles">${signal(fmt(k.knowledgeCaptured), "knowledge captured", "good")}${signal(fmt(k.exceptionsCaptured), "exceptions (in the expert's words)")}${signal(fmt(k.boundariesConfirmed), "boundaries confirmed")}
      ${signal(pct(t.transferRate), `transfer rate · n=${t.startedWrong ?? 0}`, "pink")}${signal(pct(t.boundaryUnderstanding), `boundary understanding · n=${t.counterfactualAttempts ?? 0}`, "good")}${signal(pct(t.overgeneralizationRate), `overgeneralization · n=${t.counterfactualAttempts ?? 0}`, t.overgeneralizationRate ? "risk" : "")}
      ${signal(`${pct(t.initialAccuracy)} → ${pct(t.finalAccuracy)}`, `initial → final accuracy · n=${t.attempts ?? 0}`)}${signal(fmt(t.attempts), "learner attempts")}${signal(fmt(k.questionsAsked), "questions asked of experts")}${signal(fmt(k.sessionsWithoutInterruption), "sessions with no interruption")}</div>
    <p class="honest" style="margin-top:12px">Transfer rate = learners who started wrong and reached the expert's decision ÷ learners who started wrong. Boundary understanding = counterfactual cases answered right on the first try. Overgeneralization = applying the expert's special rule where its condition does not hold. n is the number of attempts behind each percentage; small samples are illustrative, not evidence.</p>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="card pad"><h2>By ground-truth source</h2><p class="small muted">Model-derived tests are never presented as validated accuracy.</p>
        <table class="t" style="margin-top:8px"><tr><th>Source</th><th>Attempts</th><th>Transfer</th><th>Boundary</th><th>Overgen.</th></tr>
        ${Object.entries(t.byGroundTruth).map(([g, x]) => `<tr><td>${esc(GT_COPY[g])}</td><td>${x.attempts}</td><td>${pct(x.transferRate)}</td><td>${pct(x.boundaryUnderstanding)}</td><td>${pct(x.overgeneralizationRate)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No attempts yet</td></tr>`}</table>
        <p class="small" style="margin-top:8px"><b>Human-validated ground truth:</b> ${hv.attempts ? `${hv.attempts} attempts, transfer ${pct(hv.transferRate)}` : "none yet. Have experts or reviewers validate tests to produce defensible accuracy."}</p></section>
      <section class="card pad stack"><h2>Does captured judgment beat the SOP?</h2>
        <p class="small muted">Controlled experiment: learners are assigned to <b>SOP only</b> (documentation-grounded hints) or <b>SOP + captured judgment</b>. Immediate and delayed-retest results are reported per arm.</p>
        ${data.exps.length ? data.exps.map((e) => `<div class="callout"><b>${esc(e.name)}</b> <span class="tag ${e.status === "running" ? "pink" : ""}">${esc(e.status)}</span> · retest after ${e.retest_after_days} days<p class="small muted">${esc(e.hypothesis)}</p>
          ${e.results ? `<table class="t" style="margin-top:6px"><tr><th>Arm</th><th>Phase</th><th>Attempts</th><th>Initial acc.</th><th>Final acc.</th><th>Boundary</th></tr>${Object.entries(e.results).flatMap(([arm, r]) => ["immediate", "retest"].map((ph) => `<tr><td>${esc(arm.replace(/_/g, " ").toLowerCase())}</td><td>${ph}</td><td>${r[ph].attempts}</td><td>${pct(r[ph].initialAccuracy)}</td><td>${pct(r[ph].finalAccuracy)}</td><td>${pct(r[ph].boundaryUnderstanding)}</td></tr>`)).join("")}</table>` : '<p class="small muted">No learners assigned yet.</p>'}</div>`).join("")
          : `<p class="small">No experiment running.</p>`}
        ${has("ORG_ADMIN", "WORKFLOW_OWNER") ? `<div><button class="sm" data-act="experiment">${icon("split", 14)} Start an SOP-vs-judgment experiment</button></div>` : ""}
        <p class="honest">No study has been run yet. This instrument exists so the claim "learners improve over documentation alone" can be tested with human-reviewed ground truth rather than asserted.</p></section></div>`;
}

function cost() {
  const c = data.cost;
  const b = c.benchmarks?.[0];
  const naive = b?.summary?.find((x) => x.pipeline === "naive"), comp = b?.summary?.find((x) => x.pipeline === "compressed");
  return `<div class="tiles">${signal(fmt(c.calls), "AI calls (30 days)")}${signal(fmt(c.inputTokens), "input tokens")}${signal(fmt(c.outputTokens), "output tokens")}${signal(fmt(c.imageTokens), "image tokens")}
      ${signal(usd(c.estimatedCostUsd), "estimated cost")}${signal(usd(c.costPerSession), "cost / session")}${signal(usd(c.costPerValidatedJudgment), "cost / validated judgment", "good")}${signal(c.validatedPer100kTokens ?? "—", "validated judgments / 100k tokens")}</div>
    <p class="honest" style="margin-top:10px">Costs are estimates from token counts × list-price assumptions (${usd(c.pricing.input)}/M input, ${usd(c.pricing.output)}/M output). Month to date: ${usd(c.monthToDateUsd)} of a ${usd(c.monthlyBudgetUsd)} budget${c.budgetBlocked ? `; ${c.budgetBlocked} call(s) blocked by the budget` : ""}.</p>
    <div class="grid cols-2" style="margin-top:14px">
      <section class="card pad stack"><h2>Naive context vs optimized context</h2>
        ${b ? `${bars(b.summary.map((x) => ({ ...x, label: x.pipeline })), { valueKey: "tokensPerSession", labelKey: "label", winner: "compressed" })}
          <table class="t"><tr><th>Pipeline</th><th>Tokens/session</th><th>Image tokens</th><th>Cost/session</th><th>Recall</th><th>False alarms</th></tr>${b.summary.map((x) => `<tr><td>${esc(x.pipeline)}</td><td>${fmt(x.tokensPerSession)}</td><td>${fmt(x.imageTokensPerSession)}</td><td>${usd(x.costPerSession)}</td><td>${esc(x.judgmentRecall)}</td><td>${esc(x.falseAlarms)}</td></tr>`).join("")}</table>
          ${naive && comp ? `<p><b>${Math.round((1 - comp.tokensPerSession / naive.tokensPerSession) * 100)}% fewer tokens per session</b> with optimized context.</p>` : ""}
          <p class="honest">${esc(b.notes)} Run ${ago(b.created_at)} on ${esc(b.model)}.</p>` : `<p class="muted">No benchmark recorded. Run <code>npm run benchmark</code>.</p>`}</section>
      <section class="card pad stack"><h2>Where the tokens go</h2>
        ${bars(c.byOp.map((x) => ({ ...x, tokens: Number(x.tokens) })), { valueKey: "tokens", labelKey: "op", winner: "" })}
        <details class="small"><summary>Context budget profile per operation</summary><table class="t" style="margin-top:6px">${Object.entries(c.operationProfiles).map(([op, p]) => `<tr><td><b>${esc(op)}</b></td><td>${esc(p.levels.join(" · "))}</td><td>${esc(p.pixels)}</td></tr>`).join("")}</table></details></section></div>`;
}

function risk() {
  const rows = data.metrics.risk.filter((r) => r.level !== "unknown");
  return `<section class="card pad" style="max-width:900px"><h2>Knowledge risk</h2><p class="small muted">Critical knowledge held by one expert with no trained successor is a single point of failure.</p>
    ${rows.map((r) => `<div class="risk-row"><span class="dot ${r.level === "red" ? "red" : r.level === "yellow" ? "amber" : "green"}"></span><div><b>${esc(r.area)}</b><div class="small muted">${r.criticalJudgments} critical judgment(s) · ${r.experts} expert(s) hold it · ${r.trainedSuccessors} trained successor(s)</div></div>
      <span class="tag ${r.level === "red" ? "red" : r.level === "yellow" ? "amber" : "green"}">${r.level === "red" ? "at risk" : r.level === "yellow" ? "thin coverage" : "covered"}</span></div>`).join("") || `<p class="muted">No captured knowledge yet.</p>`}
    <p class="honest" style="margin-top:10px">A trained successor has transferred every lesson in the area and answered every counterfactual correctly on the first try.</p></section>`;
}

function gaps() {
  const g = data.insights;
  return `<div class="grid cols-2"><section class="card pad stack"><h2>Documentation gaps</h2>${g.gaps.map((x) => `<div class="callout"><div class="row between"><b>${esc(x.gap_type.replace(/_/g, " "))}</b><span class="tag ${x.status === "confirmed" ? "green" : "amber"}">${esc(x.status)}</span></div><p class="small">${esc(x.title)}</p><p class="small muted">Documented: ${esc(x.documented_procedure)} · Observed: ${esc(x.observed_behavior)}</p></div>`).join("") || '<p class="muted">None found.</p>'}</section>
    <section class="card pad stack"><h2>Expert disagreements</h2>${g.conflicts.map((x) => `<div class="callout"><div class="row between"><b>${esc(x.a)} vs ${esc(x.b)}</b><span class="tag ${x.status === "resolved" ? "green" : "red"}">${esc(x.status)}</span></div><p class="small">Hidden variable: ${esc(x.hidden_variable)}</p></div>`).join("") || '<p class="muted">None.</p>'}</section></div>`;
}

function log() {
  return `<section class="card pad"><h2>Engine log</h2><p class="small muted">Every model operation: inputs by type, the context levels it was given, tokens, latency, status. Content is not logged.</p>
    <div class="table-wrap" style="margin-top:10px" role="region" aria-label="Inference log" tabindex="0"><table class="t"><tr><th>When</th><th>Operation</th><th>Inputs</th><th>Context given</th><th>In / out tokens</th><th>Image</th><th>ms</th><th>Status</th><th>Result</th></tr>
    ${data.inf.map((e) => `<tr><td>${new Date(e.created_at).toLocaleTimeString()}</td><td><b>${esc(e.op)}</b></td><td>${esc((e.input_types ?? []).join("+"))}${e.media_items ? ` ×${e.media_items}` : ""}${e.media_resolution ? ` @${esc(e.media_resolution.replace("MEDIA_RESOLUTION_", "").toLowerCase())}` : ""}</td>
      <td class="small">${esc(e.context_manifest ? Object.entries(e.context_manifest).filter(([k]) => !["op", "profile"].includes(k)).map(([k, v]) => `${k}=${v}`).join(", ") : "")}</td><td>${fmt(e.prompt_tokens)} / ${fmt(e.output_tokens + e.thought_tokens)}</td><td>${fmt(e.tokens_by_modality?.IMAGE ?? 0)}</td><td>${fmt(e.latency_ms)}</td>
      <td><span class="tag ${e.status === "ok" ? "green" : "red"}">${esc(e.status === "ok" ? "ok" : e.error_category ?? e.status)}</span></td><td class="small">${esc(e.result_summary ?? "")}</td></tr>`).join("")}</table></div></section>`;
}

export function insightsClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "tab") { tab = t.dataset.v; return render(); }
  if (t.dataset.act === "experiment") return act("exp", async () => { await api("POST", `/api/workflows/${workflow().id}/experiments`, { retestAfterDays: 14 }); data = null; });
}
export function invalidateInsights() { data = null; }
