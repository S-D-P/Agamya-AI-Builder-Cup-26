// SPACES and INBOX: the person's Personal and Enterprise spaces, pending invitations, notifications, creating a space,
// and the dismissible first-run guide. Membership in one space never grants anything in another; the server decides.
import { accessInboxSection } from "./access.js";
import { state, api, esc, render, act, draft, ago, toast, store } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { t } from "../i18n.js";
import { announce } from "../a11y.js";

let inbox = null, spaces = null, newKind = "personal";
const KIND = { personal: ["Personal", "Preserve and share what matters with the people you choose."], enterprise: ["Enterprise", "Coordinate knowledge-transfer missions with roles, groups and outcomes."] };
const ROLE = { ORG_OWNER: "owner", ORG_ADMIN: "administrator", KT_COORDINATOR: "KT coordinator", WORKFLOW_OWNER: "workflow owner", EXPERT: "expert", LEARNER: "receiver", REVIEWER: "reviewer", AUDITOR: "auditor" };

export async function loadInbox() { inbox = await api("GET", "/api/inbox").catch(() => inbox ?? { invitations: [], notifications: [], unread: 0 }); state.unread = inbox.unread; return inbox; }
export function invalidateSpaces() { inbox = null; spaces = null; }

export function spacesView() {
  if (!spaces) { api("GET", "/api/spaces").then((r) => { spaces = r; render(); }).catch((e) => toast(e.message, true)); }
  if (!inbox) loadInbox().then(render);
  if (!spaces || !inbox) return `<span class="thinking">Loading your spaces</span>`;
  const mine = spaces.spaces.filter((s) => !s.sample_kind);
  return `<div class="page-head"><div><h1>${t("Your spaces")}</h1><p>A space is where knowledge lives and who it is shared with. Your role is set per space.</p></div></div>
  ${inbox.invitations.length ? `<section class="card pad stack" aria-labelledby="inv-h"><h2 id="inv-h">${icon("users", 16)} ${t("Invitations")}</h2>${inbox.invitations.map(invitationRow).join("")}</section>` : ""}
  <section aria-labelledby="sp-h" style="margin-top:16px"><h2 id="sp-h" class="sr-only">Spaces you belong to</h2>
    <ul class="space-grid plain">${spaces.spaces.map((s) => `<li class="card pad stack space-card">
      <div class="row between wrap"><span class="eyebrow">${esc(KIND[s.kind]?.[0] ?? s.kind)}${s.sample_kind ? " · sample" : ""}</span>${s.id === spaces.active ? `<span class="tag green">${icon("check", 11)} current</span>` : ""}</div>
      <h3>${esc(s.name)}</h3><p class="small muted">You are ${esc(s.roles.map((r) => ROLE[r] ?? r).join(", "))}.</p>
      ${s.id === spaces.active ? `<a class="btn sm" href="#/">Open</a>` : `<button class="sm" data-act="enter-space" data-id="${s.id}">Enter ${esc(s.name)}</button>`}</li>`).join("")}</ul>
    ${!mine.length ? `<p class="small muted">You only have sample spaces so far.</p>` : ""}
  </section>
  ${state.me?.roles?.includes("ORG_OWNER") && state.me?.org ? passcodeCard() : ""}
  ${state.config?.allowSignup !== false ? createCard() : ""}`;
}

function invitationRow(i) {
  return `<div class="row between wrap invitation"><div><b>${esc(i.spaceName)}</b> <span class="small muted">· ${esc(KIND[i.kind]?.[0] ?? "")} · as ${esc(i.roles.map((r) => ROLE[r] ?? r).join(", "))}${i.invitedBy ? ` · from ${esc(i.invitedBy)}` : ""} · expires ${new Date(i.expiresAt).toLocaleDateString()}</span></div>
    <div class="row"><button class="primary sm" data-act="inv-accept" data-id="${i.id}" aria-label="Accept the invitation to ${esc(i.spaceName)}">Accept</button><button class="sm" data-act="inv-decline" data-id="${i.id}" aria-label="Decline the invitation to ${esc(i.spaceName)}">Decline</button></div></div>`;
}

function createCard() {
  return `<section class="card pad stack" style="margin-top:16px;max-width:720px" aria-labelledby="new-h"><h2 id="new-h">${t("Create a space")}</h2>
    <fieldset class="seg-fieldset"><legend class="small"><b>Kind of space</b> <span class="muted">(you can belong to both kinds)</span></legend>
      <div class="kind-choices">${Object.entries(KIND).map(([k, [l, d]]) => `<label class="kind-choice ${newKind === k ? "on" : ""}"><input type="radio" name="space-kind" value="${k}" ${newKind === k ? "checked" : ""}> <span><b>${esc(l)}</b><br><span class="small muted">${esc(d)}</span></span></label>`).join("")}</div></fieldset>
    <label class="field" for="new-space-name">${newKind === "personal" ? "Name of your space" : "Organization name"}<input id="new-space-name" data-draft="new-space-name" placeholder="${newKind === "personal" ? "Our family kitchen" : "Northwind Operations"}" maxlength="80"></label>
    <p class="small muted">${newKind === "personal" ? "Private by default. Nothing is shared until you share a specific piece of knowledge with specific people or groups." : "You become its owner. Invite administrators, coordinators, experts and receivers; their roles apply in this space only."}</p>
    <div><button class="primary" data-act="create-space" ${state.busy ? "disabled" : ""}>${icon("plus", 15)} Create ${newKind === "personal" ? "Personal space" : "Enterprise organization"}</button></div></section>`;
}

