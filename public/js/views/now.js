// The minimal product surface: choose screen or camera → one consent card → straight into work with Moti.
//   #/start/screen | #/start/camera   live capture (Moti listens, watches, asks at pauses)
//   #/map/:sessionId                  the Work Map, the voice debrief + teach-back, confirmation, export for agents
//   #/practice/:sessionId             a new hire practises on their own screen; Moti tutors from the confirmed map
// Every live screen has a typed alternative to speaking, an off-the-record control, and a visible, announced state.
import { state, api, esc, render, toast, go, isLiving, ago, route } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { announce } from "../a11y.js";
import { LiveMoti, liveSupport } from "../live.js";
import { LANGS, langName } from "../i18n.js";

let live = null, mapTimer = null, view = { lines: [], status: "idle", offRecord: false, consent: null, map: null, run: null, moment: null, error: null };
const STATE_WORDS = { idle: "Not started", starting: "Starting", live: "Moti is listening", speaking: "Moti is speaking", ending: "Wrapping up", closed: "Disconnected", ended: "Ended" };
const LANG_OPTIONS = [...LANGS, { code: "hi", name: "Hindi", native: "हिन्दी" }, { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" }];

/** After each render: keep the camera / screen visible (the <video> element is new every time the page re-renders). */
let videoNode = null;
export function nowAfterRender() {
  const fresh = document.getElementById("now-video");
  if (!fresh || !live?.attachVideo) { if (!fresh) videoNode = null; return; }
  // Move the already-playing element into the new page instead of starting a new one: no black flash, no lost stream.
  if (videoNode && videoNode !== fresh && videoNode.srcObject) { fresh.replaceWith(videoNode); videoNode.play?.().catch(() => {}); live.attachVideo(videoNode); return; }
  live.attachVideo(fresh); if (fresh.srcObject) videoNode = fresh;
}

// Detach first, then close: closing reports "ended", and a report must never re-enter leaveNow (that recursed until
// the call stack overflowed when someone navigated away mid-session).
/** True while a live capture or practice is running: page-level Back is hidden so it cannot end it by accident. */
export const nowBusy = () => Boolean(live) && !["idle", "ended", "closed"].includes(view.status);

export function leaveNow() { clearTimeout(mapTimer); videoNode = null; const old = live; live = null; old?.close(); view = { lines: [], status: "idle", offRecord: false, consent: null, map: null, run: null, moment: null, error: null }; }

function shell(inner, { dark = true } = {}) {
  return `<div class="now-root ${dark ? "dark" : ""}"><header class="now-head"><a class="now-brand" href="#/">${orb("observing", 26, { caption: false })}<span>Agamya</span></a>
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
      ${can ? "" : `<p class="callout" role="alert">${!sup.mic ? "This browser cannot record audio here." : kind === "screen" ? `This device's browser cannot share its screen (phones and tablets cannot). <a href="#/start/camera">Use the camera instead</a>, or open Agamya on a computer.` : "No camera is available."}${kind === "screen" && sup.mic ? "" : " You can still type your explanation once started."}</p>`}
      <div class="row"><button class="primary lg" data-act="now-start" data-kind="${kind}" ${state.busy || (kind === "screen" && voiceReady() && !sup.screen) ? "disabled" : ""}>${icon("play", 16)} I agree, start</button><a class="btn ghost" href="#/">Not now</a></div>
    </section>`);
  }
  return shell(`<div class="now-stage ${kind}">
    <div class="now-video">${kind === "camera" && !(live instanceof TypedMoti) ? `<button class="sm now-flip" data-act="flip-camera">Switch camera</button>` : ""}${live instanceof TypedMoti ? `<p class="now-typed">Typed session: nothing from your ${kind} is captured.</p>` : `<video id="now-video" aria-label="${kind === "camera" ? "Your camera" : "Your shared screen"}" muted playsinline></video>`}
      ${view.offRecord ? `<div class="now-offrec" role="status">Off the record: nothing is being captured</div>` : ""}</div>
    <aside class="now-panel" aria-labelledby="moti-h"><div class="row">${orb(view.status === "speaking" ? "asking" : "observing", 44, { caption: false })}<h2 id="moti-h" class="h3">Moti</h2></div>
      ${conversation()}
      ${typeBox()}
      <div class="row wrap now-controls"><button class="sm" data-act="now-offrec" aria-pressed="${view.offRecord}">${view.offRecord ? "Back on the record" : "Off the record"}</button>
        <button class="ghost sm" data-act="terminate-session" data-id="${view.sessionId ?? ""}">Terminate</button>
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
  // Every callback checks that this session is still the active one: a closed session's late events are ignored.
  const mine = (fn) => (...a) => { if (live === me) fn(...a); };
  const me = live = new (voiceReady() || o.mode === "tutor" ? LiveMoti : TypedMoti)({ ...o,
    onMoti: mine((text) => { view.lines.push({ who: "moti", text }); announce(`Moti: ${text}`); render(); }),
    onYou: mine((text) => { view.lines.push({ who: "you", text }); render(); }),
    onStatus: mine((m) => { if (m.offRecord !== undefined) { view.offRecord = m.offRecord; announce(m.offRecord ? "Off the record." : "Back on the record."); }
      if (m.phaseDone) { const id = o.sessionId; leaveNow(); go(`#/map/${id}`); return; }
      if (m.finished) { view.run = { result: m.finished }; announce("Practice finished."); }
      if (m.intervention) announce("Moti stopped a decision. Listen to why.");
      render(); }),
    onMoment: mine((m) => { view.moment = m; announce(`Showing how the expert did step: ${m.title}`); render(); }),
    onError: mine((msg) => { view.error = msg; toast(msg, true); render(); }),
    onState: mine((s) => { view.status = s; render(); }),
  });
  return live;
}

