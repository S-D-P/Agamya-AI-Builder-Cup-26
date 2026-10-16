// Shell + router. One engine, two experiences: a workplace gets the work shell (sidebar, transfers, library, progress),
// a family / community space gets the living shell (simple top navigation, skills, my knowledge, sharing).
// All authorization is enforced by the server; navigation only reflects it.
import { accessClick, invalidateAccess } from "./views/access.js";
import { impactView, invalidateImpact } from "./views/impact.js";
import { state, api, esc, onRender, render, route, go, has, setWorkflow, workflow, act, isLiving, isSample, store, toast } from "./core.js";
import { icon } from "./icons.js";
import { authView, authClick, policiesView, policiesClick, brand, loadAuthConfig } from "./views/auth.js";
import { commandView, commandClick, invalidateCommand } from "./views/command.js";
import { workflowsView, workflowsClick, workflowsChange, invalidateWorkflow } from "./views/workflows.js";
import { captureView, sessionView, sessionClick, sessionChange, afterRender, leaveSession } from "./views/session.js";
import { knowledgeView, knowledgeClick, knowledgeChange, invalidateKnowledge } from "./views/knowledge.js";
import { apprenticeView, apprenticeClick, invalidateApprentice } from "./views/apprentice.js";
import { insightsView, insightsClick, invalidateInsights } from "./views/insights.js";
import { adminView, adminClick, invalidateAdmin } from "./views/admin.js";
import { transfersView, transfersClick, transfersChange, invalidateTransfers } from "./views/transfers.js";
import { progressView, invalidateProgress } from "./views/progress.js";
import { livingHomeView, journeyView, skillsView, sharingView, livingClick, livingChange, invalidateLiving } from "./views/living.js";
import { radarView, invalidateRadar } from "./views/radar.js";
import { spacesView, inboxView, spacesClick, spacesChange, firstRunGuide, loadInbox, invalidateSpaces } from "./views/spaces.js";
import { groupsView, groupsClick, groupsChange, invalidateGroups } from "./views/groups.js";
import { missionsView, missionsClick, missionsChange, invalidateMissions } from "./views/missions.js";
import { storageView, invalidateStorage } from "./views/storage.js";
import { invalidateAsk } from "./views/ask.js";
import { t, tp, uiLang, LANGS } from "./i18n.js";
import { announce } from "./a11y.js";
import { startView, mapView, practiceView, nowClick, leaveNow, homeNow, invalidateNow, nowAfterRender, nowBusy } from "./views/now.js";
const NOW = { start: startView, map: mapView, practice: practiceView };

const root = document.getElementById("app");
const E = "EXPERT", O = "WORKFLOW_OWNER", R = "REVIEWER", A = "ORG_ADMIN", L = "LEARNER", OWN = "ORG_OWNER", C = "KT_COORDINATOR", AU = "AUDITOR";
const SHARED_VIEWS = { spaces: [spacesView, () => {}, () => {}], inbox: [inboxView, () => {}], groups: [groupsView, groupsClick, groupsChange], missions: [missionsView, missionsClick, missionsChange] };

