// The minimal product surface: choose screen or camera → one consent card → straight into work with Moti.
//   #/start/screen | #/start/camera   live capture (Moti listens, watches, asks at pauses)
//   #/map/:sessionId                  the Work Map, the voice debrief + teach-back, confirmation, export for agents
//   #/practice/:sessionId             a new hire practises on their own screen; Moti tutors from the confirmed map
// Every live screen has a typed alternative to speaking, an off-the-record control, and a visible, announced state.
import { state, api, esc, render, toast, go, isLiving } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { announce } from "../a11y.js";
import { LiveMoti, liveSupport } from "../live.js";
import { LANGS, langName } from "../i18n.js";

let live = null, mapTimer = null, view = { lines: [], status: "idle", offRecord: false, consent: null, map: null, run: null, moment: null, error: null };
const STATE_WORDS = { idle: "Not started", starting: "Starting", live: "Moti is listening", speaking: "Moti is speaking", ending: "Wrapping up", closed: "Disconnected", ended: "Ended" };
const LANG_OPTIONS = [...LANGS, { code: "hi", name: "Hindi", native: "हिन्दी" }, { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" }];

export function leaveNow() { clearTimeout(mapTimer); if (live) { live.close(); live = null; } view = { lines: [], status: "idle", offRecord: false, consent: null, map: null, run: null, moment: null, error: null }; }

function shell(inner, { dark = true } = {}) {
  return `<div class="now ${dark ? "dark" : ""}"><header class="now-head"><a class="now-brand" href="#/">${orb("observing", 26, { caption: false })}<span>Agamya</span></a>
    <span class="spacer"></span>${STATE_WORDS[view.status] && view.status !== "idle" ? `<span class="now-state" role="status"><span class="dot-live ${view.status}" aria-hidden="true"></span>${esc(live instanceof TypedMoti && view.status === "live" ? "Typed session" : STATE_WORDS[view.status])}</span>` : ""}
    <a class="btn ghost sm" href="#/">Home</a></header><main id="main" tabindex="-1" class="now-main">${inner}</main></div>`;
}

// ---------------------------------------------------------------- capture
export function startView(r) {
  const kind = r.id === "camera" ? "camera" : "screen";
  const sup = liveSupport();
  const can = sup.mic && (kind === "camera" ? sup.camera : sup.screen);
  if (view.status === "idle") {
    const lang = view.consent?.language ?? (state.me?.user?.language || "en");
    return shell(`<section class="now-consent" aria-labelledby="c-h">
      <h1 id="c-h">${kind === "camera" ? "Show it on camera" : "Share your screen and work"}</h1>
      <p>Moti will ${kind === "camera" ? "see your camera" : "see your shared screen"} and hear you. It stays quiet while you work and asks a short question at a natural pause. Afterwards it asks a few things it is unsure about, explains the process back to you, and you confirm it.</p>
      <label class="field" for="now-name">What are you about to do? <span class="muted" style="font-weight:400">(optional)</span><input id="now-name" data-draft="now-name" maxlength="120" placeholder="${kind === "camera" ? "Making ghee from butter" : "Month-end supplier invoices"}"></label>
      <div class="field"><label for="now-lang">Language you will speak</label><select id="now-lang">${LANG_OPTIONS.map((l) => `<option value="${l.code}" lang="${l.code}" ${l.code === lang ? "selected" : ""}>${esc(l.native)}${l.native !== l.name ? ` (${esc(l.name)})` : ""}</option>`).join("")}</select>
        <span class="small muted">Moti asks in this language. Everything is saved in English as the shared base.</span></div>
      <dl class="now-facts"><dt>Captured</dt><dd>${kind === "camera" ? "Camera frames when something changes" : "Screen frames when something changes"}, and your voice</dd>
        <dt>Processed by</dt><dd>${state.config?.ai === "vertex" ? "Gemini on Google Cloud (Vertex AI). Not used to train models." : "AI is offline here: live voice is unavailable, you can type."}</dd>
        <dt>Who sees it</dt><dd>${isLiving() ? "Only you, until you share it." : "You first. After you confirm the Work Map, people learning this work in your organization."}</dd>
        <dt>Kept</dt><dd>Recordings for 30 days for your review; the confirmed Work Map until you remove it.</dd>
        <dt>Your controls</dt><dd>Off the record, stop, and delete any moment.</dd></dl>
      ${can ? "" : `<p class="callout" role="alert">${!sup.mic ? "This browser cannot record audio here." : kind === "screen" ? "Screen sharing needs a desktop browser." : "No camera is available."} You can still type your explanation once started.</p>`}
      <div class="row"><button class="primary lg" data-act="now-start" data-kind="${kind}" ${state.busy ? "disabled" : ""}>${icon("play", 16)} I agree, start</button><a class="btn ghost" href="#/">Not now</a></div>
    </section>`);
  }
  return shell(`<div class="now-stage ${kind}">
    <div class="now-video">${live instanceof TypedMoti ? `<p class="now-typed">Typed session: nothing from your ${kind} is captured.</p>` : `<video id="now-video" aria-label="${kind === "camera" ? "Your camera" : "Your shared screen"}" muted playsinline></video>`}
      ${view.offRecord ? `<div class="now-offrec" role="status">Off the record: nothing is being captured</div>` : ""}</div>
    <aside class="now-panel" aria-labelledby="moti-h"><div class="row">${orb(view.status === "speaking" ? "asking" : "observing", 44, { caption: false })}<h2 id="moti-h" class="h3">Moti</h2></div>
      ${conversation()}
      ${typeBox()}
      <div class="row wrap now-controls"><button class="sm" data-act="now-offrec" aria-pressed="${view.offRecord}">${view.offRecord ? "Back on the record" : "Off the record"}</button>
        <button class="primary sm" data-act="now-finish" ${view.status === "ending" ? "disabled" : ""}>I'm done</button></div>
    </aside></div>`);
}

function conversation() {
  return `<ol class="now-lines" aria-live="polite" aria-relevant="additions">${view.lines.slice(-12).map((l) => `<li class="${l.who}"><span class="who">${l.who === "moti" ? "Moti" : "You"}</span>${esc(l.text)}</li>`).join("") || `<li class="muted small">${voiceReady() ? "Work as you normally would. Talk if you like." : "Live voice is unavailable here. Type each step and why you do it."}</li>`}</ol>`;
}
const typeBox = () => `<div class="now-type"><label for="now-say" class="sr-only">Type to Moti</label><input id="now-say" data-draft="now-say" placeholder="Type instead of speaking" autocomplete="off"><button class="sm" data-act="now-say">Send</button></div>`;

/** Without live AI or a microphone: the same session, typed. Words are stored as the expert's; finishing builds the map. */
class TypedMoti {
  constructor(o) { Object.assign(this, o); }
  async start() { this.onState?.("live"); }
  async say(text) { try { await api("POST", `/api/live/${this.sessionId}/text`, { text }); this.onYou?.(text); } catch (e) { this.onError?.(e.message); } }
  setOffRecord(on) { this.onStatus?.({ offRecord: on }); }
  async finish() { this.onState?.("ending"); try { await api("POST", `/api/live/${this.sessionId}/finish`, { phase: this.mode === "debrief" ? "debrief" : "capture" }); this.onStatus?.({ phaseDone: this.mode }); } catch (e) { this.onError?.(e.message); } }
  close() {}
}
const voiceReady = () => state.config?.ai === "vertex" && liveSupport().mic;

function connect(o) {
  live = new (voiceReady() || o.mode === "tutor" ? LiveMoti : TypedMoti)({ ...o,
    onMoti: (text) => { view.lines.push({ who: "moti", text }); announce(`Moti: ${text}`); render(); },
    onYou: (text) => { view.lines.push({ who: "you", text }); render(); },
    onStatus: (m) => { if (m.offRecord !== undefined) { view.offRecord = m.offRecord; announce(m.offRecord ? "Off the record." : "Back on the record."); }
      if (m.phaseDone) { const id = o.sessionId; leaveNow(); go(`#/map/${id}`); return; }
      if (m.finished) { view.run = { result: m.finished }; announce("Practice finished."); }
      if (m.intervention) announce("Moti stopped a decision. Listen to why.");
      render(); },
    onMoment: (m) => { view.moment = m; announce(`Showing how the expert did step: ${m.title}`); render(); },
    onError: (msg) => { view.error = msg; toast(msg, true); render(); },
    onState: (s) => { view.status = s; render(); },
  });
  return live;
}

// ---------------------------------------------------------------- Work Map + debrief
export function mapView(r) {
  const id = r.id;
  if (!view.map || view.map.sessionId !== id) { loadMap(id); return shell(`<span class="thinking">Loading the Work Map</span>`, { dark: false }); }
  const m = view.map;
  if (m.error) return shell(`<section class="now-wait"><h1>Work Map not available</h1><p class="muted">${esc(m.error)}</p><a class="btn" href="#/">Home</a></section>`, { dark: false });
  if (!m.steps && !m.building) return shell(`<section class="now-wait"><h1>No Work Map yet</h1><p class="muted">This session ${m.status === "capturing" ? "is still open. Start it again from Home, or finish it to build the map." : "ended without enough to build a map."}</p><a class="btn" href="#/">Home</a></section>`, { dark: false });
  if (m.building || !m.steps) { clearTimeout(mapTimer); mapTimer = setTimeout(() => loadMap(id), 2500); return shell(`<section class="now-wait">${orb("thinking", 72)}<h1>Building your Work Map</h1><p class="muted">Moti is putting the steps, reasons and guardrails together from what you showed and said.</p></section>`, { dark: false }); }
  const inDebrief = live && live.mode === "debrief";
  return shell(`<section class="map" aria-labelledby="map-h">
    <div class="map-head"><div><div class="eyebrow">Work Map · v${m.version} · ${esc(m.expertName)}</div><h1 id="map-h">${esc(m.title)}</h1>
      <p class="muted">${m.counts.steps} steps · ${m.counts.judgments} judgment calls · ${m.counts.guardrails} guardrails · ${m.status === "confirmed" ? "confirmed by the expert" : "not yet confirmed"}</p></div>
      <div class="row wrap">${m.status === "confirmed" ? `<a class="btn primary" href="#/practice/${m.sessionId}">Practise this</a><a class="btn" href="/api/maps/${m.sessionId}/export" download>Export for agents</a>` : ""}</div></div>
    ${m.mine && m.status !== "confirmed" ? `<div class="map-debrief">${inDebrief ? `${conversation()}${typeBox()}<div class="row"><button class="primary sm" data-act="map-debrief-done">Finish the debrief</button></div>`
      : `<p>${m.unclear.length ? `Moti still has ${m.unclear.length} question${m.unclear.length === 1 ? "" : "s"}. ${voiceReady() ? "A short spoken debrief ends with Moti explaining it all back to you." : "Answer them in a short typed debrief."}` : "Moti can explain the whole process back to you to check it understood."}</p>
        <div class="row wrap"><button class="primary" data-act="map-debrief">${icon(voiceReady() ? "mic" : "text", 15)} Start the debrief</button>
          ${m.steps.length ? `<button data-act="map-confirm">Yes, that's how it works</button>` : ""}</div>
        ${m.unclear.length ? `<details><summary>What Moti is unsure about</summary><ul>${m.unclear.map((u) => `<li>${esc(u.question)} <span class="muted small">${esc(u.why)}</span></li>`).join("")}</ul></details>` : ""}`}</div>` : ""}
    ${m.steps.length ? `<ol class="map-steps">${m.steps.map((s, i) => step(s, i, m.steps.length)).join("")}</ol>` : `<p class="callout">No steps yet. ${state.config?.ai === "vertex" ? "Moti could not build them from this session; the debrief adds what is missing." : "AI is offline here, so steps cannot be built. Your words are saved and the map is built when AI is available."}</p>`}
  </section>`, { dark: false });
}

function step(s, i, n) {
  const mo = s.moments?.[0];
  const KIND = { limit: "Limit", exception: "Exception", stop_and_ask: "Stop and ask", never: "Never" };
  return `<li class="map-step ${s.isJudgment ? "judgment" : ""}"><div class="map-num" aria-hidden="true">${i + 1}</div><div class="map-body">
    <div class="eyebrow">Step ${i + 1} of ${n}${s.isJudgment ? " · judgment call" : ""}${mo?.offsetSec != null ? ` · ${Math.floor(mo.offsetSec / 60)}:${String(mo.offsetSec % 60).padStart(2, "0")}` : ""}</div>
    <h2 class="h3">${esc(s.title)}</h2>
    <dl class="kv left small"><dt>Screen moment</dt><dd>${mo ? `<details><summary>${esc(mo.text || "Show the moment")}</summary>${mo.mediaId ? `<img src="/api/media/${mo.mediaId}" alt="The expert's screen at this step: ${esc(mo.text || s.title)}" loading="lazy" class="map-frame">` : ""}</details>` : "Not linked"}</dd>
      <dt>Decision</dt><dd>${esc(s.decision || s.action)}</dd>
      <dt>Reason</dt><dd>${s.reason?.text ? `${esc(s.reason.text)}${s.reason.quote ? `<blockquote class="quote">“${esc(s.reason.quote)}”${s.reason.quoteEn && s.reason.quoteEn !== s.reason.quote ? `<span class="small muted"> · English: ${esc(s.reason.quoteEn)}</span>` : ""}</blockquote>` : ` <span class="tag">AI-inferred, not said by the expert</span>`}` : `<span class="muted">Not explained</span>`}</dd>
      <dt>Guardrails</dt><dd>${s.guardrails.length ? `<ul class="plain">${s.guardrails.map((g) => `<li><b>${KIND[g.kind] ?? g.kind}:</b> ${esc(g.text)}${g.quote ? ` <span class="small muted">“${esc(g.quote)}”</span>` : ` <span class="tag">AI-inferred</span>`}</li>`).join("")}</ul>` : `<span class="muted">None recorded</span>`}</dd></dl>
  </div></li>`;
}

async function loadMap(id) {
  try { view.map = await api("GET", `/api/maps/${id}`); render(); }
  catch (e) { view.map = { sessionId: id, error: e.message }; toast(e.message, true); render(); }
}

// ---------------------------------------------------------------- practice (tutor)
export function practiceView(r) {
  if (!view.map || view.map.sessionId !== r.id) { loadMap(r.id); return shell(`<span class="thinking">Loading</span>`); }
  const m = view.map;
  if (view.run?.result) {
    const name = (ids) => ids.map((x) => m.steps.find((s) => s.id === x)?.title ?? x);
    return shell(`<section class="now-consent" aria-labelledby="p-h"><h1 id="p-h">Practice finished</h1><p>${esc(view.run.result.summary)}</p>
      <h2 class="h3">Handled well</h2><ul>${name(view.run.result.mastered).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>None yet</li>"}</ul>
      <h2 class="h3">Practise next</h2><ul>${name(view.run.result.practise).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>Nothing flagged</li>"}</ul>
      <p class="small muted">A practice result in a live session, not a certification.</p><a class="btn" href="#/map/${m.sessionId}">Back to the Work Map</a></section>`);
  }
  if (view.status === "idle") {
    return shell(`<section class="now-consent" aria-labelledby="p-h"><h1 id="p-h">Practise: ${esc(m.title)}</h1>
      <p>Do the task on your own screen. Moti learned it from ${esc(m.expertName)}. It will ask you to predict decisions and step in before a guardrail is broken, replaying ${esc(m.expertName)}'s moment when it helps. Your screen is shown to Moti only; nothing from it is stored.</p>
      <div class="field"><label for="now-lang">Teach me in</label><select id="now-lang">${LANG_OPTIONS.map((l) => `<option value="${l.code}" lang="${l.code}" ${l.code === (state.me?.user?.language || "en") ? "selected" : ""}>${esc(l.native)}${l.native !== l.name ? ` (${esc(l.name)})` : ""}</option>`).join("")}</select></div>
      <div class="row"><button class="primary lg" data-act="practice-start">${icon("play", 16)} Share my screen and start</button></div></section>`);
  }
  return shell(`<div class="now-stage screen"><div class="now-video"><video id="now-video" aria-label="Your shared screen" muted playsinline></video>
      ${view.moment ? `<figure class="now-moment" role="dialog" aria-label="How ${esc(m.expertName)} did it"><figcaption>How ${esc(m.expertName)} did it: ${esc(view.moment.title)}</figcaption><img src="/api/media/${view.moment.mediaId}" alt="${esc(m.expertName)}'s screen at this step"><button class="sm" data-act="moment-close">Close</button></figure>` : ""}</div>
    <aside class="now-panel" aria-labelledby="moti-h"><div class="row">${orb(view.status === "speaking" ? "asking" : "observing", 44, { caption: false })}<h2 id="moti-h" class="h3">Moti, your tutor</h2></div>
      ${conversation()}${typeBox()}
      <div class="row"><button class="primary sm" data-act="practice-finish">I'm finished</button></div></aside></div>`);
}

// ---------------------------------------------------------------- events
// Enter sends the typed line (the button stays for pointer and switch users).
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "now-say" && !e.isComposing) { e.preventDefault(); document.querySelector('[data-act="now-say"]')?.click(); } });
export async function nowClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return false;
  const a = el.dataset.act;
  if (a === "now-start") {
    const kind = el.dataset.kind, language = document.getElementById("now-lang")?.value ?? "en", name = state.drafts["now-name"] ?? "";
    try {
      state.busy = "live"; render();
      const s = await api("POST", "/api/live/start", { kind, name, language });
      await api("POST", `/api/sessions/${s.sessionId}/consent`, { modalities: [kind === "camera" ? "CAMERA" : "SCREEN", "MICROPHONE"], clientTime: Date.now() });
      view.status = "starting"; view.sessionId = s.sessionId; state.busy = null; render();
      await connect({ mode: "capture", sessionId: s.sessionId, language, video: kind }).start(document.getElementById("now-video"));
      announce(voiceReady() ? "Moti is listening. Work as you normally would." : "Live voice is unavailable here. Type what you are doing and why.");
    } catch (err) { state.busy = null; view.status = "idle"; leaveNow(); toast(err.message || "Could not start", true); render(); }
    return true;
  }
  if (a === "now-offrec") { live?.setOffRecord(!view.offRecord); return true; }
  if (a === "now-finish") { live?.finish(); announce("Finishing. Moti is building your Work Map."); return true; }
  if (a === "now-say") {
    const text = (state.drafts["now-say"] ?? "").trim();
    if (!text) { document.getElementById("now-say")?.focus(); return true; }
    state.drafts["now-say"] = ""; live?.say(text); render(); return true;
  }
  if (a === "map-debrief") {
    try {
      view.lines = voiceReady() ? [] : view.map.unclear.map((u) => ({ who: "moti", text: u.question }));
      await connect({ mode: "debrief", sessionId: view.map.sessionId, language: view.map.language, video: null }).start(null); announce("Debrief started. Moti will ask a few questions."); render(); }
    catch (err) { leaveNow(); toast(err.message, true); }
    return true;
  }
  if (a === "map-debrief-done") { live?.finish(); return true; }
  if (a === "map-confirm") {
    try { await api("POST", `/api/maps/${view.map.sessionId}/confirm`, {}); announce("Work Map confirmed."); await loadMap(view.map.sessionId); }
    catch (err) { toast(err.message, true); }
    return true;
  }
  if (a === "practice-start") {
    const language = document.getElementById("now-lang")?.value ?? "en";
    try { view.lines = []; view.status = "starting"; render(); await connect({ mode: "tutor", sessionId: view.map.sessionId, language, video: "screen" }).start(document.getElementById("now-video")); }
    catch (err) { leaveNow(); view.map = null; toast(err.message, true); render(); }
    return true;
  }
  if (a === "practice-finish") { live?.say("I'm finished."); return true; }
  if (a === "moment-close") { view.moment = null; render(); return true; }
  return false;
}

/** Signed-in home: one action, then your maps. Enterprise tools stay in the menu. */
let maps = null;
export function homeNow() {
  if (!maps) { api("GET", "/api/maps").then((m) => { maps = m; render(); }).catch(() => { maps = []; render(); }); }
  const work = !isLiving();
  return `<section class="home-now" aria-labelledby="hn-h"><h1 id="hn-h">${work ? "Capture how the work is really done" : "Show what you know"}</h1>
    <div class="row wrap">${work ? `<a class="btn primary lg" href="#/start/screen">${icon("screen", 18)} Start with your screen</a><a class="btn lg" href="#/start/camera">${icon("camera", 18)} Use the camera</a>`
      : `<a class="btn primary lg" href="#/start/camera">${icon("camera", 18)} Start with your camera</a><a class="btn lg" href="#/start/screen">${icon("screen", 18)} Share a screen</a>`}</div>
    <h2 class="h3" style="margin-top:28px">Work Maps</h2>
    ${maps === null ? `<span class="thinking small">Loading</span>` : maps.length ? `<ul class="plain map-list">${maps.map((m) => `<li><a href="#/map/${m.sessionId}"><b>${esc(m.title)}</b></a> <span class="small muted">${esc(m.expertName)} · ${m.steps} steps · ${m.status === "confirmed" ? "confirmed" : "draft"}</span></li>`).join("")}</ul>`
      : `<p class="muted">None yet. Your first session becomes your first Work Map.</p>`}
  </section>`;
}
export function invalidateNow() { maps = null; }
export { langName };
