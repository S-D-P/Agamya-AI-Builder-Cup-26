// MISSING KNOWLEDGE DETECTIVE + JUDGMENT STRESS TEST REVIEW, shown inside a piece of knowledge.
// Detective loop: gap (with evidence) → targeted question → the contributor answers (typed or spoken, always reviewed)
// → AI proposes a change → the contributor approves → new version → gaps re-evaluated. Nothing the AI writes becomes
// knowledge without that approval; a gap can also be left unresolved, deferred or marked not applicable.
// Stress test: generated cases are drafts until the contributor (or a workplace reviewer) approves case, answer and criteria.
import { state, api, esc, render, act, draft, poll, toast, ago } from "../core.js";
import { icon } from "../icons.js";
import { DraftRecorder } from "../capture.js";
import { t, tp, langSelect, langAttr, langName, uiLang, originalAndTranslation } from "../i18n.js";
import { announce } from "../a11y.js";

const gapsCache = new Map(), testsCache = new Map(), voice = { gapId: null, rec: null, busy: false };
const FIELD_LABEL = { context: "Context", observation: "Observation", decision: "Decision", reason: "Reason", condition: "Condition", exception: "Exception", boundary: "Boundary", risk: "Risk", expectedOutcome: "Outcome" };
const KIND_LABEL = {
  prerequisite: "Missing prerequisite", signal: "Undefined signal, threshold or condition", unexplained_action: "Unexplained action", rationale: "Missing reason",
  exception: "Unrecorded exception or boundary", contradiction: "Contradiction", assumption: "Unsupported assumption", escalation: "When to escalate",
};
// Status is always written out in words (and an icon), never conveyed by colour alone.
const STATUS = {
  open: ["Unresolved: needs the expert", "amber", "question"], answered: ["Answered: change awaiting approval", "sky", "clock"],
  resolved: ["Expert-confirmed", "green", "validate"], accepted_unresolved: ["Accepted as unresolved", "", "question"],
  deferred: ["Deferred", "", "clock"], not_applicable: ["Not applicable", "", "eyeoff"],
};
const BASIS = { AI_INFERRED: "Found by AI (an inference, not a fact)", RULE: "Found by rule: this field has no supporting evidence" };

export function invalidateDetective(judgmentId) { if (judgmentId) { gapsCache.delete(judgmentId); testsCache.delete(judgmentId); } else { gapsCache.clear(); testsCache.clear(); } }

// ---------------------------------------------------------------- gaps
async function loadGaps(id) { gapsCache.set(id, await api("GET", `/api/judgments/${id}/gaps`)); render(); }