const WORK = {
  views: {
    home: [commandView, commandClick], transfers: [transfersView, transfersClick, transfersChange], workflows: [workflowsView, workflowsClick, workflowsChange],
    capture: [captureView, sessionClick, sessionChange], session: [sessionView, sessionClick, sessionChange], knowledge: [knowledgeView, knowledgeClick, knowledgeChange],
    progress: [progressView, () => {}], learn: [apprenticeView, apprenticeClick], insights: [insightsView, insightsClick], admin: [adminView, adminClick],
    radar: [radarView, () => {}], storage: [storageView, () => {}], impact: [impactView, () => {}], ...SHARED_VIEWS,
  },
  nav: [["home", "home", "Home", () => true], ["missions", "flows", "KT missions", () => true], ["radar", "alert", "Knowledge at risk", () => has(OWN, A, C, O, R, AU)], ["transfers", "users", "Knowledge transfers", () => true], ["workflows", "flows", "Workflows", () => true],
    ["knowledge", "knowledge", "Knowledge library", () => has(E, O, R, A)], ["groups", "users", "Groups", () => true], ["progress", "check", "Learner progress", () => has(A, O, R, L)],
    ["learn", "learn", "My lessons", () => has(L)], ["impact", "check", "Impact", () => true], ["insights", "insights", "Insights & AI cost", () => has(A, O, R)], ["storage", "coin", "Storage & AI", () => has(OWN, A, O, R, AU)], ["admin", "admin", "Administration", () => has(OWN, A, R, AU, C)]],
  workflowPicker: new Set(["capture", "knowledge", "learn", "insights", "progress"]),
};
const LIVING = {
  views: {
    home: [livingHomeView, livingClick], journey: [journeyView, livingClick], capture: [skillsView, livingClick, livingChange], session: [sessionView, sessionClick, sessionChange],
    knowledge: [knowledgeView, knowledgeClick, knowledgeChange], learn: [apprenticeView, apprenticeClick], sharing: [sharingView, livingClick, livingChange], people: [adminView, adminClick],
    workflows: [workflowsView, workflowsClick, workflowsChange], impact: [impactView, () => {}], ...SHARED_VIEWS,
  },
  nav: [["home", "home", "Home", () => true], ["capture", "capture", "Capture a skill", () => has(E)], ["knowledge", "knowledge", "My knowledge", () => true],
    ["learn", "learn", "Learning", () => true], ["groups", "users", "Groups", () => true], ["sharing", "share", "Sharing & permissions", () => has(E)], ["impact", "check", "Impact", () => true], ["missions", "flows", "Missions", () => has(A, C)], ["people", "users", "People", () => has(A)]],
};
const exp = () => (isLiving() ? LIVING : WORK);

// ---------------------------------------------------------------- shared chrome
function sampleBar() {
  if (!isSample()) return "";
  const living = state.me.org.sampleKind === "living";
  const people = state.samplePeople ?? [];
  return `<div class="sample-bar" role="note"><span><b>Sample space</b> · private to you · ${living ? "the kitchen camera is simulated (rendered frames) and suggested answers are scripted; you can edit or replace them" : "camera, screen and console feeds are simulated; suggested answers are scripted"} · AI processing is ${state.config?.ai === "vertex" ? "live" : "offline (fallbacks)"}</span>
    ${people.length ? `<label class="row small">View as <select id="sample-person" aria-label="View the sample as">${people.map((p) => `<option value="${p.id}" ${p.id === state.me.personId ? "selected" : ""}>${esc(p.display_name)} · ${esc(roleWord(p.roles))}</option>`).join("")}</select></label>` : ""}</div>`;
}
const roleWord = (roles = []) => (isLiving() ? (roles.includes(E) ? "teacher" : "learner") : roles.includes(A) ? "manager" : roles.includes(E) ? "expert" : roles.includes(L) ? "learner" : roles.includes(R) ? "reviewer" : "member");

