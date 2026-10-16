// Access requests in the interface: "Request access" on knowledge that is not shared with you, "Ask a teacher to share"
// when nothing is, and Grant / Decline for the people who own the knowledge (in the inbox).
import { state, api, esc, render, toast, ago } from "../core.js";
import { announce } from "../a11y.js";

let data = null, requested = new Set();
export function invalidateAccess() { data = null; }
const load = () => api("GET", "/api/access-requests").then((d) => { data = d; render(); }).catch(() => { data = { incoming: [], outgoing: [], myKnowledge: [] }; render(); });

/** A button for a hidden item. The explanation says who decides; the title is never revealed. */
export function requestButton(artifactId) {
  if (!artifactId) return "";
  return requested.has(artifactId) ? `<span class="tag">Access requested</span>`
    : `<button class="sm" data-act="request-access" data-id="${esc(artifactId)}" title="The person who contributed it decides; you will get a notification">Request access</button>`;
}
/** When nothing is shared with a learner: ask the experts / teachers of this space. */
export function askToShareBlock() {
  return `<div class="ask-share"><p class="small muted">Knowledge stays private until the person who contributed it shares it. You can ask: the experts in this space get a notification, choose what to share, and you are told the outcome.</p>
    ${requested.has("general") ? `<span class="tag">Request sent</span>` : `<button class="sm" data-act="request-access" data-id="">Ask a teacher to share</button>`}</div>`;
}

/** Inbox section: requests I can decide. */
export function accessInboxSection() {
  if (!state.me?.org) return "";
  if (!data) { load(); return ""; }
  if (!data.incoming.length) return "";
  return `<section class="card pad stack" style="margin-top:16px" aria-labelledby="ib-acc"><h2 id="ib-acc">Requests to see knowledge</h2>
    <p class="small muted">Granting adds this person to the people it is shared with; nothing else changes. You can change sharing at any time on the Work Map or knowledge page.</p>
    <ul class="plain">${data.incoming.map((r) => `<li class="access-req"><div><b>${esc(r.requester)}</b> ${r.item ? `asked to ${r.item.kind === "workmap" ? "open the Work Map" : "see"} <b>${esc(r.item.title)}</b>` : "would like to learn from you"} <span class="small muted">· ${ago(r.createdAt)}</span>
      ${r.note ? `<div class="small">“${esc(r.note)}”</div>` : ""}</div>
      ${r.item ? "" : data.myKnowledge.length ? `<fieldset class="small"><legend>Choose what to share</legend>${data.myKnowledge.map((k) => `<label class="check"><input type="checkbox" data-grant-for="${r.id}" value="${k.id}"> ${esc(k.title)}</label>`).join("")}</fieldset>` : `<p class="small muted">Nothing confirmed to share yet. Confirm a Work Map first (open it from Home and press "Yes, that's how it works").</p>`}
      <div class="row"><button class="primary sm" data-act="access-decide" data-id="${r.id}" data-grant="1" ${!r.item && !data.myKnowledge.length ? "disabled" : ""}>${r.item ? "Share with them" : "Share selected"}</button>
        <button class="sm" data-act="access-decide" data-id="${r.id}" data-grant="0">Decline</button></div></li>`).join("")}</ul></section>`;
}

export async function accessClick(e) {
  const el = e.target.closest('[data-act="request-access"], [data-act="access-decide"]');
  if (!el) return false;
  try {
    if (el.dataset.act === "request-access") {
      const artifactId = el.dataset.id || undefined;
      const r = await api("POST", "/api/access-requests", artifactId ? { artifactId } : {});
      requested.add(artifactId ?? "general");
      const msg = r.alreadyRequested ? "You already asked; you will be notified when they decide." : "Request sent. You will get a notification when they decide.";
      toast(msg); announce(msg);
    } else {
      const id = el.dataset.id, grant = el.dataset.grant === "1";
      const artifactIds = [...document.querySelectorAll(`[data-grant-for="${id}"]:checked`)].map((x) => x.value);
      const r = await api("POST", `/api/access-requests/${id}/decide`, { grant, artifactIds });
      const msg = grant ? `Shared ${r.shared === 1 ? "it" : `${r.shared} pieces of knowledge`}. They have been told.` : "Declined. They have been told.";
      toast(msg); announce(msg); data = null;
    }
  } catch (err) { toast(err.message, true); }
  render();
  return true;
}
