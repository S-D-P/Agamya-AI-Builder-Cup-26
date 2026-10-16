// GROUPS: application-level groups of people in this space (not synchronised with any corporate directory).
// Membership alone grants nothing; the page says what a group currently gives access to before people are added.
import { state, api, esc, render, act, draft, toast, isLiving, go } from "../core.js";
import { icon } from "../icons.js";
import { announce } from "../a11y.js";

let list = null, current = null, people = null, picking = new Set();

export function invalidateGroups() { list = null; current = null; people = null; picking = new Set(); }

export function groupsView(r) {
  if (!list) { api("GET", "/api/groups").then((x) => { list = x; render(); }).catch((e) => toast(e.message, true)); return `<span class="thinking">Loading groups</span>`; }
  if (r.id && (!current || current.id !== r.id)) { api("GET", `/api/groups/${r.id}`).then((g) => { current = g; picking = new Set(); render(); }).catch((e) => { toast(e.message, true); go("#/groups"); }); }
  if (r.id && people === null && list.groups.find((g) => g.id === r.id)?.canManage) { people = []; api("GET", "/api/people").then((p) => { people = p; render(); }).catch(() => {}); }
  const living = isLiving();
  return `<div class="page-head"><div><h1>Groups</h1><p>${living ? "Family, friends, a learning circle: share selected knowledge with a group in one step. Being in a group never exposes anything that was not explicitly shared with it." : "Groups of people (for example Payments-New-Joiners) that a coordinator can assign to a mission in one step. These are Agamya groups; they are not synchronised with Google Cloud IAM, Entra ID or any other directory."}</p></div></div>
  <div class="knowledge-grid">
    <aside class="stack">
      ${list.canCreate ? `<section class="card pad stack" aria-labelledby="g-new"><h2 id="g-new" class="h3">New group</h2>
        <label class="field" for="g-name">Name<input id="g-name" data-draft="g-name" maxlength="80" placeholder="${living ? "Cousins" : "Payments-New-Joiners"}"></label>
        <label class="field" for="g-desc">Description <span class="muted" style="font-weight:400">(optional)</span><input id="g-desc" data-draft="g-desc" maxlength="300"></label>
        <div><button class="primary sm" data-act="g-create" ${state.busy ? "disabled" : ""}>${icon("plus", 14)} Create group</button></div></section>` : ""}
      <nav aria-label="Groups"><ul class="klist plain">${list.groups.map((g) => `<li><a class="card kitem" href="#/groups/${g.id}" ${r.id === g.id ? 'aria-current="page"' : ""}><b>${esc(g.name)}</b>
        <span class="small muted">${g.members} member${g.members === 1 ? "" : "s"}${g.isMember ? " · you are in it" : ""}${g.canManage ? " · you manage it" : ""}</span></a></li>`).join("") || `<li class="small muted">No groups yet.</li>`}</ul></nav>
    </aside>
    <section>${r.id ? (current && current.id === r.id ? detail(current) : `<span class="thinking">Loading</span>`) : `<div class="card pad empty"><p>Choose a group${list.canCreate ? " or create one" : ""}.</p></div>`}</section>
  </div>`;
}

