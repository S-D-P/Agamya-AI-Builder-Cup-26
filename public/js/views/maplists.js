// Work Maps in the knowledge pages. One access rule everywhere (server-side): the expert sees their own maps; space
// admins and coordinators see all; everyone else sees confirmed maps shared with the space, their groups or them, and
// can ask for access to the others (titles only).
import { api, esc, render, toast, ago } from "../core.js";
import { announce } from "../a11y.js";

let maps = null, catalog = null, requested = new Set();
export function invalidateMapLists() { maps = null; catalog = null; }
function load() {
  if (maps === null) { maps = "loading"; api("GET", "/api/maps").then((x) => { maps = x; render(); }).catch(() => { maps = []; render(); }); }
  if (catalog === null) { catalog = "loading"; api("GET", "/api/maps/catalog").then((x) => { catalog = x; render(); }).catch(() => { catalog = []; render(); }); }
}
const WHO = { organization: "everyone in this space", named: "chosen people and groups", private: "only you" };

/** Learning: maps I can learn from (not my own), then the other confirmed maps in the space, with Request access. */
export function mapsToLearn() {
  load();
  if (maps === "loading" || catalog === "loading") return `<span class="thinking small">Loading Work Maps</span>`;
  const mine = maps.filter((m) => m.status === "confirmed" && !m.mine);
  return `<section class="card pad stack" aria-labelledby="ml-h"><h2 id="ml-h" class="h3">Work Maps you can learn from</h2>
    ${mine.length ? `<ul class="plain map-list">${mine.map((m) => `<li><a href="#/map/${m.sessionId}"><b>${esc(m.title)}</b></a> <span class="small muted">${esc(m.expertName)} · ${m.steps} steps</span>
      <a class="btn sm" href="#/practice/${m.sessionId}">Practise</a> <a class="btn ghost sm" href="#/map/${m.sessionId}">Open and listen</a></li>`).join("")}</ul>`
      : `<p class="small muted">None shared with you yet. A Work Map appears here once its expert confirms it and shares it with you, your group, or everyone in the space.${maps.some((m) => m.mine) ? ` Your own Work Maps are in <a href="#/knowledge">My knowledge</a>.` : ""}</p>`}
    ${catalog.length ? `<h3 class="h3" style="margin-top:12px">Other Work Maps in this space</h3><p class="small muted">You can see their titles. Ask for access: the expert (or a space admin) decides, and you are notified.</p>
      <ul class="plain map-list">${catalog.map((c) => `<li><b>${esc(c.title)}</b> <span class="small muted">${esc(c.expertName)}</span>
        ${c.requested || requested.has(c.workMapId) ? `<span class="tag">Access requested</span>` : `<button class="sm" data-act="map-request" data-id="${c.workMapId}" data-title="${esc(c.title)}">Request access</button>`}</li>`).join("")}</ul>` : ""}
  </section>`;
}

/** My knowledge / Knowledge library: my own Work Maps with who can see each, then what others shared with me. */
export function myMaps() {
  load();
  if (maps === "loading") return `<span class="thinking small">Loading Work Maps</span>`;
  const own = maps.filter((m) => m.mine), shared = maps.filter((m) => !m.mine);
  return `<section class="card pad stack" aria-labelledby="mm-h"><h2 id="mm-h" class="h3">Work Maps</h2>
    ${own.length ? `<h3 class="small eyebrow">Yours</h3><ul class="plain map-list">${own.map((m) => `<li><a href="#/map/${m.sessionId}"><b>${esc(m.title)}</b></a>
      <span class="tag ${m.status === "confirmed" ? "green" : ""}">${m.status === "confirmed" ? "confirmed" : "draft: confirm it to share"}</span>
      <span class="small muted">${m.status === "confirmed" ? `visible to ${WHO[m.visibility] ?? m.visibility}` : ""} · ${ago(m.createdAt)}</span></li>`).join("")}</ul>`
      : `<p class="small muted">You have not recorded a Work Map in this space yet. Start from <a href="#/">Home</a>.</p>`}
    ${shared.length ? `<h3 class="small eyebrow">${shared.some((m) => m.access === "manager") ? "In this space (you are an admin or coordinator)" : "Shared with you"}</h3>
      <ul class="plain map-list">${shared.map((m) => `<li><a href="#/map/${m.sessionId}"><b>${esc(m.title)}</b></a> <span class="small muted">${esc(m.expertName)} · ${m.status === "confirmed" ? "confirmed" : "draft"}</span></li>`).join("")}</ul>` : ""}
  </section>`;
}

export async function mapListsClick(e) {
  const el = e.target.closest('[data-act="map-request"]');
  if (!el) return false;
  try {
    const r = await api("POST", "/api/access-requests", { workMapId: el.dataset.id });
    requested.add(el.dataset.id);
    const msg = r.alreadyRequested ? "You already asked; you will be notified." : `Asked for access to "${el.dataset.title}". You will be notified when it is decided.`;
    toast(msg); announce(msg);
  } catch (err) { toast(err.message, true); }
  render();
  return true;
}