export function gapsPanel(j) {
  if (!gapsCache.has(j.id)) { gapsCache.set(j.id, null); loadGaps(j.id).catch(() => gapsCache.set(j.id, { gaps: [], error: true })); }
  const g = gapsCache.get(j.id);
  if (!g) return `<section class="card pad" aria-labelledby="gaps-h"><h3 id="gaps-h">${icon("question", 15)} ${t("Missing knowledge")}</h3><span class="thinking small">Looking for what is missing</span></section>`;
  if (g.analyzing || g.gaps.some((x) => x.status === "answered" && !x.proposal)) poll(`gaps-${j.id}`, async () => { await loadGaps(j.id); const n = gapsCache.get(j.id); return n.analyzing || n.gaps.some((x) => x.status === "answered" && !x.proposal); }, 1500);
  const open = g.gaps.filter((x) => ["open", "answered"].includes(x.status)), done = g.gaps.filter((x) => !["open", "answered"].includes(x.status));
  return `<section class="card pad stack" aria-labelledby="gaps-h">
    <div class="row between"><h3 id="gaps-h">${icon("question", 15)} ${t("Missing knowledge")} <span class="tag ${open.length ? "amber" : "green"}">${open.length} open</span></h3>
      ${g.gaps.some((x) => x.canAnswer) ? `<button class="sm ghost" data-act="gaps-reanalyze" data-j="${j.id}" ${state.busy || g.analyzing ? "disabled" : ""}>Look again</button>` : ""}</div>
    <p class="small muted">What a newcomer would still need to know to make this decision. Each item shows the evidence it rests on. AI-found gaps are suggestions; only ${j.isMine ? "your" : `${esc(j.expertName)}'s`} approved answers change the knowledge.</p>
    ${g.analyzing ? `<span class="thinking small">Analysing the capture for missing knowledge</span>` : ""}
    ${g.error ? `<div class="callout small">Could not load missing-knowledge checks.</div>` : ""}
    ${open.map((x) => gapCard(j, x)).join("") || (g.analyzing ? "" : `<p class="small">${icon("validate", 14)} Nothing open. ${done.length ? "Earlier gaps are listed below." : "No missing knowledge was found in this capture."}</p>`)}
    ${done.length ? `<details class="small"><summary>${done.length} closed or set aside</summary><div class="stack" style="margin-top:8px">${done.map((x) => gapCard(j, x)).join("")}</div></details>` : ""}
  </section>`;
}

function gapCard(j, g) {
  const [label, tone, ic] = STATUS[g.status] ?? [g.status, "", "question"];
  const field = j.content.fields?.[g.field];
  const key = `gap-${g.id}`;
  let body = "";
  if (g.status === "open" && g.canAnswer) {
    const recording = voice.gapId === g.id && voice.rec;
    body = `<div class="stack">
      <label class="field" for="${key}">${t("Your answer")}<textarea id="${key}" data-draft="${key}" data-focus="${key}" rows="3" aria-describedby="${key}-q ${key}-hint"${langAttr(state.drafts[`${key}-lang`] ?? g.questionLanguage)}></textarea></label>
      <span id="${key}-hint" class="small muted">In your own words, in whichever language you think in. ${state.drafts[`${key}-voice`] ? "This text came from your voice: check and correct it before sending." : ""}</span>
      <div class="row wrap">${langSelect(`${key}-lang`, state.drafts[`${key}-lang`] ?? g.questionLanguage ?? "en", t("Answer language"))}
        ${navigator.mediaDevices && window.MediaRecorder ? `<button class="sm" data-act="gap-voice" data-id="${g.id}" aria-pressed="${Boolean(recording)}" ${voice.busy ? "disabled" : ""}>${icon("mic", 14)} ${recording ? t("Stop recording") : t("Speak your answer")}</button>` : ""}
        ${voice.busy && voice.gapId === g.id ? `<span class="thinking small" role="status">Transcribing</span>` : ""}</div>
      <div class="row wrap"><button class="primary sm" data-act="gap-answer" data-id="${g.id}" ${state.busy ? "disabled" : ""}>${t("Send answer")}</button>
        <button class="sm ghost" data-act="gap-decide" data-v="accept_unresolved" data-id="${g.id}">${t("Leave unresolved")}</button>
        <button class="sm ghost" data-act="gap-decide" data-v="defer" data-id="${g.id}">${t("Defer")}</button>
        <button class="sm ghost" data-act="gap-decide" data-v="not_applicable" data-id="${g.id}">${t("Not applicable")}</button></div></div>`;
  } else if (g.status === "answered") {
    const p = g.proposal;
    body = `${answerBlock(g)}${p ? `<div class="stack"><div class="eyebrow">Proposed change to “${esc(FIELD_LABEL[p.field] ?? p.field)}”${g.proposalSource === "fallback" ? " · recorded as written (AI unavailable)" : " · drafted by AI from your answer"}</div>
      <div class="diff"><div><span class="eyebrow">${t("Before")}</span><div${field?.value ? "" : ' class="muted"'}>${field?.value ? esc(field.value) : "Not captured"}</div></div>
        <div><span class="eyebrow">${t("After")}</span><div${langAttr(g.answerLanguage)}>${esc(p.value)}</div>${p.valueEn && g.answerLanguage !== "en" ? `<div class="small muted"><span class="eyebrow">AI translation (not your words)</span> <span lang="en">${esc(p.valueEn)}</span></div>` : ""}</div></div>
      ${p.quote ? `<div class="small">Quoted from your answer: <q${langAttr(g.answerLanguage)}>${esc(p.quote)}</q> ${p.quoteVerified ? `<span class="tag green">${icon("validate", 11)} quote matches your words</span>` : `<span class="tag red">quote not found in your answer</span>`}</div>` : ""}
      ${p.explanation ? `<div class="small muted">${esc(p.explanation)}</div>` : ""}
      ${p.replacesExpertStated ? `<div class="callout amber small" role="note"><b>This replaces something you already said</b> in "${esc(FIELD_LABEL[p.field] ?? p.field)}". Check the before and after: approve only if the new wording is what you mean. Otherwise reject the change and the gap stays open.</div>` : ""}
      ${p.resolves ? "" : `<div class="callout amber small">The AI does not think this fully answers the question; the gap will stay open after the change.</div>`}
      ${g.canAnswer ? `<div class="row wrap"><button class="primary sm" data-act="gap-decide" data-v="approve" data-id="${g.id}" ${state.busy || !p.quoteVerified ? "disabled" : ""}>${icon("validate", 14)} ${t("Approve change")}</button>
        <button class="sm" data-act="gap-decide" data-v="reject_proposal" data-id="${g.id}">${t("Reject change")}</button></div>` : `<p class="small muted">Waiting for ${esc(j.expertName)} to approve.</p>`}</div>`
      : `<span class="thinking small">Preparing the proposed change from the answer</span>`}`;
  } else if (g.status !== "open") {
    body = `${g.answer ? answerBlock(g) : ""}
      ${g.status === "resolved" ? `<p class="small">${icon("validate", 13)} ${g.appliedVersion ? `Applied in version ${g.appliedVersion}.` : "No longer missing."}${g.decidedAt ? ` ${ago(g.decidedAt)}` : ""}</p>` : ""}
      ${g.decisionNote && g.status !== "resolved" ? `<p class="small muted">Note: ${esc(g.decisionNote)}</p>` : ""}
      ${g.canAnswer && g.status !== "resolved" ? `<button class="sm ghost" data-act="gap-decide" data-v="reopen" data-id="${g.id}">${t("Reopen")}</button>` : ""}`;
  } else body = `<p class="small muted">Waiting for ${esc(j.expertName)} to answer.</p>`;

  return `<article class="gap card pad stack" aria-labelledby="${key}-h">
    <div class="row between wrap"><h4 id="${key}-h">${esc(KIND_LABEL[g.kind] ?? g.kind)} <span class="muted" style="font-weight:500">· ${esc(FIELD_LABEL[g.field] ?? g.field ?? "")}</span></h4>
      <span class="tag ${tone}">${icon(ic, 11)} ${esc(label)}</span></div>
    <dl class="kv small"><dt>${t("What is missing")}</dt><dd>${esc(g.missing)}</dd><dt>${t("Why it matters")}</dt><dd>${esc(g.whyItMatters)}</dd>
      <dt>Found by</dt><dd>${esc(BASIS[g.basis] ?? g.basis)}</dd>
      <dt>${t("Evidence")}</dt><dd>${g.evidence.length ? `<ul class="plain">${g.evidence.map((e) => `<li><button class="link" data-act="evidence" data-session="${j.sessionId}" data-at="${esc(e.capturedAt)}">${esc(e.alias)} · ${esc(e.modality.toLowerCase())}</button> ${e.deleted ? "(media deleted)" : esc(clip(e.text, 140))}</li>`).join("")}</ul>` : g.basis === "RULE" ? "None: that is the gap" : "—"}</dd></dl>
    <div class="question"><span class="eyebrow">${t("Question for the expert")}${g.questionLanguage && g.questionLanguage !== uiLang() ? ` · ${esc(langName(g.questionLanguage))}` : ""}</span><p id="${key}-q"${langAttr(g.questionLanguage)}>${esc(g.question)}</p></div>
    ${body}</article>`;
}

function answerBlock(g) {
  const src = { typed: "typed", voice: "spoken (transcript unchanged)", voice_corrected: "spoken, then corrected by the speaker" }[g.answerSource] ?? "";
  return `<div class="small stack"><span class="eyebrow">Answer${src ? ` · ${src}` : ""}${g.answeredAt ? ` · ${ago(g.answeredAt)}` : ""}</span>
    ${originalAndTranslation({ original: g.answer, originalLang: g.answerLanguage })}
    ${g.answerOriginal && g.answerOriginal !== g.answer ? `<details><summary>Machine transcript before correction</summary><div${langAttr(g.answerLanguage)}>${esc(g.answerOriginal)}</div></details>` : ""}</div>`;
}
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };

// ---------------------------------------------------------------- stress test review
const TEST_KIND = { apply: "Ordinary case", counterfactual: "Counterexample", boundary: "Boundary case", insufficient: "Insufficient evidence" };
export const ESCALATE = "__ask_expert__";

export function testsPanel(j) {
  const mayReview = j.isMine || (j.experience !== "living" && state.me.roles.some((r) => ["REVIEWER", "WORKFLOW_OWNER", "ORG_ADMIN"].includes(r)));
  if (!mayReview || j.status !== "approved") return "";
  if (!testsCache.has(j.id)) { testsCache.set(j.id, null); api("GET", `/api/judgments/${j.id}/scenarios`).then((r) => { testsCache.set(j.id, r); render(); }).catch(() => testsCache.set(j.id, { scenarios: [], error: true })); }
  const r = testsCache.get(j.id);
  if (!r) return "";
  if (r.generating) poll(`tests-${j.id}`, async () => { const n = await api("GET", `/api/judgments/${j.id}/scenarios`); testsCache.set(j.id, n); render(); return n.generating; }, 2000);
  const drafts = r.scenarios.filter((s) => s.reviewStatus === "draft");
  return `<section class="card pad stack" aria-labelledby="tests-h">
    <div class="row between"><h3 id="tests-h">${icon("learn", 15)} Judgment stress test</h3><span class="tag ${drafts.length ? "amber" : "green"}">${drafts.length ? `${drafts.length} awaiting your review` : "reviewed"}</span></div>
    <p class="small muted">Practice cases for learners: an ordinary case, a boundary case, a counterexample where the rule should not apply, and a case where the deciding information is missing, so the right move is to stop and ask. Learners only see cases you approve, and are judged only against the expected answer and criteria you approve.</p>
    ${r.generating ? `<span class="thinking small">Drafting cases from the approved knowledge</span>` : ""}${r.failed ? `<div class="callout small">Could not draft valid cases. They can be authored by hand.</div>` : ""}
    ${r.scenarios.map((s) => testCard(s)).join("")}</section>`;
}

function testCard(s) {
  const key = `crit-${s.id}`;
  if (state.drafts[key] === undefined) state.drafts[key] = (s.criteria ?? []).join("\n");
  const keyDraft = `key-${s.id}`;
  if (state.drafts[keyDraft] === undefined) state.drafts[keyDraft] = s.answerKey;
  const draftCase = s.reviewStatus === "draft";
  const keyLabel = (k) => (k === ESCALATE ? tp("Stop and ask the expert") : k);
  return `<article class="card pad stack small" aria-labelledby="t-${s.id}">
    <div class="row between wrap"><h4 id="t-${s.id}">${esc(TEST_KIND[s.kind] ?? s.kind)}: ${esc(s.title)}</h4>
      <span class="tag ${draftCase ? "amber" : "green"}">${draftCase ? "Draft: not shown to learners" : `${icon("validate", 11)} Approved`}</span></div>
    <p${langAttr(s.language)}>${esc(s.narrative)}</p>
    <dl class="facts">${Object.entries(s.facts ?? {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${draftCase ? `<label class="field" for="${keyDraft}">Expected answer<select id="${keyDraft}" data-draft="${keyDraft}">${[...s.options, ESCALATE].map((o) => `<option value="${esc(o)}" ${o === state.drafts[keyDraft] ? "selected" : ""}>${esc(keyLabel(o))}</option>`).join("")}</select></label>
      <label class="field" for="${key}">What a good answer shows (one per line)<textarea id="${key}" data-draft="${key}" rows="3"></textarea></label>
      <div class="row"><button class="primary sm" data-act="test-review" data-id="${s.id}" data-v="1" ${state.busy ? "disabled" : ""}>${icon("validate", 14)} Approve for learners</button><button class="sm" data-act="test-review" data-id="${s.id}" data-v="0">Reject</button></div>`
      : `<div><b>Expected answer:</b> ${esc(keyLabel(s.answerKey))}</div>${s.criteria?.length ? `<div><b>A good answer shows</b><ul>${s.criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>` : ""}`}
  </article>`;
}

// ---------------------------------------------------------------- events
export async function detectiveClick(e, j, refresh) {
  const el = e.target.closest("[data-act]");
  if (!el) return false;
  const a = el.dataset.act, id = el.dataset.id;
  if (a === "gaps-reanalyze") { act("gaps", async () => { await api("POST", `/api/judgments/${el.dataset.j}/gaps/reanalyze`); await loadGaps(j.id); announce("Looking for missing knowledge again."); }); return true; }
  if (a === "gap-voice") { gapVoice(id); return true; }
  if (a === "gap-answer") {
    const key = `gap-${id}`, text = draft(key);
    if (!text) { toast("Write or speak an answer first.", true); document.getElementById(key)?.focus(); return true; }
    const v = state.drafts[`${key}-voice`];
    act("gap-answer", async () => {
      await api("POST", `/api/gaps/${id}/answer`, { text, language: state.drafts[`${key}-lang`] ?? undefined, source: v ? (v.trim() === text ? "voice" : "voice_corrected") : "typed", original: v || undefined });
      delete state.drafts[key]; delete state.drafts[`${key}-voice`];
      await loadGaps(j.id); announce("Answer sent. A proposed change is being prepared for your approval.");
    });
    return true;
  }
  if (a === "gap-decide") {
    const v = el.dataset.v;
    act("gap-decide", async () => {
      const r = await api("POST", `/api/gaps/${id}/decide`, { action: v });
      gapsCache.set(j.id, { ...gapsCache.get(j.id), gaps: r.gaps ?? gapsCache.get(j.id).gaps });
      if (v === "approve") { const n = await refresh(); announce(`Change approved and saved as version ${n?.currentVersion ?? "next"}.`); }
      else announce({ reject_proposal: "Change rejected; the gap is open again.", accept_unresolved: "Left unresolved.", defer: "Deferred.", not_applicable: "Marked not applicable.", reopen: "Reopened." }[v] ?? "Saved.");
      await loadGaps(j.id);
    });
    return true;
  }
  if (a === "test-review") {
    const approve = el.dataset.v === "1";
    act("test-review", async () => {
      await api("POST", `/api/scenarios/${id}/review`, approve ? { approve, answerKey: state.drafts[`key-${id}`], criteria: (state.drafts[`crit-${id}`] ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6) } : { approve });
      testsCache.set(j.id, await api("GET", `/api/judgments/${j.id}/scenarios`));
      announce(approve ? "Case approved. Learners can now practise it." : "Case rejected.");
    });
    return true;
  }
  return false;
}
export function detectiveChange(e) {
  const m = e.target.id?.match(/^gap-(.+)-lang$/);
  if (m) { state.drafts[e.target.id] = e.target.value; render(); return true; }
  return false;
}

async function gapVoice(id) {
  const key = `gap-${id}`;
  if (voice.rec && voice.gapId === id) {
    const rec = voice.rec; voice.rec = null; voice.busy = true; render();
    try {
      const r = await rec.stop(state.drafts[`${key}-lang`]);
      if (!r.speechPresent || !r.text) { toast("No speech was heard. Try again or type your answer.", true); return; }
      state.drafts[key] = [state.drafts[key], r.text].filter(Boolean).join(" ");
      state.drafts[`${key}-voice`] = state.drafts[key];
      if (r.language && ["en", "mr"].includes(r.language)) state.drafts[`${key}-lang`] = r.language;
      announce("Transcript ready. Check and correct it before sending.");
    } catch (err) { toast(err.message, true); } finally { voice.busy = false; render(); document.getElementById(key)?.focus(); }
    return;
  }
  try { voice.rec = new DraftRecorder(); voice.gapId = id; await voice.rec.start(); announce("Recording. Press the button again to stop."); render(); }
  catch { voice.rec = null; toast("Microphone unavailable. You can type your answer instead.", true); }
}