function detail(g) {
  const memberIds = new Set(g.members.map((m) => m.id));
  const candidates = (people ?? []).filter((p) => !memberIds.has(p.id) && p.has_login);
  return `<div class="card pad stack">
    <div class="row between wrap"><div><div class="eyebrow">${g.kind === "personal" ? "Personal group" : "Enterprise group"}</div><h2>${esc(g.name)}</h2>${g.description ? `<p class="small muted">${esc(g.description)}</p>` : ""}</div>
      ${g.canManage ? `<button class="sm danger" data-act="g-archive" data-id="${g.id}">Archive group</button>` : ""}</div>
    <div class="callout small" role="note"><b>What membership gives today:</b> ${g.grants.sharedKnowledge} piece${g.grants.sharedKnowledge === 1 ? "" : "s"} of knowledge shared with this group${g.grants.missions.length ? `; assigned to mission${g.grants.missions.length === 1 ? "" : "s"}: ${g.grants.missions.map((m) => `<a href="#/missions/${m.id}">${esc(m.name)}</a>`).join(", ")}` : ""}.<br><span class="muted">${esc(g.note)}</span></div>
    ${g.canManage ? `<details class="small"><summary>Rename</summary><div class="row wrap" style="margin-top:8px"><label class="field" for="g-rename">New name<input id="g-rename" data-draft="g-rename" maxlength="80" value="${esc(g.name)}"></label><button class="sm" data-act="g-rename" data-id="${g.id}">Save name</button></div></details>` : ""}
    <h3>Members (${g.members.length})</h3>
    <ul class="plain member-list">${g.members.map((m) => `<li class="row between"><span><b>${esc(m.name)}</b> <span class="small muted">${esc(m.title || "")}</span></span>
      ${g.canManage || m.id === state.me.personId ? `<button class="sm ghost" data-act="g-remove" data-id="${g.id}" data-p="${m.id}" aria-label="${m.id === state.me.personId ? "Leave this group" : `Remove ${esc(m.name)} from the group`}">${m.id === state.me.personId ? "Leave" : "Remove"}</button>` : ""}</li>`).join("") || `<li class="small muted">No members yet.</li>`}</ul>
    ${g.canManage ? `<fieldset class="stack"><legend><b>Add people from this space</b></legend>
      ${candidates.length ? `<div class="row wrap">${candidates.map((p) => `<label class="check chip-check" for="pick-${p.id}"><input type="checkbox" id="pick-${p.id}" data-pick="${p.id}" ${picking.has(p.id) ? "checked" : ""}> ${esc(p.display_name)}</label>`).join("")}</div>
        ${picking.size ? `<p class="small" role="status">Adding ${picking.size} ${picking.size === 1 ? "person gives them" : "people gives them"} access to the ${g.grants.sharedKnowledge} piece${g.grants.sharedKnowledge === 1 ? "" : "s"} of knowledge shared with this group. Existing missions are not affected.</p>` : ""}
        <div><button class="primary sm" data-act="g-add" data-id="${g.id}" ${!picking.size || state.busy ? "disabled" : ""}>Add selected</button></div>`
        : `<p class="small muted">Everyone with an account in this space is already a member. Invite more people from ${isLiving() ? "People" : "Administration"}.</p>`}</fieldset>` : ""}
  </div>`;
}

export async function groupsClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  const reload = async (id) => { list = await api("GET", "/api/groups"); current = id ? await api("GET", `/api/groups/${id}`) : null; };
  if (a === "g-create") {
    const name = draft("g-name");
    if (!name) { toast("Give the group a name.", true); document.getElementById("g-name")?.focus(); return; }
    return act("group", async () => { const g = await api("POST", "/api/groups", { name, description: draft("g-desc") }); state.drafts["g-name"] = ""; state.drafts["g-desc"] = ""; await reload(); announce(`Group ${name} created.`); go(`#/groups/${g.id}`); });
  }
  if (a === "g-add") return act("group", async () => { const n = picking.size; await api("POST", `/api/groups/${el.dataset.id}/members`, { personIds: [...picking] }); picking = new Set(); await reload(el.dataset.id); announce(`${n} added.`); });
  if (a === "g-remove") return act("group", async () => { await api("DELETE", `/api/groups/${el.dataset.id}/members/${el.dataset.p}`); await reload(el.dataset.p === state.me.personId ? null : el.dataset.id); announce("Removed from the group."); if (el.dataset.p === state.me.personId) go("#/groups"); });
  if (a === "g-rename") return act("group", async () => { await api("POST", `/api/groups/${el.dataset.id}`, { name: draft("g-rename") }); await reload(el.dataset.id); announce("Renamed."); });
  if (a === "g-archive") {
    if (!confirm("Archive this group? Knowledge shared with it stops being visible to its members. Missions keep the people already assigned.")) return;
    return act("group", async () => { await api("POST", `/api/groups/${el.dataset.id}`, { archive: true }); await reload(); announce("Group archived."); go("#/groups"); });
  }
}
export function groupsChange(e) {
  if (e.target.dataset?.pick) { e.target.checked ? picking.add(e.target.dataset.pick) : picking.delete(e.target.dataset.pick); render(); }
}