/** Spaces and the inbox (invitations + notifications). The count is announced by its accessible name. */
function spaceLinks() {
  const n = state.unread ?? 0;
  return `<a class="btn ghost sm" href="#/spaces">${icon("home", 14)} ${t("Spaces")}</a>
    <a class="btn ghost sm inbox-link" href="#/inbox" aria-label="${esc(tp("Invitations and notifications"))}${n ? `, ${n} unread` : ""}">${icon("calendar", 14)}<span aria-hidden="true">${n ? `<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</span></a>`;
}
function userChip() {
  const me = state.me;
  return `<span class="user-chip"><span class="avatar" aria-hidden="true">${esc(me.user.displayName[0])}</span><span class="small"><b>${esc(me.user.displayName)}</b><br><span class="muted">${esc(roleWord(me.roles))}</span></span>
    <button class="ghost icon-btn" data-act="logout" aria-label="Sign out" title="Sign out">${icon("logout", 16)}</button></span>`;
}
/** Interface language (saved to the account; also the default language for new captures and questions). */
function langPicker() {
  return `<label class="sr-only" for="ui-lang">${t("Interface language")}</label><select id="ui-lang" class="lang-pick" title="${esc(tp("Interface language"))}">${LANGS.map((l) => `<option value="${l.code}" lang="${l.code}" ${l.code === uiLang() ? "selected" : ""}>${esc(l.native)}</option>`).join("")}</select>`;
}
function orgPicker() {
  const me = state.me;
  return me.organizations.length > 1 ? `<label class="sr-only" for="org-select">Space</label><select id="org-select" style="width:auto;min-width:160px">${me.organizations.map((o) => `<option value="${o.id}" ${o.id === me.org?.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>` : "";
}
const aiPill = () => `<span class="ai-pill" title="${state.config?.ai === "vertex" ? "Model operations run on Gemini through Vertex AI" : "No model configured; the product uses deterministic fallbacks"}">${icon("spark", 13)} ${state.config?.ai === "vertex" ? "Gemini · Vertex AI" : "AI offline"}</span>`;

function workShell(content, r) {
  const active = r.name === "session" ? "capture" : r.name;
  const nav = WORK.nav.filter(([, , , ok]) => ok());
  return `${sampleBar()}<div class="shell">
    <nav class="sidebar" aria-label="Primary">${brand()}<div class="eyebrow" style="padding:0 8px">For Work</div>
      <div class="nav">${nav.map(([k, i, l]) => `<a href="#/${k === "home" ? "" : k}" ${active === k || (k === "workflows" && active === "capture") ? 'aria-current="page"' : ""}>${icon(i, 17)} ${t(l)}</a>`).join("")}</div>
      <div class="sidebar-foot"><div class="callout small"><b>${icon("shield", 13)} Evidence ≠ inference</b><br><span class="muted">Every claim shows whether it was observed, stated by the expert, or inferred by AI.</span></div></div>
    </nav>
    <div>
      <header class="topbar">
        ${WORK.workflowPicker.has(r.name) && state.workflows.length ? `<label class="sr-only" for="wf-select">Workflow</label><select id="wf-select" data-focus="wf-select">${state.workflows.map((w) => `<option value="${w.id}" ${w.id === workflow()?.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>` : `<span class="small muted">${esc(state.me.org?.name ?? "")}</span>`}
        <span class="spacer"></span>${aiPill()}
        <label class="check small"><input type="checkbox" id="speak" ${state.speak ? "checked" : ""}> ${t("Speak questions")}</label>
        ${spaceLinks()}${langPicker()}${orgPicker()}${userChip()}
      </header>
      <main id="main" tabindex="-1">${content}</main>
    </div></div>`;
}

function livingShell(content, r) {
  const active = r.name === "session" || r.name === "workflows" ? "capture" : r.name === "journey" ? "home" : r.name;
  const nav = LIVING.nav.filter(([, , , ok]) => ok());
  return `${sampleBar()}<div class="living">
    <header class="living-top">${brand()}<span class="living-space small muted">${esc(state.me.org?.name ?? "")}</span>
      <nav class="living-nav" aria-label="Primary">${nav.map(([k, i, l]) => `<a href="#/${k === "home" ? "" : k}" ${active === k ? 'aria-current="page"' : ""}>${icon(i, 16)} ${t(l)}</a>`).join("")}</nav>
      <span class="spacer"></span><label class="check small"><input type="checkbox" id="speak" ${state.speak ? "checked" : ""}> ${t("Speak questions")}</label>${spaceLinks()}${langPicker()}${orgPicker()}${userChip()}
    </header>
    <main id="main" class="living-main" tabindex="-1">${content}</main></div>`;
}

// ---------------------------------------------------------------- router
let lastRoute = "";
function draw() {
  const r = route();
  // The document stays lang="en": Marathi interface coverage is partial and translated strings carry lang="mr" themselves.
  if (!state.me) { root.innerHTML = authView(r); return; }
  if (state.me.policies?.pending?.length && r.name !== "policies") { go("#/policies"); return; }
  // Signed in without a space (e.g. every membership ended): show their invitations and how to create a space.
  if (!state.me.org) { root.innerHTML = workShell(r.name === "inbox" ? inboxView(r) : spacesView(r), r); return; }
  if (r.name === "policies") { root.innerHTML = `${sampleBar()}<main id="main" class="policy-page">${policiesView()}</main>`; return; }
  const e = exp();
  const view = e.views[r.name] ?? e.views.home;
  const routeKey = `${r.name}/${r.id ?? ""}`;
  if (routeKey !== lastRoute) {
    // Record the new route first: leaving a page may trigger a render, which must not "leave" it a second time.
    const prev = lastRoute; lastRoute = routeKey;
    if (prev.startsWith("session/")) leaveSession();
    if (/^(start|map|practice)\//.test(prev)) leaveNow();
    window.scrollTo(0, 0);
  }
  // Capture, the Work Map and practice are full-screen: no navigation chrome between the person and the work.
  if (NOW[r.name]) { root.innerHTML = NOW[r.name](r); nowAfterRender(); return; }
  const body = view[0](r);
  root.innerHTML = (isLiving() ? livingShell : workShell)(r.name === "home" ? `${homeNow()}${firstRunGuide()}${body}` : body, r);
  if (r.name === "session") afterRender();
}
// Back (bottom-left on every page except Home and the landing page): returns to the previous step inside the app, or
// Home if there is none. It is a real <button>, outside the page so re-renders never move focus away from it.
let inAppSteps = 0;
function backButton() {
  let b = document.getElementById("back-fab");
  if (!b) {
    b = document.createElement("button"); b.id = "back-fab"; b.className = "back-fab"; b.type = "button";
    b.innerHTML = `<span aria-hidden="true">←</span> Back`; b.setAttribute("aria-label", "Back to the previous page");
    b.addEventListener("click", () => { if (inAppSteps > 0) { inAppSteps -= 2; history.back(); } else go("#/"); });
    document.body.appendChild(b);
  }
  const r = route();
  b.hidden = r.name === "home" || (r.name === "start" && nowBusy()) || (r.name === "practice" && nowBusy());
}
const drawWithBack = () => { draw(); backButton(); };
onRender(drawWithBack);

document.addEventListener("submit", (e) => { if (e.target.matches("[data-noop-submit]")) e.preventDefault(); });
document.addEventListener("click", async (e) => {
  // The skip link must move focus, not change the hash (the hash is the router: "#main" would navigate away).
  if (e.target.closest(".skip-link")) { e.preventDefault(); const m = document.getElementById("main"); m?.focus(); m?.scrollIntoView(); return; }
  if (e.target.closest('[data-act="logout"]')) return act("logout", async () => { await api("POST", "/api/auth/logout"); state.me = null; go("#/"); location.reload(); });
  if (!state.me) return authClick(e);
  if (await accessClick(e)) return;
  const del = e.target.closest('[data-act="delete-skill"]');
  if (del) {
    e.stopPropagation();
    if (!confirm(`Delete "${del.dataset.name}"? It disappears from every list and any session still recording for it is terminated. Knowledge already approved stays with the person who contributed it.`)) return;
    return act("delete-skill", async () => {
      await api("POST", `/api/workflows/${del.dataset.id}/delete`, { confirm: true });
      state.workflows = await api("GET", "/api/workflows").catch(() => state.workflows.filter((w) => w.id !== del.dataset.id));
      if (state.workflowId === del.dataset.id) setWorkflow(state.workflows[0]?.id ?? null);
      invalidateAll(); toast(`Deleted "${del.dataset.name}".`); announce("Skill deleted.");
    });
  }
  if (await spacesClick(e)) return;
  const r = route();
  if (r.name === "policies") return policiesClick(e);
  if (await nowClick(e) || NOW[r.name]) return; // live screens, and session actions shown on Home (terminate)
  (exp().views[r.name] ?? exp().views.home)[1]?.(e);
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "wf-select") { setWorkflow(e.target.value); invalidateAll(); return render(); }
  if (e.target.id === "ui-lang") return act("lang", async () => { await api("POST", "/api/me/language", { language: e.target.value }); state.me.user.language = e.target.value; announce(e.target.value === "mr" ? "भाषा: मराठी" : "Language: English"); document.getElementById("ui-lang")?.focus(); });
  if (e.target.id === "speak") { state.speak = e.target.checked; store.set("ag.speak", state.speak ? "1" : "0"); return; }
  if (e.target.id === "org-select") return act("org", async () => { await api("POST", "/api/auth/switch-org", { orgId: e.target.value }); location.hash = "#/"; location.reload(); });
  if (e.target.id === "sample-person") return act("switch", async () => { await api("POST", "/api/samples/switch", { personId: e.target.value }); location.reload(); });
  if (spacesChange(e)) return;
  const r = route();
  (exp().views[r.name] ?? exp().views.home)[2]?.(e);
});
function invalidateAll() { [invalidateSpaces, invalidateGroups, invalidateMissions, invalidateStorage, invalidateRadar, invalidateAsk, invalidateKnowledge, invalidateApprentice, invalidateInsights, invalidateWorkflow, invalidateTransfers, invalidateProgress, invalidateLiving, invalidateCommand].forEach((f) => f()); }
window.addEventListener("hashchange", async () => {
  inAppSteps++;
  const r = route();
  if (r.name === "home") invalidateNow();
  if (["home", "workflows", "capture"].includes(r.name) && state.me?.org) { invalidateCommand(); state.workflows = await api("GET", "/api/workflows").catch(() => state.workflows); }
  if (["admin", "people"].includes(r.name)) invalidateAdmin();
  if (r.name === "radar") invalidateRadar();
  if (["missions", "home"].includes(r.name)) invalidateMissions();
  if (r.name === "groups") invalidateGroups();
  if (r.name === "storage") invalidateStorage();
  if (r.name === "impact") invalidateImpact();
  if (["spaces", "inbox"].includes(r.name)) { invalidateSpaces(); invalidateAccess(); }
  if (state.me) { const before = state.unread; loadInbox().then(() => { if (state.unread !== before) render(); }).catch(() => {}); }
  if (["transfers", "home", "journey", "sharing", "knowledge", "progress"].includes(r.name)) { invalidateTransfers(); invalidateLiving(); invalidateProgress(); }
  drawWithBack();
  document.getElementById("main")?.focus({ preventScroll: true });
});

async function boot() {
  await loadAuthConfig().catch(() => {});
  try { state.me = await api("GET", "/api/auth/me"); } catch { state.me = null; }
  if (state.me?.org && !state.me.policies?.pending?.length) {
    state.workflows = await api("GET", "/api/workflows").catch(() => []);
    if (!state.workflows.some((w) => w.id === state.workflowId)) setWorkflow(state.workflows[0]?.id ?? null);
    if (isSample()) state.samplePeople = await api("GET", "/api/samples/people").catch(() => []);
    await loadInbox().catch(() => {});
  } else if (state.me?.org && isSample()) state.samplePeople = [];
  drawWithBack();
}
/** Re-read the signed-in person and redraw without a page load (used by the accessibility test harness). */
export async function reboot() { invalidateAll(); invalidateAdmin(); lastRoute = ""; await boot(); }
window.addEventListener("unhandledrejection", (e) => { if (e.reason?.message) toast(e.reason.message, true); });
boot();
