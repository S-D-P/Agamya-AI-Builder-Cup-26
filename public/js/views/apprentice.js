// LESSONS: a situation you have not seen, your reasoning, progressive hints, then a nearby case where the expert's
// rule should NOT apply. Answers are never shown up front. Correctness is decided against the approved answer key,
// not by the model; the model only coaches.
import { askToShareBlock } from "./access.js";
import { state, api, esc, render, act, go, draft, workflow, has, poll, toast, isLiving, setWorkflow } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { gt, GT_COPY } from "../components.js";
import { DraftRecorder } from "../capture.js";
import { t, tp, langAttr } from "../i18n.js";
import { announce } from "../a11y.js";
import { askPanel, askClick } from "./ask.js";

const ESCALATE = "__ask_expert__";
const KIND = { apply: ["New case", "New situation"], counterfactual: ["Nearby case", "Nearby case: does the expert's rule apply here?"], boundary: ["Boundary case", "Boundary case: has the signal gone past the point that matters?"], insufficient: ["Missing information", "Can you decide from what you know?"] };
// Simulation outcomes only. These are never certification or authorisation to do the real work.
const OUTCOME = { demonstrated_in_simulation: ["Demonstrated in simulation", "green", "validate"], needs_further_practice: ["Needs further practice", "amber", "clock"], requires_supervision: ["Requires supervision", "red", "alert"] };
const choiceLabel = (c) => (c === ESCALATE ? tp("Stop and ask the expert") : c);
let recorder = null, transcribing = false;

let lessons = null, attempt = null;
const visuals = new Map();