export function inboxView() {
  if (!inbox) { loadInbox().then(render); return `<span class="thinking">Loading</span>`; }
  return `<div class="page-head"><div><h1>${t("Invitations and notifications")}</h1><p>Only what concerns you in ${esc(state.me?.org?.name ?? "this space")}. Notifications name the mission or space, never its private content.</p></div>
    ${inbox.notifications.some((n) => !n.read) ? `<button class="sm" data-act="read-all">Mark all as read</button>` : ""}</div>
  ${inbox.invitations.length ? `<section class="card pad stack" aria-labelledby="ib-inv"><h2 id="ib-inv">${t("Invitations")}</h2>${inbox.invitations.map(invitationRow).join("")}</section>` : ""}
  ${inbox.otherSpaces?.length ? `<p class="callout small" role="note">Each space keeps its own notifications. Unread in your other spaces: ${inbox.otherSpaces.map((o) => `<b>${esc(o.spaceName)}</b> (${o.unread}) <button class="sm" data-act="enter-space" data-id="${o.spaceId}">Switch</button>`).join(" · ")}</p>` : ""}
  ${accessInboxSection()}
  <section class="card pad stack" style="margin-top:16px" aria-labelledby="ib-n"><h2 id="ib-n">${t("Notifications")}</h2>
    ${inbox.notifications.length ? `<ul class="plain notif-list">${inbox.notifications.map((n) => `<li class="notif ${n.read ? "" : "unread"}">
      <span class="tag ${n.read ? "" : "sky"}">${n.read ? "read" : "new"}</span>
      <div><div>${n.link && n.spaceId ? `<button class="link" data-act="open-notif" data-id="${n.id}" data-space="${n.spaceId}" data-link="${esc(n.link)}">${esc(n.title)}</button>` : esc(n.title)}</div>
        <div class="small muted">${esc(n.spaceName ?? "")} · ${ago(n.createdAt)}</div></div></li>`).join("")}</ul>` : `<div class="empty">${orb("observing", 64)}<p>Nothing yet.</p></div>`}
  </section>`;
}

/** A space with a passcode: shown instead of the space until the passcode is entered in this sign-in session. */
export function unlockView() {
  const o = state.me.org;
  return `<div class="landing light"><header class="land-head">${brandMark()}<span class="spacer"></span><a class="btn ghost" href="#/spaces">Switch space</a></header>
    <main id="main" class="land-auth" tabindex="-1"><form class="auth-card card pad stack" data-noop-submit>
      <h1>${esc(o.name)} is locked</h1>
      <p class="muted">Its owner protects this space with a passcode, on top of your own password. Enter it once for this sign-in. Ask the space owner if you do not have it.</p>
      <label class="field" for="unlock-code">Space passcode<input id="unlock-code" data-draft="unlock-code" type="password" autocomplete="off" required aria-required="true"></label>
      <button class="primary" data-act="space-unlock">Unlock ${esc(o.name)}</button>
      <p class="small muted">Your other spaces are not affected. <a href="#/spaces">Switch space</a></p>
    </form></main></div>`;
}
const brandMark = () => `<a class="brand" href="#/spaces"><span class="brand-name">Agamya</span></a>`;