// ---------------------------------------------------------------- Work Map + debrief
export function mapView(r) {
  const id = r.id;
  if (!view.map || view.map.sessionId !== id) { loadMap(id); return shell(`<span class="thinking">Loading the Work Map</span>`, { dark: false }); }
  const m = view.map;
  if (m.error) return notAvailable(m);
  if (!m.steps && !m.building) return shell(`<section class="now-wait"><h1>No Work Map yet</h1><p class="muted">This session ${m.status === "capturing" ? "was not finished. Build the map from what was recorded, or terminate it." : "ended without enough to build a map."}</p>
    <div class="row">${m.status === "capturing" ? `<button class="primary" data-act="finish-session" data-id="${m.sessionId}">Build the Work Map</button><button class="ghost" data-act="terminate-session" data-id="${m.sessionId}">Terminate</button>` : ""}<a class="btn" href="#/">Home</a></div></section>`, { dark: false });
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
    ${m.canShare ? sharePanel(m) : ""}
    ${m.steps?.length ? listenPanel(m) : ""}
    ${m.status === "confirmed" && m.mine ? agentsPanel(m) : ""}
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

// ---------------------------------------------------------------- sharing: who should learn from this?
let shareData = null, shareFor = null, justConfirmed = null, shareOpen = false;
function sharePanel(m) {
  if (shareFor !== m.sessionId) {
    shareFor = m.sessionId; shareData = null; shareOpen = false;
    Promise.all([api("GET", "/api/groups").catch(() => ({ groups: [] })), api("GET", "/api/people").catch(() => [])])
      .then(([g, p]) => { shareData = { groups: g.groups ?? [], people: p.filter((x) => x.has_login) }; render(); });
  }
  const s = m.sharing ?? { visibility: "private", people: [], groups: [], chosen: false };
  const space = state.me?.org?.name ?? "this space";
  const who = s.visibility === "organization" ? `everyone in ${space}` : s.visibility === "named" ? [...s.groups.map((g) => `group ${g.name}`), ...s.people.map((p) => p.name)].join(", ") || "chosen people" : "only you (and space admins)";
  const asking = justConfirmed === m.sessionId || shareOpen;
  const pickedP = new Set(s.people.map((x) => x.id)), pickedG = new Set(s.groups.map((x) => x.id));
  return `<section class="share card pad stack" aria-labelledby="sh-h">
    <div class="row between wrap"><h2 id="sh-h" class="h3">${justConfirmed === m.sessionId ? "Confirmed. Who should learn from this?" : "Who can learn from this"}</h2>
      ${asking ? "" : `<button class="sm" data-act="share-open">Share</button>`}</div>
    <p class="small">${m.status === "confirmed" ? `Visible to <b>${esc(who)}</b>.` : `Once you confirm it, it will be visible to <b>${esc(who)}</b>.`} <span class="muted">The expert, and the space's admins and coordinators, can change this at any time.</span></p>
    ${asking ? (!shareData ? `<span class="thinking small">Loading people and groups</span>` : `<fieldset class="stack"><legend class="sr-only">Who can see this Work Map</legend>
      <label class="check"><input type="radio" name="sh-vis" value="organization" ${s.visibility === "organization" ? "checked" : ""}> Everyone in ${esc(space)}</label>
      <label class="check"><input type="radio" name="sh-vis" value="named" ${s.visibility === "named" ? "checked" : ""}> Chosen groups and people</label>
      <div class="sh-pick stack">
        ${shareData.groups.length ? `<div class="small"><b>Groups</b><div class="row wrap">${shareData.groups.map((g) => `<label class="check chip-check"><input type="checkbox" data-sh-group value="${g.id}" ${pickedG.has(g.id) ? "checked" : ""}> ${esc(g.name)}</label>`).join("")}</div></div>` : `<p class="small muted">No groups yet. <a href="#/groups">Create one</a>.</p>`}
        ${shareData.people.filter((p) => p.display_name !== m.expertName).length ? `<div class="small"><b>People</b><div class="row wrap">${shareData.people.filter((p) => p.display_name !== m.expertName).map((p) => `<label class="check chip-check"><input type="checkbox" data-sh-person value="${p.id}" ${pickedP.has(p.id) ? "checked" : ""}> ${esc(p.display_name)}</label>`).join("")}</div></div>` : `<p class="small muted">Nobody else is in this space yet. Invite people from People.</p>`}
      </div>
      <label class="check"><input type="radio" name="sh-vis" value="private" ${s.visibility === "private" ? "checked" : ""}> Only me (and space admins)</label></fieldset>
      <div class="row"><button class="primary sm" data-act="share-save">Save</button>${justConfirmed === m.sessionId ? `<button class="ghost sm" data-act="share-later">Decide later</button>` : `<button class="ghost sm" data-act="share-later">Cancel</button>`}</div>`) : ""}
  </section>`;
}

// ---------------------------------------------------------------- listen (narration in the learner's language)
const LISTEN = [["en", "English"], ["hi", "हिन्दी (Hindi)"], ["mr", "मराठी (Marathi)"], ["kn", "ಕನ್ನಡ (Kannada)"], ["bn", "বাংলা (Bengali)"], ["ta", "தமிழ் (Tamil)"], ["te", "తెలుగు (Telugu)"],
  ["gu", "ગુજરાતી (Gujarati)"], ["ml", "മലയാളം (Malayalam)"], ["pa", "ਪੰਜਾਬੀ (Punjabi)"], ["ja", "日本語 (Japanese)"], ["ko", "한국어 (Korean)"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"]];
let heard = null, hearing = false, listenLang = null;
function listenPanel(m) {
  const lang = listenLang ?? (state.me?.user?.language || "en");
  return `<section class="listen card pad stack" aria-labelledby="ls-h"><h2 id="ls-h" class="h3">Listen to this Work Map</h2>
    <p class="small muted">A short spoken lesson of ${esc(m.expertName)}'s process, in your language. ${esc(m.expertName)}'s own words are kept as they said them.</p>
    <div class="row wrap"><label class="sr-only" for="ls-lang">Language</label><select id="ls-lang" style="width:auto">${LISTEN.map(([c, l]) => `<option value="${c}" lang="${c}" ${c === lang ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      <button class="sm" data-act="listen" ${hearing ? "disabled" : ""}>${hearing ? "Preparing (about 30 seconds the first time)" : "Listen"}</button></div>
    ${heard && heard.sessionId === m.sessionId ? `${heard.audioUrl ? `<audio controls src="${esc(heard.audioUrl)}" preload="auto" style="width:100%"></audio>` : `<p class="small muted">Audio is unavailable right now; the transcript is below.</p>`}
      ${heard.reviewed ? "" : `<p class="small"><span class="tag">${esc(heard.languageName)}: not yet reviewed by a native speaker</span></p>`}
      <details open><summary>Transcript</summary><p lang="${esc(heard.language)}" style="white-space:pre-wrap">${esc(heard.script)}</p></details>` : ""}
  </section>`;
}

// ---------------------------------------------------------------- guardrail agents (confirmed maps, owner)
let agents = null, agentsFor = null, newKey = null, tryResult = null;
const VERDICT = { STOP: ["Stop", "red"], ASK: ["Ask a person", "amber"], PROCEED: ["Proceed", "green"], NOT_COVERED: ["Not covered: ask a person", ""], UNAVAILABLE: ["Check unavailable: ask a person", ""] };
const refreshAgents = (id) => api("GET", `/api/maps/${id}/agents`).then((x) => { agents = x; render(); }).catch(() => { agents = agents ?? { keys: [], checks: [], endpoints: {} }; render(); });
function agentsPanel(m) {
  // New map: start clean. Same map: keep the latest answer and key on screen while the lists refresh.
  if (agentsFor !== m.sessionId) { agentsFor = m.sessionId; agents = null; newKey = null; tryResult = null; refreshAgents(m.sessionId); }
  const v = tryResult && VERDICT[tryResult.verdict];
  return `<section class="agents card pad stack" aria-labelledby="ag-h">
    <h2 id="ag-h" class="h3">Use this Work Map with AI agents</h2>
    <p class="small muted">Before an AI agent or a new colleague acts, they ask: would ${esc(m.expertName)} stop here? The answer comes from this confirmed map, with ${esc(m.expertName)}'s own words.</p>
    <div class="row wrap"><label class="sr-only" for="ag-try">Describe an action to check</label><input id="ag-try" data-draft="ag-try" placeholder="Post invoice INV-204 for ₹72,000 from a new supplier" style="flex:1;min-width:240px">
      <button class="sm" data-act="agent-try">Would ${esc(m.expertName)} stop here?</button></div>
    ${tryResult ? `<div class="verdict" role="status"><span class="tag ${v?.[1] ?? ""}">${esc(v?.[0] ?? tryResult.verdict)}</span>${tryResult.stepTitle ? ` <span class="small muted">Step: ${esc(tryResult.stepTitle)}</span>` : ""}
      <p>${esc(tryResult.explanation ?? "")}</p>${tryResult.guardrail?.expertQuote ? `<blockquote class="quote">“${esc(tryResult.guardrail.expertQuote)}” <span class="small muted">· ${esc(m.expertName)}</span></blockquote>` : tryResult.guardrail ? `<p class="small"><span class="tag">AI-inferred guardrail</span> ${esc(tryResult.guardrail.text)}</p>` : ""}</div>` : ""}
    <details ${newKey ? "open" : ""}><summary>Connect an agent (MCP, REST, Google ADK)</summary>
      <div class="stack" style="margin-top:10px">
        <div class="row wrap"><label class="sr-only" for="ag-label">Agent name</label><input id="ag-label" data-draft="ag-label" placeholder="Accounts-payable assistant" style="flex:1;min-width:200px"><button class="sm primary" data-act="agent-key">Create a key</button></div>
        ${newKey ? `<div class="callout small stack" role="status"><b>Copy this key now: it is shown only once.</b><code style="word-break:break-all">${esc(newKey.key)}</code>
          <div><b>MCP</b> (Claude, Gemini CLI, any MCP client): <code>${esc(newKey.endpoints.mcp)}</code> with header <code>Authorization: Bearer &lt;key&gt;</code></div>
          <div><b>REST</b>: <code style="word-break:break-all">curl -X POST ${esc(newKey.endpoints.check)} -H "Authorization: Bearer &lt;key&gt;" -H "content-type: application/json" -d '{"action":"Post the 72,000 invoice"}'</code></div>
          <div><b>Google ADK agent</b> (Vertex AI Agent Engine): set <code>AGAMYA_URL</code> and <code>AGAMYA_AGENT_KEY</code>, see <code>agents/guardrail_agent</code>.</div></div>` : ""}
        ${agents?.keys?.length ? `<ul class="plain small">${agents.keys.map((k) => `<li>${esc(k.label)} · …${esc(k.hint)} · ${k.revoked ? "revoked" : k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "not used yet"} ${k.revoked ? "" : `<button class="ghost sm" data-act="agent-revoke" data-id="${k.id}">Revoke</button>`}</li>`).join("")}</ul>` : ""}
      </div></details>
    ${agents?.checks?.length ? `<details><summary>Recent checks (${agents.checks.length})</summary><ul class="plain small">${agents.checks.map((c) => `<li><span class="tag ${VERDICT[c.verdict]?.[1] ?? ""}">${esc(VERDICT[c.verdict]?.[0] ?? c.verdict)}</span> ${esc(c.action)} <span class="muted">· ${esc(c.via)} · ${ago(c.at)}</span></li>`).join("")}</ul></details>` : ""}
  </section>`;
}

/** A map this person cannot open (or that does not exist): say so and offer the way forward, without revealing more. */
function notAvailable(m) {
  return shell(`<section class="now-wait"><h1>This Work Map is not available to you</h1>
    <p class="muted">It does not exist, or its expert has not shared it with you yet. You can ask for access from the Learning page; the expert or a space admin decides.</p>
    <div class="row"><a class="btn primary" href="#/learn">Go to Learning</a><a class="btn" href="#/">Home</a></div></section>`, { dark: false });
}

async function loadMap(id) {
  try { view.map = await api("GET", `/api/maps/${id}`); render(); }
  catch (e) { view.map = { sessionId: id, error: e.message }; if (e.status !== 404) toast(e.message, true); render(); }
}

// ---------------------------------------------------------------- practice (tutor)
export function practiceView(r) {
  if (!view.map || view.map.sessionId !== r.id) { loadMap(r.id); return shell(`<span class="thinking">Loading</span>`); }
  const m = view.map;
  if (m.error) return notAvailable(m);
  if (m.status !== "confirmed") return shell(`<section class="now-wait"><h1>Not ready for practice yet</h1><p class="muted">Practice opens once the expert confirms this Work Map.</p><a class="btn" href="#/map/${esc(m.sessionId)}">Open the Work Map</a></section>`, { dark: false });
  if (view.run?.result) {
    const name = (ids) => ids.map((x) => m.steps.find((s) => s.id === x)?.title ?? x);
    return shell(`<section class="now-consent" aria-labelledby="p-h"><h1 id="p-h">Practice finished</h1><p>${esc(view.run.result.summary)}</p>
      <h2 class="h3">Handled well</h2><ul>${name(view.run.result.mastered).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>None yet</li>"}</ul>
      <h2 class="h3">Practise next</h2><ul>${name(view.run.result.practise).map((t) => `<li>${esc(t)}</li>`).join("") || "<li>Nothing flagged</li>"}</ul>
      <p class="small muted">A practice result in a live session, not a certification.</p><a class="btn" href="#/map/${m.sessionId}">Back to the Work Map</a></section>`);
  }
  if (view.status === "idle") {
    return shell(`<section class="now-consent" aria-labelledby="p-h"><h1 id="p-h">Practise: ${esc(m.title)}</h1>
      <p>Do the task in front of your camera or on your screen. Moti learned it from ${esc(m.expertName)}. It will ask you to predict decisions and step in before a guardrail is broken, replaying ${esc(m.expertName)}'s moment when it helps. What Moti sees is not stored.</p>
      <div class="field"><label for="now-lang">Teach me in</label><select id="now-lang">${LANG_OPTIONS.map((l) => `<option value="${l.code}" lang="${l.code}" ${l.code === (state.me?.user?.language || "en") ? "selected" : ""}>${esc(l.native)}${l.native !== l.name ? ` (${esc(l.name)})` : ""}</option>`).join("")}</select></div>
      <div class="row wrap"><button class="primary lg" data-act="practice-start" data-kind="camera" ${liveSupport().camera ? "" : "disabled"}>${icon("camera", 16)} Start with my camera</button>
        <button class="lg" data-act="practice-start" data-kind="screen" ${liveSupport().screen ? "" : "disabled"}>${icon("screen", 16)} Share my screen</button></div>
      ${liveSupport().screen ? "" : `<p class="small muted">This browser cannot share its screen (phones and tablets cannot). Use the camera, or a computer for screen sharing.</p>`}</section>`);
  }
  const pv = live?.video === "camera" ? "camera" : "screen";
  return shell(`<div class="now-stage ${pv}"><div class="now-video"><video id="now-video" aria-label="${pv === "camera" ? "Your camera" : "Your shared screen"}" muted playsinline></video>
      ${pv === "camera" ? `<button class="sm now-flip" data-act="flip-camera">Switch camera</button>` : ""}
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
    } catch (err) {
      // Nothing was recorded (for example the microphone or screen permission was refused): do not leave an empty
      // "recording" session behind.
      const sid = view.sessionId; state.busy = null; leaveNow();
      if (sid) api("POST", `/api/sessions/${sid}/terminate`, { confirm: true }).catch(() => {});
      const denied = /Permission|NotAllowed|denied/i.test(`${err.name} ${err.message}`);
      toast(denied ? "Agamya needs permission to use the microphone and your screen or camera. Allow it in the browser and try again." : err.message || "Could not start", true); render();
    }
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
  if (a === "share-open") { shareOpen = true; render(); document.querySelector('input[name="sh-vis"]:checked, input[name="sh-vis"]')?.focus(); return true; }
  if (a === "share-later") { shareOpen = false; justConfirmed = null; render(); return true; }
  if (a === "share-save") {
    const visibility = document.querySelector('input[name="sh-vis"]:checked')?.value;
    if (!visibility) { toast("Choose who can see it.", true); return true; }
    const people = [...document.querySelectorAll("[data-sh-person]:checked")].map((x) => x.value), groups = [...document.querySelectorAll("[data-sh-group]:checked")].map((x) => x.value);
    try {
      await api("POST", `/api/maps/${view.map.sessionId}/sharing`, { visibility, people, groups });
      shareOpen = false; justConfirmed = null; announce("Sharing saved."); toast("Sharing saved."); await loadMap(view.map.sessionId);
    } catch (err) { toast(err.message, true); }
    return true;
  }
  if (a === "listen") {
    const language = document.getElementById("ls-lang")?.value ?? "en"; listenLang = language;
    hearing = true; render(); announce("Preparing the spoken lesson.");
    try { heard = { ...(await api("GET", `/api/maps/${view.map.sessionId}/listen?language=${encodeURIComponent(language)}`)), sessionId: view.map.sessionId }; announce("Ready. Press play on the audio player, or read the transcript."); }
    catch (err) { toast(err.message, true); }
    hearing = false; render(); return true;
  }
  if (a === "agent-try") {
    const action = (state.drafts["ag-try"] ?? "").trim();
    if (!action) { document.getElementById("ag-try")?.focus(); return true; }
    try { el.disabled = true; tryResult = await api("POST", `/api/maps/${view.map.sessionId}/check`, { action }); announce(`${VERDICT[tryResult.verdict]?.[0] ?? tryResult.verdict}. ${tryResult.explanation}`); refreshAgents(view.map.sessionId); }
    catch (err) { toast(err.message, true); }
    render(); return true;
  }
  if (a === "agent-key") {
    try { newKey = await api("POST", `/api/maps/${view.map.sessionId}/agent-keys`, { label: state.drafts["ag-label"] ?? "" }); state.drafts["ag-label"] = ""; refreshAgents(view.map.sessionId); announce("Key created. Copy it now: it is shown only once."); }
    catch (err) { toast(err.message, true); }
    render(); return true;
  }
  if (a === "agent-revoke") {
    if (!confirm("Revoke this key? Agents using it stop working at once.")) return true;
    try { await api("POST", `/api/maps/${view.map.sessionId}/agent-keys/${el.dataset.id}/revoke`, {}); newKey = null; refreshAgents(view.map.sessionId); toast("Key revoked."); }
    catch (err) { toast(err.message, true); }
    render(); return true;
  }
  if (a === "map-confirm") {
    try { await api("POST", `/api/maps/${view.map.sessionId}/confirm`, {}); justConfirmed = view.map.sessionId; announce("Work Map confirmed. Choose who should learn from it."); await loadMap(view.map.sessionId); document.getElementById("sh-h")?.scrollIntoView({ block: "center" }); }
    catch (err) { toast(err.message, true); }
    return true;
  }
  if (a === "practice-start") {
    const language = document.getElementById("now-lang")?.value ?? "en";
    const kind = el.dataset.kind === "screen" ? "screen" : "camera";
    try { view.lines = []; view.status = "starting"; render(); await connect({ mode: "tutor", sessionId: view.map.sessionId, language, video: kind }).start(document.getElementById("now-video")); }
    catch (err) {
      const keep = view.map; leaveNow(); view.map = keep; // stay on this page with the choice still available
      toast(/Permission|NotAllowed|denied/i.test(`${err.name} ${err.message}`) ? "Allow the camera and microphone in the browser, then try again." : err.message, true); render();
    }
    return true;
  }
  if (a === "flip-camera") { try { await live?.flipCamera(); } catch (err) { toast(err.message, true); } return true; }
  if (a === "practice-finish") { live?.say("I'm finished."); return true; }
  if (a === "moment-close") { view.moment = null; render(); return true; }
  if (a === "finish-session") {
    try {
      await api("POST", `/api/live/${el.dataset.id}/finish`, { phase: "capture" });
      announce("Building the Work Map."); maps = null; sessions = null; view.map = null; go(`#/map/${el.dataset.id}`); render();
    } catch (err) { toast(err.message, true); }
    return true;
  }
  if (a === "terminate-session") {
    const id = el.dataset.id || view.sessionId;
    if (!id || !confirm(`Terminate ${el.dataset.title ? `"${el.dataset.title}"` : "this session"}? Recording stops, what was captured is removed, and it cannot be resumed.`)) return true;
    try {
      if (live && view.sessionId === id) leaveNow();
      await api("POST", `/api/sessions/${id}/terminate`, { confirm: true });
      announce("Session terminated."); toast("Session terminated.");
      maps = null; sessions = null;
      if (route().name === "start") go("#/"); else render();
    } catch (err) { toast(err.message, true); }
    return true;
  }
  return false;
}

/** Signed-in home: one action, then your maps. Enterprise tools stay in the menu. */
let maps = null;
const SESSION_WORDS = { awaiting_consent: "Waiting for consent", capturing: "Recording (not finished)", processing: "Processing", analyzing: "Analysing", asking: "Moti has a question",
  extracting: "Drafting knowledge", validating: "Waiting for your review", done: "Done", no_judgment: "Done (nothing to confirm)", failed: "Failed", mapping: "Building the Work Map",
  debrief: "Ready: answer Moti's questions and confirm", mapped: "Confirmed Work Map" };
const UNFINISHED = new Set(["awaiting_consent", "capturing", "processing", "analyzing", "asking", "extracting", "validating", "mapping", "debrief", "failed"]);
let sessions = null, sessionsTimer = null;
function loadSessions() {
  api("GET", "/api/my/sessions").then((x) => {
    sessions = x; render();
    // While something is still being built, refresh quietly so the status changes without a reload.
    clearTimeout(sessionsTimer);
    if (x.some((y) => ["mapping", "processing", "analyzing", "extracting"].includes(y.status))) sessionsTimer = setTimeout(() => { if (location.hash === "" || location.hash === "#/") loadSessions(); }, 4000);
  }).catch(() => { sessions = []; render(); });
}

export function homeNow() {
  if (!maps) { api("GET", "/api/maps").then((m) => { maps = m; render(); }).catch(() => { maps = []; render(); }); }
  if (!sessions) { sessions = []; loadSessions(); }
  const work = !isLiving();
  return `<section class="home-now" aria-labelledby="hn-h"><h1 id="hn-h">${work ? "Capture how the work is really done" : "Show what you know"}</h1>
    <div class="row wrap">${work ? `<a class="btn primary lg" href="#/start/screen">${icon("screen", 18)} Start with your screen</a><a class="btn lg" href="#/start/camera">${icon("camera", 18)} Use the camera</a>`
      : `<a class="btn primary lg" href="#/start/camera">${icon("camera", 18)} Start with your camera</a><a class="btn lg" href="#/start/screen">${icon("screen", 18)} Share a screen</a>`}</div>
    ${sessions.length ? `<h2 class="h3" style="margin-top:28px">Your recent sessions</h2>
      <ul class="plain session-list">${sessions.map((x) => `<li><a href="${x.href}"><b>${esc(x.title)}</b></a>
        <span class="tag ${x.status === "mapped" || x.status === "done" ? "green" : x.status === "failed" ? "red" : ""}">${esc(SESSION_WORDS[x.status] ?? x.status)}</span>
        <span class="small muted">${ago(x.startedAt)}</span>
        ${x.mode === "live" && x.status === "capturing" ? `<button class="sm" data-act="finish-session" data-id="${x.id}">Build the Work Map</button>` : ""}
        ${UNFINISHED.has(x.status) ? `<button class="ghost sm" data-act="terminate-session" data-id="${x.id}" data-title="${esc(x.title)}">Terminate</button>` : ""}</li>`).join("")}</ul>` : ""}
    <h2 class="h3" style="margin-top:28px">Work Maps</h2>
    ${maps === null ? `<span class="thinking small">Loading</span>` : maps.length ? `<ul class="plain map-list">${maps.map((m) => `<li><a href="#/map/${m.sessionId}"><b>${esc(m.title)}</b></a> <span class="small muted">${esc(m.expertName)} · ${m.steps} steps · ${m.status === "confirmed" ? "confirmed" : "draft"}</span></li>`).join("")}</ul>`
      : `<p class="muted">None yet. Your first session becomes your first Work Map.</p>`}
  </section>`;
}
export function invalidateNow() { maps = null; sessions = null; }
export { langName };
