// IMPACT: what Agamya measurably did in this space (from its own records; no estimates). Empty states say why.
import { api, esc, render, isLiving } from "../core.js";

let data = null;
export function invalidateImpact() { data = null; }

const n = (x, unit = "") => (x == null ? `<span class="muted">not enough data yet</span>` : `${esc(String(x))}${unit}`);
const tile = (value, label, note = "") => `<div class="impact-tile"><div class="impact-n">${value}</div><div class="impact-l">${esc(label)}</div>${note ? `<div class="small muted">${esc(note)}</div>` : ""}</div>`;

export function impactView() {
  if (!data) { data = "loading"; api("GET", "/api/impact").then((d) => { data = d; render(); }).catch((e) => { data = { error: e.message }; render(); }); }
  if (data === "loading") return `<span class="thinking">Measuring</span>`;
  if (data.error) return `<p class="callout">${esc(data.error)}</p>`;
  const d = data, expert = isLiving() ? "teacher" : "expert";
  return `<div class="page-head"><div><h1>Impact</h1><p>What Agamya did in this space, counted from its own records. Nothing here is estimated or projected.</p></div></div>
  <section class="impact-sec" aria-labelledby="im-cap"><h2 id="im-cap" class="h3">Capturing how work is done</h2><div class="impact-grid">
    ${tile(n(d.capture.expertMinutes, " min"), `${expert} time captured`, `${d.capture.liveSessions} live session${d.capture.liveSessions === 1 ? "" : "s"}`)}
    ${tile(n(d.capture.questionsAsked), "questions Moti asked", `${d.capture.questionsAnswered} answered`)}
    ${tile(n(d.capture.questionsPer10Min), "questions per 10 minutes", "target 3–5: ask less, later")}
    ${tile(n(d.capture.debriefQuestions), "debrief questions")}</div></section>
  <section class="impact-sec" aria-labelledby="im-map"><h2 id="im-map" class="h3">Work Maps</h2><div class="impact-grid">
    ${tile(n(d.workMaps.confirmed), "confirmed by the expert", `${d.workMaps.drafts} draft${d.workMaps.drafts === 1 ? "" : "s"}, ${d.workMaps.debriefed} debriefed`)}
    ${tile(n(d.workMaps.steps), "steps documented", `${d.workMaps.judgmentCalls} judgment calls`)}
    ${tile(n(d.workMaps.guardrails), "guardrails (limits, exceptions, stop-and-ask)")}
    ${tile(n(d.workMaps.inExpertsWordsPct, "%"), `of reasons and guardrails in the ${expert}'s own words`, "the rest is labelled AI-inferred")}
    ${tile(n(d.workMaps.medianMinutesToConfirmed, " min"), "median time from first capture to a confirmed map")}</div></section>
  <section class="impact-sec" aria-labelledby="im-pr"><h2 id="im-pr" class="h3">Passing it on</h2><div class="impact-grid">
    ${tile(n(d.practice.runs), "practice sessions", `${d.practice.learners} learner${d.practice.learners === 1 ? "" : "s"}, ${d.practice.finished} finished`)}
    ${tile(n(d.practice.stops), "wrong decisions stopped before they happened", d.practice.stopsPerRun == null ? "" : `${d.practice.stopsPerRun} per session`)}
    ${tile(d.practice.repeatedPractice ? `${d.practice.fewerStopsOnRepeat} of ${d.practice.repeatedPractice}` : n(null), "learners needing fewer stops on their latest attempt", "same learner, same map")}
    ${tile(d.languages.length ? esc(d.languages.join(", ")) : n(null), "languages used")}</div></section>
  <section class="impact-sec" aria-labelledby="im-ag"><h2 id="im-ag" class="h3">AI agents following the ${expert}'s guardrails</h2><div class="impact-grid">
    ${tile(n(d.agents.checks), "actions checked by agents", `${d.agents.connectedAgents} connected agent${d.agents.connectedAgents === 1 ? "" : "s"}`)}
    ${tile(n(d.agents.handedToPerson), "decisions handed back to a person (stop or ask)")}
    ${tile(n(d.agents.notCovered), "situations the map does not cover (a person was asked)")}
    ${tile(n(d.agents.medianCheckMs, " ms"), "median check time")}</div></section>
  <section class="impact-sec" aria-labelledby="im-ai"><h2 id="im-ai" class="h3">AI cost (Gemini on Vertex AI)</h2><div class="impact-grid">
    ${tile(n(d.ai.costUsd == null ? null : `$${d.ai.costUsd}`), "total recorded AI cost", `${d.ai.calls} model calls; live voice $${d.ai.liveCostUsd ?? 0}`)}
    ${tile(n(d.ai.costPerConfirmedMapUsd == null ? null : `$${d.ai.costPerConfirmedMapUsd}`), "AI cost per confirmed Work Map")}</div>
    <p class="small muted">Costs are list-price estimates recorded per call (token counts × published prices), not an invoice.</p></section>`;
}