export function apprenticeView(r) {
  const w = workflow();
  if (!has("LEARNER", "WORKFLOW_OWNER", "ORG_ADMIN")) return `<div class="card pad">${icon("lock", 16)} Lessons are for learners.</div>`;
  if (!w) return `<div class="card pad">Nothing to learn yet.</div>`;
  if (!lessons || lessons.wf !== w.id) { load(w.id); return `<span class="thinking">Loading lessons</span>`; }
  if (r.id && (!attempt || attempt.id !== r.id)) { api("GET", `/api/attempts/${r.id}`).then((a) => { attempt = a; render(); }).catch((e) => toast(e.message, true)); }
  if (lessons.rows.some((l) => l.generating)) poll(`lessons-${w.id}`, async () => { await load(w.id); return lessons.rows.some((l) => l.generating); }, 2000);
  const living = isLiving();
  return `<div class="page-head"><div><div class="eyebrow">${esc(w.name)}</div>${r.id ? `<h1>Practice case</h1>` : `<h2>Practice cases and Ask</h2>`}<p>You'll meet situations you haven't seen before. I won't tell you the answer. I'll help you notice what ${living ? "your teacher" : "an experienced colleague"} would notice.</p></div>
    ${living && state.workflows.length > 1 ? `<label class="field" style="min-width:220px">Skill<select id="lv-learn-skill">${state.workflows.map((x) => `<option value="${x.id}" ${x.id === w.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : ""}</div>
  <div class="apprentice-grid">
    <div class="stack"><aside class="card pad"><div class="eyebrow">${living ? "Practice cases shared with you" : "Practice cases from approved knowledge"}</div>
      ${lessons.rows.map((l) => `<div class="lesson"><b>${esc(l.judgment.title)}</b><span class="small muted">taught by ${esc(l.judgment.expertName)}</span>
        ${l.judgment.restricted ? `<span class="tag amber" title="${esc(l.judgment.restrictionNote)}">${icon("shield", 11)} restricted${l.judgment.restrictionNote ? `: ${esc(l.judgment.restrictionNote)}` : ""}</span>` : ""}
        ${l.awaitingReview ? `<span class="small muted">Practice cases are drafted and awaiting the expert's review.</span>` : ""}
        ${l.generating ? `<span class="thinking small">Preparing practice cases</span>` : l.generationFailed ? `<span class="small" style="color:var(--red)">Could not generate a valid test; an expert can author one.</span>` : ""}
        ${l.scenarios.map((s, i) => `<button class="card lesson-step" data-act="open" data-id="${s.id}" aria-current="${attempt?.scenario?.id === s.id}">
          <span class="small"><b>${i + 1}. ${esc(KIND[s.kind]?.[0] ?? "Case")}</b></span><span class="small muted" style="grid-column:1/3">${esc(s.title)}</span>
          <span style="grid-row:1/3;grid-column:3">${s.attempt?.result ? (s.attempt.result.finalCorrect ? icon("validate", 18, "reached the expected decision") : `<span role="img" aria-label="did not reach the expected decision">✗</span>`) : s.attempt ? icon("clock", 16, "in progress") : ""}</span></button>`).join("")}
      </div>`).join("") || (living ? `<div style="margin-top:8px"><p class="small muted">Nothing has been shared with you yet.</p>${askToShareBlock()}</div>` : `<p class="small muted" style="margin-top:8px">No practice cases yet. Use the Work Maps above to practise with Moti.</p>`)}
    </aside>
    ${askPanel()}</div>
    <section class="card pad">${attempt ? attemptView(attempt) : `<div class="empty">${orb("teaching", 96)}<p>Pick a lesson to begin.</p></div>`}</section>
  </div>`;
}

async function load(wfId) { lessons = { wf: wfId, rows: await api("GET", `/api/workflows/${wfId}/lessons`) }; render(); }

function attemptView(at) {
  const s = at.scenario;
  if (s.hasVisual && !visuals.has(s.id)) { visuals.set(s.id, null); api("GET", `/api/scenarios/${s.id}/visual`).then((v) => { visuals.set(s.id, v.svg); render(); }).catch(() => {}); } // the case reads fine without its picture
  const decisions = at.steps.filter((x) => x.type === "decision");
  const hinted = at.steps.some((x) => x.type === "intervention");
  const steps = ["Scenario", "Decide", "Reason", "Hint", "Decision", "Feedback", "Transfer"];
  const now = at.status === "complete" ? 6 : hinted ? 4 : decisions.length ? 3 : 1;
  const persona = at.status === "complete" ? (at.result.finalCorrect ? "confirmed" : "teaching") : at.status === "reconsider" ? "asking" : "teaching";
  let action = "";
  if (["deciding", "reconsider"].includes(at.status)) {
    const key = `why-${at.id}-${decisions.length}`;
    action = `<h3>${at.status === "reconsider" ? "Think again: what would you do?" : "What would you do?"}</h3>
      <label class="field" for="why-${at.id}">Why? (this is how I coach you, and how I check you understand when it applies)<textarea id="why-${at.id}" data-draft="${key}" data-focus="why" rows="2"${langAttr(s.language)}></textarea></label>
      ${navigator.mediaDevices && window.MediaRecorder ? `<div class="row"><button class="sm" data-act="why-voice" data-key="${key}" aria-pressed="${Boolean(recorder)}" ${transcribing ? "disabled" : ""}>${icon("mic", 14)} ${recorder ? t("Stop recording") : "Say your reasoning"}</button>${transcribing ? `<span class="thinking small" role="status">Transcribing</span>` : state.drafts[`${key}-voice`] ? `<span class="small muted">From your voice: check the words above before choosing.</span>` : ""}</div>` : ""}
      <div class="options" role="group" aria-label="What would you do?">${s.options.map((o) => `<button class="option" data-act="choose" data-o="${esc(o)}" data-key="${key}" ${state.busy ? "disabled" : ""}>${esc(o)}</button>`).join("")}
        <button class="option escalate" data-act="choose" data-o="${ESCALATE}" data-key="${key}" ${state.busy ? "disabled" : ""}>${icon("question", 15)} ${t("Stop and ask the expert")} <span class="small muted">if you cannot decide safely from what you know</span></button></div>
      ${state.busy === "decide" ? `<span class="thinking">Thinking about your reasoning</span>` : ""}`;
  } else {
    const r = at.result;
    const o = OUTCOME[r.status];
    const ev = [...at.steps].reverse().find((x) => x.type === "decision" && x.evaluation)?.evaluation;
    action = `${o ? `<p class="outcome"><span class="tag ${o[1]}">${icon(o[2], 12)} ${t(o[0])}</span> <span class="small muted">A practice result in a simulation, not a certification to do the real work.</span></p>` : ""}
      <div class="callout ${r.finalCorrect ? "green" : "red"}"><b>${r.finalCorrect ? "You reached the expert's decision" : "Not this time"}:</b> ${esc(choiceLabel(r.finalDecision))}${r.finalCorrect ? "" : `. An experienced colleague would choose <b>${esc(choiceLabel(at.answerKey))}</b>.`}</div>
      ${r.escalatedAppropriately ? `<div class="callout green"><b>Right call to stop.</b> The deciding signal could not be seen, so asking was the careful move. That is part of the skill.</div>` : ""}
      ${r.falseConfidence ? `<div class="callout red"><b>Decided without the deciding information.</b> When the signal that decides it is missing, act only after checking or asking.</div>` : ""}
      ${ev && (ev.understood || ev.missing) ? `<div class="grid cols-2 small">
        ${ev.understood ? `<div class="callout green"><b>${t("What you understood")}</b><p${langAttr(s.language)}>${esc(ev.understood)}</p></div>` : ""}
        ${ev.missing ? `<div class="callout amber"><b>${t("What you missed")}</b><p${langAttr(s.language)}>${esc(ev.missing)}</p></div>` : ""}</div>` : ""}
      ${at.criteria?.length ? `<div class="small"><b>What the expert looks for</b> (approved criteria)<ul class="criteria">${at.criteria.map((c, i) => { const met = ev?.criteriaMet?.[i]; return `<li>${met === true ? `${icon("validate", 12)} <span class="sr-only">shown in your reasoning:</span>` : met === false ? `<span aria-hidden="true">○</span> <span class="sr-only">not shown in your reasoning:</span>` : ""}${esc(c)}</li>`; }).join("")}</ul></div>` : ""}
      ${at.support?.statements?.length ? `<div class="small stack"><b>In ${esc(at.support.expertName)}'s words</b>${at.support.statements.map((x) => `<blockquote class="quote"${langAttr(s.language)}>“${esc(x.quote || x.value)}”</blockquote>`).join("")}</div>` : ""}
      ${s.kind === "counterfactual" ? (r.overgeneralized ? `<div class="callout red"><b>Overgeneralization.</b> You applied the expert's special rule where its condition does not hold. Knowing when a rule does <i>not</i> apply is half the skill.</div>` : r.initialCorrect ? `<div class="callout green"><b>Boundary understood.</b> You recognised that the expert's exception does not apply here.</div>` : "") : ""}
      <div class="score"><div class="signal"><span class="v">${r.initialCorrect ? "✓" : "✗"}</span><span class="k">first decision</span></div><div class="signal"><span class="v">${r.interventions.length}</span><span class="k">hints used</span></div>
        <div class="signal ${r.transfer === "Successful" ? "good" : ""}"><span class="v" style="font-size:18px">${esc(r.transfer)}</span><span class="k">transfer</span></div>
        <div class="signal"><span class="v" style="font-size:18px">${s.kind === "counterfactual" ? (r.boundaryUnderstood ? "Yes" : "No") : "—"}</span><span class="k">boundary understood</span></div></div>
      ${next(at)}`;
  }
  return `<div class="row between"><div class="stepper" role="group" aria-label="Progress">${steps.map((x, i) => `<span class="step ${i < now ? "done" : i === now ? "now" : ""}">${x}</span>`).join("")}</div>${gt(s.groundTruthSource)}</div>
    <div class="row between" style="margin-top:14px"><div><div class="eyebrow">${esc(KIND[s.kind]?.[1] ?? "New situation")}${at.arm ? ` · experiment arm: ${esc(at.arm.replace(/_/g, " ").toLowerCase())}` : ""}</div><h2>${esc(s.title)}</h2></div>${orb(persona, 64, { caption: false })}</div>
    ${visuals.get(s.id) ? `<div class="viewport" style="margin:12px 0;max-width:640px">${visuals.get(s.id)}</div>` : ""}
    <dl class="facts" style="margin:12px 0">${Object.entries(s.facts ?? {}).map(([k, v]) => `<dt>${esc(human(k))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <p style="font-size:16px"${langAttr(s.language)}>${esc(s.narrative)}</p>
    <div class="qa" style="margin:14px 0">${at.steps.map((x) => x.type === "decision"
      ? `<div class="bubble human"><span class="who">${esc(at.learnerName)}</span>I would: <b>${esc(choiceLabel(x.choice))}</b>${x.reasoning ? `<div class="small">“${esc(x.reasoning)}”</div>` : ""}${x.correct && x.evaluation?.feedback ? `<div class="small muted">${esc(x.evaluation.feedback)}</div>` : ""}</div>`
      : `<div class="bubble ai"><span class="who">Agamya · ${esc(x.technique)}</span>${esc(x.message)}</div>`).join("")}</div>
    ${action}
    <p class="small faint" style="margin-top:12px">Ground truth for this test: ${esc(GT_COPY[s.groundTruthSource])}. ${s.groundTruthSource === "MODEL_DERIVED" ? "An expert or reviewer can validate it before it counts as human-validated." : ""}</p>`;
}

/** "curryLeaf" → "Curry leaf", "businessDate" → "Business date" */
const human = (k) => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (m) => m.toLowerCase());

function next(at) {
  const lesson = lessons.rows.find((l) => l.scenarios.some((s) => s.id === at.scenario.id));
  const i = lesson?.scenarios.findIndex((s) => s.id === at.scenario.id) ?? -1;
  const n = lesson?.scenarios[i + 1];
  return n ? `<button class="accent" data-act="open" data-id="${n.id}" style="margin-top:12px">Next: ${esc((KIND[n.kind]?.[0] ?? "case").toLowerCase())} ${icon("arrow", 15)}</button>` : `<a class="btn" style="margin-top:12px" href="${isLiving() ? "#/journey" : has("ORG_ADMIN", "WORKFLOW_OWNER", "REVIEWER") ? "#/insights" : "#/progress"}">See what transferred ${icon("arrow", 15)}</a>`;
}

export async function apprenticeClick(e) {
  if (await askClick(e)) return;
  const t = e.target.closest("[data-act]");
  if (!t) return;
  if (t.dataset.act === "open") return act("open", async () => { attempt = await api("POST", "/api/attempts", { scenarioId: t.dataset.id }); go(`#/learn/${attempt.id}`); });
  if (t.dataset.act === "why-voice") return whyVoice(t.dataset.key);
  if (t.dataset.act === "choose") return act("decide", async () => {
    attempt = await api("POST", `/api/attempts/${attempt.id}/decide`, { choice: t.dataset.o, reasoning: draft(t.dataset.key), expectedVersion: attempt.version });
    if (attempt.status === "complete") { await load(workflow().id); announce(`Done. ${attempt.result?.finalCorrect ? "You reached the expert's decision." : "Not this time."} ${OUTCOME[attempt.result?.status]?.[0] ?? ""}`); }
    else announce("Not yet. A hint has been added; think again.");
  });
}
async function whyVoice(key) {
  if (recorder) {
    const r = recorder; recorder = null; transcribing = true; render();
    try { const out = await r.stop(attempt?.scenario?.language); if (out.text) { state.drafts[key] = [state.drafts[key], out.text].filter(Boolean).join(" "); state.drafts[`${key}-voice`] = state.drafts[key]; announce("Transcript ready. Check it, then choose."); } else toast("No speech was heard.", true); }
    catch (err) { toast(err.message, true); } finally { transcribing = false; render(); document.querySelector('[data-focus="why"]')?.focus(); }
    return;
  }
  try { recorder = new DraftRecorder(); await recorder.start(); announce("Recording. Press the button again to stop."); render(); } catch { recorder = null; toast("Microphone unavailable. You can type instead.", true); }
}
export function invalidateApprentice() { lessons = null; attempt = null; }
document.addEventListener("change", (e) => { if (e.target.id === "lv-learn-skill") { setWorkflow(e.target.value); invalidateApprentice(); render(); } });