/** Owner only: protect this space with a passcode (each person still signs in with their own account). */
function passcodeCard() {
  const has = state.me.org.hasPasscode;
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="pc-h"><h2 id="pc-h" class="h3">${icon("lock", 15)} Passcode for ${esc(state.me.org.name)}</h2>
    <p class="small muted">${has ? "This space is protected." : "Optional."} Everyone entering this space types the passcode once per sign-in, on top of their own password. Share it only with people you invite. Changing it locks the space again for everyone else.</p>
    <div class="row wrap"><label class="field" for="pc-new" style="flex:1;min-width:220px">${has ? "New passcode" : "Passcode"} (at least 6 characters)<input id="pc-new" data-draft="pc-new" type="password" autocomplete="new-password" minlength="6"></label></div>
    <div class="row"><button class="primary sm" data-act="passcode-set">${has ? "Change passcode" : "Protect with a passcode"}</button>${has ? `<button class="ghost sm" data-act="passcode-remove">Remove passcode</button>` : ""}</div></section>`;
}

/** First-run guide: helps choose a mode and start; dismissible, remembered on this device only. */
export function firstRunGuide() {
  if (store.get("ag.guide.dismissed") === "1") return "";
  const enterprise = state.me?.org?.experience === "work";
  const steps = enterprise
    ? [["Plan a KT mission", "Name it, pick a template or General, write the brief.", "#/missions/new"], ["Invite the expert and receivers", "Individually or as a group.", "#/groups"], ["Capture, review, assess", "The expert captures; Agamya asks; receivers are tested on approved criteria.", "#/missions"]]
    : [["Capture a skill", "Show it as you normally would; Agamya asks only about the choices that matter.", "#/capture"], ["Invite people or make a group", "Inviting shares nothing by itself.", "#/people"], ["Share what you choose", "Per piece of knowledge, with people or groups.", "#/knowledge"]];
  return `<aside class="card pad stack first-run" aria-labelledby="fr-h"><div class="row between"><h2 id="fr-h" class="h3">${icon("spark", 15)} Getting started in ${enterprise ? "Agamya Enterprise" : "Agamya Personal"}</h2>
      <button class="ghost sm" data-act="dismiss-guide" aria-label="Dismiss the getting-started guide">Dismiss</button></div>
    <ol class="how-steps compact">${steps.map(([h, d, href], i) => `<li><span class="how-n" aria-hidden="true">${i + 1}</span><div><a href="${href}"><b>${esc(h)}</b></a><span class="small muted">${esc(d)}</span></div></li>`).join("")}</ol>
    <p class="small muted">Switch between Personal and Enterprise spaces from <a href="#/spaces">Your spaces</a>.</p></aside>`;
}

export async function spacesClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return false;
  const a = el.dataset.act;
  if (a === "space-unlock") {
    act("unlock", async () => { await api("POST", "/api/space/unlock", { passcode: state.drafts["unlock-code"] ?? "" }); state.drafts["unlock-code"] = ""; state.me = await api("GET", "/api/auth/me"); announce("Unlocked."); location.hash = "#/"; location.reload(); });
    return true;
  }
  if (a === "passcode-set") {
    const code = state.drafts["pc-new"] ?? "";
    if (code.length < 6) { toast("Use at least 6 characters.", true); document.getElementById("pc-new")?.focus(); return true; }
    act("passcode", async () => { await api("POST", "/api/spaces/passcode", { passcode: code }); state.drafts["pc-new"] = ""; state.me = await api("GET", "/api/auth/me"); toast("Passcode saved. Share it only with people you invite."); });
    return true;
  }
  if (a === "passcode-remove") {
    if (!confirm("Remove the passcode? People in this space will only need their own password.")) return true;
    act("passcode", async () => { await api("POST", "/api/spaces/passcode", { passcode: null }); state.me = await api("GET", "/api/auth/me"); toast("Passcode removed."); });
    return true;
  }
  if (a === "dismiss-guide") { store.set("ag.guide.dismissed", "1"); announce("Guide dismissed."); render(); document.getElementById("main")?.focus(); return true; }
  if (a === "enter-space") { act("space", async () => { await api("POST", "/api/auth/switch-org", { orgId: el.dataset.id }); location.hash = "#/"; location.reload(); }); return true; }
  if (a === "inv-accept" || a === "inv-decline") {
    const accept = a === "inv-accept";
    act("invite", async () => {
      const r = await api("POST", `/api/invitations/${el.dataset.id}/respond`, { accept });
      announce(accept ? "Invitation accepted." : "Invitation declined.");
      invalidateSpaces();
      if (accept) { await api("POST", "/api/auth/switch-org", { orgId: r.spaceId }); location.hash = "#/"; location.reload(); }
    });
    return true;
  }
  if (a === "create-space") {
    const name = draft("new-space-name");
    if (!name) { toast("Give the space a name.", true); document.getElementById("new-space-name")?.focus(); return true; }
    act("space", async () => { await api("POST", "/api/spaces", { name, kind: newKind }); state.drafts["new-space-name"] = ""; location.hash = "#/policies"; location.reload(); });
    return true;
  }
  if (a === "read-all") { act("read", async () => { await api("POST", "/api/inbox/read", { all: true }); await loadInbox(); announce("All notifications marked as read."); }); return true; }
  if (a === "open-notif") {
    act("open", async () => {
      await api("POST", "/api/inbox/read", { ids: [el.dataset.id] });
      if (el.dataset.space !== state.me?.org?.id) { await api("POST", "/api/auth/switch-org", { orgId: el.dataset.space }); location.hash = el.dataset.link; location.reload(); return; }
      await loadInbox(); location.hash = el.dataset.link;
    });
    return true;
  }
  return false;
}
export function spacesChange(e) {
  if (e.target.name === "space-kind") { newKind = e.target.value; render(); document.querySelector(`input[name="space-kind"][value="${newKind}"]`)?.focus(); return true; }
  return false;
}
