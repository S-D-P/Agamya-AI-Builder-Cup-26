// CAPTURE SESSION: consent → capture → timeline → judgment moment → question → answer → structured judgment → validation.
// Same screen for both experiences; words change (expert/teacher, organization/space) and so do sharing defaults.
import { state, api, esc, render, act, go, draft, poll, stop, toast, workflow, fmt, usd, isLiving, setWorkflow } from "../core.js";
import { icon, MOD_ICON } from "../icons.js";
import { orb } from "../persona.js";
import { judgmentChain, boundaryCard, docTriad, conflictCard, evidenceStrip, openEvidence, statusChip, levels, srcTag } from "../components.js";
import { VisualCapture, VoiceCapture, AnswerRecorder, speak } from "../capture.js";
import { langSelect, langAttr, langName, uiLang, t as tr } from "../i18n.js";
import { announce } from "../a11y.js";

let S = null, J = null, wfDetail = null, wfLoading = null;
let visual = null, voice = null, answerRec = null, videoEl = null, editing = false, lastSpoken = null;
const setup = { source: null, caseRef: null };
const BUSY = new Set(["processing", "analyzing", "extracting"]);

// ---------------------------------------------------------------- start screen
export function captureView() {
  const w = workflow();
  if (!w) return `<div class="card pad">No workflow selected.</div>`;
  if (!wfDetail || wfDetail.id !== w.id) {
    if (wfLoading !== w.id) { wfLoading = w.id; api("GET", `/api/workflows/${w.id}`).then((d) => { wfDetail = d; }).catch((e) => { toast(e.message, true); wfDetail = { id: w.id, procedures: [], documents: [], people: [] }; }).finally(() => { wfLoading = null; render(); }); }
    return `<span class="thinking">Loading</span>`;
  }
  const srcs = wfDetail.capture_sources.concat(wfDetail.capture_sources.includes("manual") ? [] : ["manual"]);
  setup.source = srcs.includes(setup.source) ? setup.source : srcs[0];
  const sim = wfDetail.simSources.find((x) => x.id === setup.source);
  if (sim && !sim.cases.some((c) => c.id === setup.caseRef)) setup.caseRef = sim.cases[0].id;
  const label = (s) => wfDetail.simSources.find((x) => x.id === s)?.label ?? { "live:screen": "Screen recording with narration", "live:camera": "Audio + video (camera)", "live:audio": "Audio recording", manual: "Text, documents and typed steps" }[s] ?? s;
  return `<div class="page-head"><div><div class="eyebrow">${esc(w.name)}</div><h1>Capture expertise</h1><p>Work normally. Agamya stays quiet, looks back at natural breaks, and asks only when a decision depended on judgment. To capture as part of a planned handover, start from <a href="#/transfers">Knowledge transfers</a>.</p></div></div>
  <div class="card pad stack" style="max-width:820px">
    <div class="row">${orb("observing", 60)}<p class="muted">You will see exactly what is captured and agree to it before anything starts. You can pause, exclude an input, or delete any moment at any time.</p></div>
    ${langSelect("cap-lang", setup.language ?? uiLang(), "Language you will speak", { hint: " · Agamya asks its questions in this language and keeps your words as you say them; you can mix in English terms" })}
    <label class="field" for="cap-source">Observe through<select id="cap-source">${srcs.map((s) => `<option value="${s}" ${s === setup.source ? "selected" : ""}>${esc(label(s))}</option>`).join("")}</select></label>
    ${sim ? `<label class="field" for="cap-case">Task<select id="cap-case">${sim.cases.map((c) => `<option value="${c.id}" ${c.id === setup.caseRef ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select></label>
      <p class="small muted">${esc(sim.label)}: a simulated feed that goes through the same capture → storage → asynchronous processing path as real capture.</p>` : ""}
    <div><button class="primary" data-act="start" ${state.busy ? "disabled" : ""}>${icon("capture", 15)} Start session</button></div>
  </div>`;
}

// ---------------------------------------------------------------- session screen
export function sessionView(r) {
  if (!S || S.id !== r.id) { load(r.id); return `<span class="thinking">Opening session</span>`; }
  if (BUSY.has(S.status) || S.processing?.pending) poll(`sess-${S.id}`, async () => { await load(S.id, true); return BUSY.has(S.status) || S.processing?.pending > 0; }, 1200);
  if (S.status === "asking" && lastSpoken !== S.question?.text && S.isMine) { lastSpoken = S.question.text; speak(S.question.text); }
  return `${head()}${S.status === "awaiting_consent" ? consentCard() : ""}
    <div class="session-grid" style="margin-top:14px"><section class="card stage" aria-label="Work surface">${stage()}</section><section class="card" aria-label="Observation timeline">${timeline()}</section></div>
    <section class="card" style="margin-top:14px" aria-label="Conversation and structured judgment">${conversation()}</section>
    <section class="card budget" style="margin-top:14px" aria-label="Context budget">${budget()}</section>`;
}

async function load(id, quiet = false) {
  try {
    S = await api("GET", `/api/sessions/${id}`);
    if (S.workflowId && S.workflowId !== state.workflowId) setWorkflow(S.workflowId);
    if (S.judgmentId && (!J || J.id !== S.judgmentId || quiet)) J = await api("GET", `/api/judgments/${S.judgmentId}`).catch(() => null);
    if (!S.judgmentId) J = null;
    render();
    afterRender();
  } catch (e) { if (!quiet) { toast(e.message, true); go("#/capture"); } }
}

function head() {
  const c = S.consent?.modalities ?? [];
  const caps = ["SCREEN", "CAMERA", "MICROPHONE"].filter((m) => wfMod(m));
  const capState = (m) => (S.privacy.paused ? "paused" : S.privacy.excluded?.[m] ? "excluded" : c.includes(m) && S.status === "capturing" ? "on" : "off");
  return `<div class="card session-head">
    <div class="row">${statusChip(S.status)}<div><div class="eyebrow">${isLiving() ? "Teaching session" : "Capture session"}${S.transferId ? ` · <a href="#/transfers/${S.transferId}">part of a knowledge transfer</a>` : ""}</div><b>${esc(S.expertName)}</b> <span class="muted">· ${esc(workflow()?.name ?? "")}${S.sim ? ` · ${esc(S.sim.title)}` : ""}</span></div></div>
    <div class="capture-indicators" role="group" aria-label="Capture state">${caps.map((m) => `<span class="cap ${capState(m) === "on" ? "on" : capState(m) === "off" ? "" : "off"}">${capState(m) === "on" ? '<span class="rec" aria-hidden="true"></span>' : ""}${icon(MOD_ICON[m], 14)} ${m.toLowerCase()} · ${capState(m)}</span>`).join("")}</div>
    ${S.isMine && ["capturing", "awaiting_consent"].includes(S.status) ? `<div class="row">
      <button class="sm" data-act="pause">${S.privacy.paused ? icon("play", 14) + " Resume" : icon("pause", 14) + " Pause"}</button>
      ${caps.map((m) => `<button class="chip" aria-pressed="${!S.privacy.excluded?.[m]}" data-act="exclude" data-m="${m}" title="Exclude or include ${m.toLowerCase()}">${icon(MOD_ICON[m], 13)} ${S.privacy.excluded?.[m] ? "excluded" : "included"}</button>`).join("")}
      <label class="small">Raw retention <select id="retain" style="width:auto;padding:5px 8px">${[["evidence", "evidence only"], ["all", "keep all"], ["none", "keep none"]].map(([v, l]) => `<option value="${v}" ${S.privacy.retainRaw === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>` : ""}
  </div>`;
}
// Inputs this session may capture: the session's own workflow, narrowed to what the chosen capture method uses.
const SOURCE_MODS = { "live:audio": ["MICROPHONE"], "live:screen": ["SCREEN", "MICROPHONE"], "live:camera": ["CAMERA", "MICROPHONE"], manual: ["MICROPHONE"] };
const wfMod = (m) => {
  const mods = S?.modalities ?? workflow()?.modalities ?? {};
  const allowed = SOURCE_MODS[S?.captureSource];
  return Boolean({ SCREEN: mods.screen, CAMERA: mods.camera, MICROPHONE: mods.microphone }[m]) && (!allowed || allowed.includes(m));
};

function consentCard() {
  if (!S.isMine) return `<div class="callout amber" style="margin-top:12px">Waiting for ${esc(S.expertName)} to consent to capture.</div>`;
  const copy = { SCREEN: "Screen frames when something changes (not a continuous video)", CAMERA: "Camera frames when something changes, plus short video clips kept as evidence", MICROPHONE: "Your voice while speaking (silence is never uploaded)" };
  const mods = ["SCREEN", "CAMERA", "MICROPHONE"].filter(wfMod);
  return `<div class="card pad stack" style="margin-top:12px;border-color:var(--flesh-2)" role="region" aria-label="Recording consent">
    <div class="row">${orb("curious", 56, { caption: false })}<div><h2>Before I watch, please confirm what I may capture</h2><p class="small muted">Under the Recording &amp; Consent Policy. Recording is not sharing: nothing becomes knowledge until you approve it${isLiving() ? ", and it stays private until you choose who may see it" : ""}. You can pause, exclude an input, or delete any moment.</p></div></div>
    ${S.disclosure ? `<dl class="kv left consent-facts small"><dt>What it is for</dt><dd>${S.disclosure.missionId ? `<a href="#/missions/${S.disclosure.missionId}">${esc(S.disclosure.purpose)}</a>` : esc(S.disclosure.purpose)}</dd>
      <dt>Who will see it</dt><dd>${esc(S.disclosure.access)}</dd><dt>AI processing</dt><dd>${esc(S.disclosure.ai)}</dd><dt>How long it is kept</dt><dd>${esc(S.disclosure.retention)}</dd>
      <dt>Your controls</dt><dd>Pause, exclude an input, stop, or delete any captured moment, before and after you approve.</dd></dl>` : ""}
    <fieldset><legend class="small"><b>Inputs I may capture</b> (untick any you do not want)</legend>
    ${mods.map((m) => `<label class="check"><input type="checkbox" data-consent="${m}" checked> ${icon(MOD_ICON[m], 16)} <b>${m.toLowerCase()}</b> <span class="muted small">${copy[m]}</span></label>`).join("") || `<p class="small muted">No device input: you will type steps or add documents.</p>`}</fieldset>
    <div><button class="accent" data-act="consent" ${state.busy ? "disabled" : ""}>${icon("validate", 15)} I agree, start capturing</button></div></div>`;
}

function stage() {
  const capturing = S.status === "capturing" && S.isMine;
  let surface = "";
  if (S.sim) {
    surface = `<div class="viewport" role="img" aria-label="${esc(S.sim.label)}: simulated view; its state is described in the observation list">${S.sim.svg}<div class="overlay"><span class="tag">${icon(S.sim.render === "loom" ? "camera" : "screen", 12)} ${esc(S.sim.label)}</span></div></div>
      <div class="keypad" role="group" aria-label="Actions">${S.sim.actions.map((a) => a.param
        ? (S.sim.paramOptions[a.id] ?? []).map((p) => `<button ${!capturing || state.busy ? "disabled" : ""} data-act="sim" data-a="${a.id}" data-p="${esc(p)}">${esc(a.label)} ${esc(p)}</button>`).join("")
        : `<button class="${a.kind}" ${!capturing || state.busy ? "disabled" : ""} data-act="sim" data-a="${a.id}">${esc(a.label)}</button>`).join("")}</div>
      <details class="small muted"><summary>Sample script (scripted actions for this simulated feed)</summary><p>${esc(S.sim.script.steps.map(([a, p]) => S.sim.actions.find((x) => x.id === a)?.label + (p ? ` ${p}` : "")).join(" → "))}</p>
        <button class="sm" data-act="play" ${!capturing || state.busy ? "disabled" : ""}>${icon("play", 13)} Play the actions</button></details>`;
  } else if (S.captureSource === "live:audio") {
    // Audio-only capture: narration or conversation is the evidence; there is no visual feed.
    surface = `<div class="audio-surface stack"><div class="row">${icon("mic", 22)}<div><b>Audio recording</b><p class="small muted">Talk through what you do and why. Silence is never uploaded; each spoken segment is transcribed and kept with its time.</p></div></div>
      <p class="small muted">No microphone, or prefer typing? Add steps as text below; they are evidence too.</p>
      <label class="field" for="note-text">Typed step<textarea id="note-text" data-draft="note" rows="2" placeholder="I always listen for the second click before closing the valve"></textarea></label>
      <div><button class="sm" data-act="note" ${!capturing || state.busy ? "disabled" : ""}>Add step</button></div></div>`;
  } else if (S.captureSource.startsWith("live:")) {
    const m = S.captureSource === "live:screen" ? "SCREEN" : "CAMERA";
    surface = `<div class="viewport" id="live-slot">${visual?.running ? "" : `<div class="empty" style="color:#ccc">${icon(MOD_ICON[m], 28)}<span>Not capturing</span></div>`}</div>
      <div class="row">${visual?.running ? `<button class="sm" data-act="live-stop">Stop ${m.toLowerCase()}</button><button class="sm" data-act="mark">${icon("spark", 13)} Mark this moment</button><span class="small muted">looked ${visual.stats.looked} · sent ${visual.stats.sent} · stable ${visual.stats.stable}${visual.stats.failed ? ` · failed ${visual.stats.failed}` : ""}</span>`
        : `<button class="primary sm" data-act="live-start" ${!capturing ? "disabled" : ""}>${icon(MOD_ICON[m], 14)} ${m === "SCREEN" ? "Share my screen" : "Turn on camera"}</button>`}</div>
      <p class="small muted">Only frames that change leave your browser. Each is stored privately, then interpreted asynchronously at the lowest resolution that works.</p>`;
  } else {
    surface = `<p class="muted">Describe each step as you do it, typed or spoken.</p><label class="sr-only" for="note-text">Step</label><textarea id="note-text" data-draft="note" rows="2" placeholder="I checked the pressure before opening the valve"></textarea>
      <div><button class="sm" data-act="note" ${!capturing || state.busy ? "disabled" : ""}>Add step</button></div>`;
  }
  const micAllowed = wfMod("MICROPHONE") && S.consent?.modalities?.includes("MICROPHONE");
  return `${surface}${capturing ? `<div class="row" style="border-top:1px solid var(--line);padding-top:12px">
      ${micAllowed ? `<button class="sm ${voice?.running ? "danger" : ""}" data-act="narrate" aria-pressed="${Boolean(voice?.running)}">${icon("mic", 14)} ${voice?.running ? "Stop recording" : S.captureSource === "live:audio" ? "Start recording" : "Narrate while working"}</button>${voice?.running ? '<span class="rec-status" role="status"><span class="rec" aria-hidden="true"></span> Recording: microphone live</span>' : ""}` : ""}
      <span style="flex:1"></span><button class="primary" data-act="end" ${state.busy ? "disabled" : ""}>I'm done with this task</button></div>` : ""}`;
}

function timeline() {
  const obs = S.observations;
  const t0 = obs.length ? new Date(obs[0].captured_at).getTime() : 0;
  const t1 = obs.length ? Math.max(t0 + 1000, new Date(obs.at(-1).captured_at).getTime()) : 1;
  const moment = new Set((S.candidate?.eventIds ?? []).concat(S.candidate?.choiceEvidence ?? []));
  const labels = S.detection?.labels ?? {};
  const lanes = ["APP_EVENT", "SCREEN", "CAMERA", "MICROPHONE", "TEXT"].filter((m) => obs.some((o) => o.modality === m));
  return `<div class="card-head"><h2>Observation timeline</h2>${orb(S.status === "capturing" ? "observing" : BUSY.has(S.status) ? "thinking" : S.status === "asking" ? "asking" : S.status === "validating" ? "curious" : "confirmed", 40, { caption: false })}</div>
  <div class="timeline">
    ${lanes.length ? `<div class="lanes" aria-hidden="true">${lanes.map((m) => `<span class="lane-label">${icon(MOD_ICON[m], 12)} ${m === "APP_EVENT" ? "app" : m.toLowerCase()}</span><div class="lane">${obs.filter((o) => o.modality === m).map((o) => `<i class="${o.deleted_at ? "deleted" : o.dropped ? "dropped" : moment.has(o.alias) ? "moment" : ""}" style="left:calc(${((new Date(o.captured_at).getTime() - t0) / (t1 - t0)) * 100}% - 4px)" data-act="evidence" data-at="${new Date(o.captured_at).toISOString()}" title="${esc(o.alias)}"></i>`).join("")}</div>`).join("")}</div>` : ""}
    ${S.gate?.log?.length ? `<p class="small muted" style="margin-bottom:8px">${icon("shield", 12)} Gate: ${esc(S.gate.log.join(" · "))}</p>` : ""}
    <ol class="events" aria-live="polite">${obs.map((o) => {
      const l = labels[o.alias];
      return `<li class="event ${o.dropped ? "dropped" : ""} ${moment.has(o.alias) ? "moment" : ""}"><span class="ico">${icon(MOD_ICON[o.modality], 14)}</span>
        <div><div>${o.deleted_at ? "<i>deleted by the expert</i>" : esc(o.text || (o.dropped ? "No meaningful change" : "…"))}</div>
          <div class="meta"><button class="plan link" data-act="evidence" data-at="${new Date(o.captured_at).toISOString()}" aria-label="Open the evidence around ${esc(o.alias)}">${esc(o.alias)}</button><span class="plan ${esc(o.plan?.decision)}" title="${esc(o.plan?.reason)}">${esc(planLabel(o.plan))}</span>${l ? `<span class="plan label-${l.label}" title="${esc(l.note)}">${esc(l.label.replace("_", " ").toLowerCase())}</span>` : ""}${(o.security_flags ?? []).length ? `<span class="plan" style="background:var(--amber-soft);color:var(--amber)" title="${esc(o.security_flags.join(", "))}">${icon("shield", 10)} instructions to AI ignored</span>` : ""}</div></div>
        ${S.isMine && !o.deleted_at ? `<button class="ghost icon-btn" data-act="delete-obs" data-id="${o.id}" aria-label="Delete this moment">${icon("trash", 15)}</button>` : "<span></span>"}</li>`;
    }).join("") || `<li class="muted small">Nothing captured yet.</li>`}</ol>
    ${S.processing?.pending ? `<p class="thinking small" style="margin-top:8px">${S.processing.pending} item(s) processing</p>` : ""}
  </div>`;
}
const planLabel = (p) => ({ use_text: "text", evidence_only: "evidence only", vision: `vision ${String(p?.resolution ?? "default").replace("MEDIA_RESOLUTION_", "").toLowerCase()}${p?.escalated ? " ↑" : ""}`, drop_stable: "not sent", transcribe: "heard once" })[p?.decision] ?? p?.decision ?? "";

function conversation() {
  const st = S.status;
  const persona = BUSY.has(st) ? "thinking" : st === "asking" ? "asking" : st === "validating" ? "curious" : st === "done" ? "confirmed" : st === "no_judgment" ? "confirmed" : "observing";
  let body = "";
  if (st === "capturing" || st === "awaiting_consent") body = `<p class="muted">I won't interrupt while you work. When you finish, I'll look back for the choices where your judgment mattered.</p>`;
  if (st === "processing") body = `<p class="thinking">Finishing processing of captured media</p>`;
  if (st === "analyzing") body = `<p class="thinking">Looking back over what you did</p>`;
  if (st === "no_judgment") body = `<div class="callout green"><b>Nothing to ask.</b> What you did matched the ${isLiving() ? "written recipe" : "documented procedure"}, so I didn't interrupt you.</div>`;
  if (S.candidate && !["capturing", "no_judgment"].includes(st)) {
    body += `<div class="callout pink small"><b>${icon("spark", 13)} Judgment moment: ${esc(S.candidate.type.replace(/_/g, " "))}</b> · ${esc(S.candidate.summary)}
      <div class="muted" style="margin-top:4px">Action: ${esc(S.candidate.action)} · Alternative not taken: ${esc((S.candidate.alternatives ?? []).join("; "))} · Evidence of a choice: ${esc((S.candidate.choiceEvidence ?? []).join(", "))}</div></div>`;
  }
  // answered turns as history; the open question (if any) is rendered once, prominently, below
  const SRC = { voice: "spoken", voice_corrected: "spoken, corrected by the speaker", typed: "" };
  body += S.dialogue.filter((d) => d.answer).map((d) => `<div class="bubble ai"><span class="who">Agamya · ${esc(d.intent.replace(/_/g, " "))}</span><span${langAttr(d.question_language)}>${esc(d.question)}</span></div><div class="bubble human"><span class="who">${esc(S.expertName)}${SRC[d.answer_source] ? ` · ${SRC[d.answer_source]}` : ""}</span><span${langAttr(d.answer_language)}>${esc(d.answer)}</span>${d.answer_original && d.answer_original !== d.answer ? `<details class="small"><summary>Machine transcript before correction</summary><span${langAttr(d.answer_language)}>${esc(d.answer_original)}</span></details>` : ""}</div>`).join("");
  if (st === "asking" && S.question) {
    body += `<div class="bubble ai now" role="status"><span class="who">Agamya asks ${srcTag(S.question.source)} <button class="ghost icon-btn" data-act="say" aria-label="Say it again">${icon("speaker", 14)}</button></span>${esc(S.question.text)}
      ${S.question.hypothesis ? `<div class="small muted" style="font-family:var(--font);font-weight:500">My current guess (unconfirmed): ${esc(S.question.hypothesis)}</div>` : ""}</div>`;
    if (S.isMine && S.answerDraft) {
      const dk = `draft-${S.id}-${S.answerDraft.at}`;
      if (state.drafts[dk] === undefined) state.drafts[dk] = S.answerDraft.text;
      body += `<div class="answer stack"><label class="field" for="${dk}">Here is what I heard${S.answerDraft.language ? ` (${esc(langName(S.answerDraft.language))})` : ""}. Check it and correct anything I got wrong before it counts.
          <textarea id="${dk}" data-draft="${dk}" data-focus="${dk}" rows="3"${langAttr(S.answerDraft.language)}></textarea></label>
        ${S.answerDraft.confidence != null && S.answerDraft.confidence < 0.6 ? `<p class="small callout amber">I was not sure of some words. Please read it carefully.</p>` : ""}${S.answerDraft.incomplete ? `<p class="small muted">The recording seemed to stop mid-sentence.</p>` : ""}
        <div class="row"><button class="primary" data-act="confirm-draft" data-key="${dk}" ${state.busy ? "disabled" : ""}>${icon("validate", 14)} That's what I said: send</button>
          <button class="sm ghost" data-act="rec">${icon("mic", 14)} Record again</button></div></div>`;
    } else if (S.isMine) {
      const presenter = S.sim?.script?.answers?.[S.dialogue.filter((x) => x.answer).length];
      body += `<div class="answer">${S.consent?.modalities?.includes("MICROPHONE") ? `<button class="mic-btn ${answerRec ? "recording" : ""}" data-act="rec">${icon("mic", 15)} ${answerRec ? "Stop recording" : "Answer by voice"}</button>` : ""}${S.processing?.pending && !answerRec ? `<span class="thinking small" role="status">Transcribing your answer</span>` : ""}
        <label class="sr-only" for="answer-${S.id}">Your answer</label><textarea id="answer-${S.id}" data-draft="answer-${S.id}-${S.dialogue.length}" data-focus="answer" rows="3" placeholder="…or type your answer"${langAttr(S.language)}></textarea>
        <div class="row"><button class="primary" data-act="answer" data-key="answer-${S.id}-${S.dialogue.length}" ${state.busy ? "disabled" : ""}>Send</button>
          ${presenter ? `<button class="sm ghost" data-act="fill" data-key="answer-${S.id}-${S.dialogue.length}" data-text="${esc(presenter)}" title="A scripted answer for this sample; edit it or write your own">Use the sample answer</button>` : ""}
          ${S.dialogue.some((x) => x.answer) ? `<button class="sm ghost" data-act="stop-q">That's all I'll say</button>` : ""}</div></div>`;
    }
  }
  if (st === "extracting") body += `<p class="thinking">Structuring your explanation and checking every claim against your own words</p>`;
  if (S.lastError) body += `<div class="callout amber small">${esc(S.lastError)}</div>`;
  if (J && ["validating", "done"].includes(st)) body += judgmentPanel();
  return `<div class="dialogue">${orb(persona, 88)}<div class="qa">${body}</div></div>`;
}

function judgmentPanel() {
  const c = J.content;
  const pending = J.status === "observed";
  return `<div class="card pad stack" style="margin-top:8px;border-color:var(--line-2)">
    <div class="row between"><div><div class="eyebrow">What Agamya understood · v${J.currentVersion}</div><h2>${esc(c.title)}</h2></div><div class="row">${levels(J.levels.badges)}</div></div>
    ${J.unresolved?.length ? `<div class="callout amber small"><b>Still uncertain:</b> ${J.unresolved.map(esc).join("; ")}</div>` : ""}
    ${judgmentChain(c, { editing })}
    ${editing ? "" : boundaryCard(c)}
    ${docTriad(c, J.docConflicts, { onDecide: J.isMine || state.me.roles.includes("WORKFLOW_OWNER") })}
    ${J.conflicts.map((x) => conflictCard(x, { canAnswer: state.me.roles.some((r) => ["EXPERT", "WORKFLOW_OWNER"].includes(r)) })).join("")}
    <div><div class="eyebrow">Evidence</div>${evidenceStrip(J.evidence, J.sessionId)}</div>
    ${J.verification?.notes?.length ? `<details class="small"><summary>${icon("shield", 13)} ${J.verification.notes.length} deterministic correction(s) to the AI's draft</summary><ul>${J.verification.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
    <div class="row" style="border-top:1px solid var(--line);padding-top:12px">
      ${pending && J.isMine ? (editing
        ? `<button class="primary" data-act="save-edit">Save my edits and approve</button><button class="ghost" data-act="cancel-edit">Cancel</button>`
        : `${c.boundary?.status !== "confirmed" ? `<label class="check"><input type="checkbox" id="confirm-boundary"> The boundary is right as written</label>` : ""}
           ${approveVisibility()}
           <button class="primary" data-act="approve" ${state.busy ? "disabled" : ""}>${icon("validate", 15)} Approve</button><button data-act="edit">Correct it</button><button class="danger" data-act="reject" ${state.busy ? "disabled" : ""}>Reject</button>
           <span class="small muted">Nothing becomes knowledge until you approve it. Corrections keep the earlier version in the history.</span>`)
        : pending ? `<span class="small muted">Waiting for ${esc(J.expertName)} to validate.</span>` : `<span class="tag ${J.status === "approved" ? "green" : "red"}">${J.status === "approved" ? (J.artifact?.governance?.visibility === "private" ? "Approved and saved privately" : "Approved and saved as knowledge") : "Rejected"}</span>${J.status === "approved" ? `<a href="#/knowledge/${J.id}">Open the knowledge</a>${isLiving() && J.isMine ? ` · <a href="#/journey">Back to the journey</a>` : ""}` : ""}`}
    </div></div>`;
}

/** Saving is not sharing. Living spaces default to private; workplaces to the people who learn the workflow (disclosed before capture). */
function approveVisibility() {
  const opts = isLiving() ? [["private", "Save privately (choose who may learn it next)"]] : [["organization", "Share with people who learn this workflow"], ["private", "Keep it private for now"]];
  return opts.length > 1 ? `<label class="small row">After approval<select id="approve-vis" style="width:auto;padding:5px 8px">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>` : `<span class="small muted">${icon("eyeoff", 13)} ${opts[0][1]}</span>`;
}

function budget() {
  const t = S.tokens, b = S.budget ?? {};
  const l0 = S.observations.filter((o) => o.media_asset_id).length, l1 = S.observations.filter((o) => !o.dropped && o.text && !o.deleted_at).length;
  return `<div><div class="eyebrow" style="margin-bottom:8px">Progressive context compilation</div><div class="ladder">
      <div class="rung"><b>${l0}</b><span>L0 raw captured</span></div><div class="rung"><b>${l1}</b><span>L1 observations sent</span></div>
      <div class="rung"><b>${Object.keys(S.detection?.labels ?? {}).length}</b><span>L2 semantic labels</span></div><div class="rung ${S.candidate ? "hot" : ""}"><b>${S.candidate ? 1 : 0}</b><span>L3 judgment candidate</span></div>
      <div class="rung"><b>${S.judgmentId ? 1 : 0}</b><span>L4 judgment</span></div><div class="rung"><b>${J?.artifact ? 1 : 0}</b><span>L5 compiled rule</span></div></div></div>
    <div><dl class="kv"><dt>Gemini calls</dt><dd>${fmt(t.calls)}</dd><dt>Tokens (in / out)</dt><dd>${fmt(t.prompt)} / ${fmt(t.output)}</dd>
      <dt>Image tokens sent</dt><dd>${fmt(t.image)} <span class="muted" style="font-weight:500">vs ${fmt(t.imageIfDefault)} if every frame went raw</span></dd><dt>Estimated cost</dt><dd>${usd(t.cost)}</dd>
      <dt>Raw stored / purged</dt><dd>${Math.round((b.rawBytesCaptured ?? 0) / 1024)} KB / ${Math.round((b.rawBytesPurged ?? 0) / 1024)} KB</dd></dl>
      ${b.momentEvidence ? `<p class="small muted" style="margin-top:6px">${esc(b.momentEvidence)}</p>` : ""}</div>`;
}

// ---------------------------------------------------------------- live capture plumbing
export function afterRender() {
  if (videoEl && visual?.running) document.getElementById("live-slot")?.replaceChildren(videoEl);
}
function stopLive() { visual?.stop(); visual = null; voice?.stop(); voice = null; }

export async function sessionClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "start") return act("start", async () => { stopLive(); lastSpoken = null; editing = false; const s = await api("POST", "/api/sessions", { workflowId: workflow().id, source: setup.source, caseRef: setup.caseRef, language: setup.language ?? uiLang() }); S = s; go(`#/session/${s.id}`); });
  if (!S) return;
  const id = S.id;
  const reload = async (x) => { S = x ?? await api("GET", `/api/sessions/${id}`); if (S.judgmentId) J = await api("GET", `/api/judgments/${S.judgmentId}`).catch(() => J); };
  switch (a) {
    case "consent": {
      const mods = [...document.querySelectorAll("[data-consent]")].filter((x) => x.checked).map((x) => x.dataset.consent);
      return act("consent", async () => reload(await api("POST", `/api/sessions/${id}/consent`, { modalities: mods, clientTime: Date.now() })));
    }
    case "pause": return act("privacy", async () => { await reload(await api("POST", `/api/sessions/${id}/privacy`, { paused: !S.privacy.paused })); if (visual) visual.paused = S.privacy.paused; if (voice) voice.paused = S.privacy.paused; });
    case "exclude": return act("privacy", async () => { const m = t.dataset.m; await reload(await api("POST", `/api/sessions/${id}/privacy`, { excluded: { [m]: !S.privacy.excluded?.[m] } })); if (S.privacy.excluded?.[m]) { if (m === "MICROPHONE") { voice?.stop(); voice = null; } else { visual?.stop(); visual = null; } } });
    case "sim": return act("sim", async () => reload(await api("POST", `/api/sessions/${id}/sim`, { action: t.dataset.a, param: t.dataset.p })));
    case "play": return act("sim", async () => { for (const [action, param] of S.sim.script.steps) { if (S.status !== "capturing") break; await reload(await api("POST", `/api/sessions/${id}/sim`, { action, param })); render(); } });
    case "note": { const text = draft("note"); if (!text) return; state.drafts.note = ""; return act("note", async () => reload(await api("POST", `/api/sessions/${id}/notes`, { text }))); }
    case "end": stopLive(); return act("end", async () => reload(await api("POST", `/api/sessions/${id}/end`)));
    case "narrate":
      if (voice?.running) { voice.stop(); voice = null; return render(); }
      try { voice = new VoiceCapture({ sessionId: id, onSegment: () => load(id, true), onError: (err) => toast(err.message, true) }); await voice.start(); } catch (err) { voice = null; toast(`Microphone unavailable: ${err.message}. You can type instead.`, true); }
      return render();
    case "live-start": {
      const modality = S.captureSource === "live:screen" ? "SCREEN" : "CAMERA";
      // Audio + video: camera frames on change plus short WebM evidence clips (recordVideo); screen capture sends frames only.
      visual = new VisualCapture({ sessionId: id, modality, recordVideo: modality === "CAMERA", onStats: () => render(), onError: (err) => toast(err.message, true) });
      videoEl = Object.assign(document.createElement("video"), { muted: true, playsInline: true });
      try { await visual.start(videoEl); } catch (err) { visual = null; toast(`${modality === "SCREEN" ? "Screen sharing" : "Camera"} unavailable: ${err.message}. You can narrate or type steps instead.`, true); }
      render(); afterRender(); return;
    }
    case "live-stop": visual?.stop(); visual = null; return render();
    case "mark": return visual?.tick(true);
    case "rec":
      if (answerRec) { const r = answerRec; answerRec = null; announce("Recording stopped. Transcribing; you will be asked to check the words."); return act("answer", async () => { await r.stopAndUpload(id); await reload(); }); }
      try { answerRec = new AnswerRecorder(); await answerRec.start(); } catch (err) { answerRec = null; toast(`Microphone unavailable: ${err.message}`, true); }
      return render();
    case "confirm-draft": { const text = draft(t.dataset.key); if (!text) return toast("The answer is empty.", true); return act("answer", async () => { reload(await api("POST", `/api/sessions/${id}/answer`, { text, fromDraft: true })); announce("Answer sent."); }); }
    case "answer": { const text = draft(t.dataset.key); if (!text) return toast("Type or record an answer first.", true); return act("answer", async () => reload(await api("POST", `/api/sessions/${id}/answer`, { text }))); }
    case "fill": state.drafts[t.dataset.key] = t.dataset.text; return render();
    case "stop-q": return act("answer", async () => reload(await api("POST", `/api/sessions/${id}/stop`)));
    case "say": lastSpoken = null; return speak(S.question.text);
    case "delete-obs": if (!confirm("Delete this moment? The raw media and its extracted text are removed.")) return; return act("delete", async () => { await api("DELETE", `/api/observations/${t.dataset.id}`); await reload(); });
    case "evidence": return openEvidence(t.dataset.session ?? id, t.dataset.at);
    case "approve": return act("validate", async () => {
      const visibility = document.getElementById("approve-vis")?.value ?? (isLiving() ? "private" : "organization");
      await api("POST", `/api/judgments/${J.id}/validate`, { decision: "approve", confirmBoundary: Boolean(document.getElementById("confirm-boundary")?.checked), expectedVersion: J.version, visibility });
      await reload(); toast(visibility === "private" ? "Approved and saved privately." : "Approved and saved as knowledge.");
    });
    case "reject": return act("validate", async () => { await api("POST", `/api/judgments/${J.id}/validate`, { decision: "reject", expectedVersion: J.version }); await reload(); });
    case "edit": editing = true; return render();
    case "cancel-edit": editing = false; return render();
    case "save-edit": {
      const edits = Object.fromEntries([...document.querySelectorAll("[data-edit]")].map((x) => [x.dataset.edit, x.value]));
      editing = false;
      return act("validate", async () => { await api("POST", `/api/judgments/${J.id}/validate`, { decision: "edit", edits, expectedVersion: J.version }); await reload(); });
    }
    case "gap": return act("gap", async () => { await api("POST", `/api/doc-conflicts/${t.dataset.id}`, { decision: t.dataset.v }); await reload(); });
    case "conflict-answer": { const ans = draft(`conflict-${t.dataset.id}`); if (!ans) return; return act("conflict", async () => { await api("POST", `/api/expert-conflicts/${t.dataset.id}/answer`, { answer: ans }); await reload(); }); }
  }
}

export async function sessionChange(e) {
  const t = e.target;
  if (t.id === "cap-lang") { setup.language = t.value; return render(); }
  if (t.id === "cap-source") { setup.source = t.value; setup.caseRef = null; return render(); }
  if (t.id === "cap-case") { setup.caseRef = t.value; return; }
  if (t.id === "retain" && S) return act("privacy", async () => { S = await api("POST", `/api/sessions/${S.id}/privacy`, { retainRaw: t.value }); });
}
export function leaveSession() { stopLive(); stop(`sess-${S?.id}`); }
