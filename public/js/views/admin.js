// ADMIN: members and roles, invitations, policies, retention and AI budget, audit trail.
import { state, api, esc, render, act, draft, has, ago, usd, toast, isLiving } from "../core.js";
import { icon } from "../icons.js";
import { announce } from "../a11y.js";

let data = null, tab = "members", lastInvite = null;
const ROLE_LABEL = {
  ORG_OWNER: "Owner", ORG_ADMIN: "Administrator", KT_COORDINATOR: "KT coordinator", WORKFLOW_OWNER: "Workflow owner",
  EXPERT: "Subject matter expert", LEARNER: "Receiver / learner", REVIEWER: "Reviewer", AUDITOR: "Auditor (read-only)",
};
const ROLE_HELP = {
  ORG_OWNER: "Owns the space: settings, membership, policies, who administers", ORG_ADMIN: "Runs day-to-day operations and missions",
  KT_COORDINATOR: "Creates missions, assigns people and groups, tracks progress", WORKFLOW_OWNER: "Configures workflows",
  EXPERT: "Provides expertise and approves what was captured", LEARNER: "Receives knowledge and takes transfer assessments",
  REVIEWER: "Reviews knowledge and tests", AUDITOR: "Reads authorised records; changes nothing",
};
const ROLES = () => (isLiving() ? ["ORG_OWNER", "ORG_ADMIN", "EXPERT", "LEARNER"] : Object.keys(ROLE_LABEL));
const OWNER_ONLY = ["ORG_OWNER", "ORG_ADMIN"];
const label = (r) => (isLiving() ? { EXPERT: "Teacher", LEARNER: "Learner" }[r] : null) ?? ROLE_LABEL[r] ?? r;
const manager = () => has("ORG_OWNER", "ORG_ADMIN");

async function load() {
  const [members, policies, settings, audit] = await Promise.all([
    manager() ? api("GET", "/api/admin/members") : [], api("GET", "/api/policies"), api("GET", "/api/org/settings"),
    has("ORG_OWNER", "ORG_ADMIN", "REVIEWER", "AUDITOR") ? api("GET", "/api/admin/audit?limit=80") : [],
  ]);
  const invitations = has("ORG_OWNER", "ORG_ADMIN", "KT_COORDINATOR") ? await api("GET", "/api/admin/invitations").catch(() => []) : [];
  data = { members, policies, settings, audit, invitations };
  render();
}

export function adminView() {
  if (!has("ORG_OWNER", "ORG_ADMIN", "REVIEWER", "AUDITOR", "KT_COORDINATOR")) return `<div class="card pad">${icon("lock", 16)} Administration is restricted to owners, administrators, coordinators, reviewers and auditors.</div>`;
  if (!data) { load(); return `<span class="thinking">Loading</span>`; }
  const living = isLiving();
  const tabs = [["members", living ? "People" : "Members & roles"], ["policies", "Policies"], ["settings", "Retention & AI budget"], ["audit", "Audit trail"]].filter(([k]) => manager() || (k === "members" && has("KT_COORDINATOR")) || (k === "audit" && has("REVIEWER", "AUDITOR")) || k === "policies");
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  return `<div class="page-head"><div><div class="eyebrow">${esc(state.me.org?.name)}</div><h1>${living ? "People" : "Administration"}</h1><p>${living ? "Invite the people you want to learn from you or with you. Inviting someone shares nothing; you choose that per piece of knowledge." : "Authorization is enforced on the server and in the database (row-level security); this screen only manages it."}</p></div>
    <div class="seg" role="group" aria-label="Administration sections">${tabs.map(([k, l]) => `<button aria-pressed="${tab === k}" data-act="tab" data-v="${k}">${l}</button>`).join("")}</div></div>
    ${({ members, policies, settings, audit })[tab]()}`;
}

function members() {
  const owner = has("ORG_OWNER");
  const pending = data.invitations.filter((x) => x.status === "pending");
  return `<div class="grid cols-2">${manager() ? `<section class="card pad stack" aria-labelledby="mem-h"><h2 id="mem-h">Members</h2>
    <p class="small muted">Roles apply to this space only. ${owner ? "" : "Only an owner can grant or remove Owner and Administrator."}</p>
    ${data.members.map((m) => `<div class="stack" style="border-bottom:1px dashed var(--line);padding-bottom:10px"><div class="row between wrap"><span><b>${esc(m.display_name)}</b> <span class="small muted">${esc(m.email)}</span></span><span class="small faint">${m.last_login_at ? `last sign-in ${ago(m.last_login_at)}` : "never signed in"}</span>
        ${m.user_id !== state.me.user.id && (owner || !m.roles.some((r) => OWNER_ONLY.includes(r))) ? `<button class="ghost sm danger" data-act="remove-member" data-user="${m.user_id}" data-name="${esc(m.display_name)}">Remove from space</button>` : ""}</div>
      <div class="row" role="group" aria-label="Roles for ${esc(m.display_name)}">${ROLES().map((r) => `<button class="chip" aria-pressed="${m.roles.includes(r)}" data-act="role" data-user="${m.user_id}" data-role="${r}" title="${esc(ROLE_HELP[r] ?? "")}" ${OWNER_ONLY.includes(r) && !owner ? "disabled" : ""}>${esc(label(r))}</button>`).join("")}</div></div>`).join("")}</section>` : ""}
    <section class="card pad stack" aria-labelledby="inv-h"><h2 id="inv-h">Invite someone</h2><label class="field" for="inv-email">Email<input id="inv-email" data-draft="inv-email" type="email" autocomplete="off"></label>
      <fieldset class="roles-fieldset"><legend class="small"><b>Roles in this space</b></legend><div class="stack">${ROLES().filter((r) => manager() || ["EXPERT", "LEARNER"].includes(r)).map((r) => `<label class="check"><input type="checkbox" data-inv-role="${r}" ${r === "LEARNER" ? "checked" : ""} ${OWNER_ONLY.includes(r) && !owner ? "disabled" : ""}> ${esc(label(r))} <span class="small muted">${esc(ROLE_HELP[r] ?? "")}</span></label>`).join("")}</div></fieldset>
      <div><button class="primary" data-act="invite" ${state.busy ? "disabled" : ""}>Create invitation</button></div>
      ${lastInvite ? inviteSent(lastInvite) : ""}
      <p class="small muted"><b>How invitations work:</b> 1. Create the invitation. 2. Send the link from your own email (Gmail opens with the message written for you) or copy it. 3. The person opens it, then either creates their account (name and their own password) or, if they already use Agamya, enters their existing password. People who already have an account also see it in their Invitations page.</p>
      <p class="honest">Agamya does not send email itself. Enterprise sign-in (OIDC) is supported where configured; groups here are Agamya groups and are not synchronised with any corporate directory.</p>
      ${data.invitations.length ? `<h3>Invitations</h3><div class="table-wrap" role="region" aria-label="Invitations" tabindex="0"><table class="t"><caption class="sr-only">Invitations to this space</caption><thead><tr><th scope="col">Email</th><th scope="col">Roles</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Action</span></th></tr></thead><tbody>
        ${data.invitations.slice(0, 30).map((x) => `<tr><td>${esc(x.email)}</td><td class="small">${esc(x.roles.map(label).join(", "))}</td><td><span class="tag ${x.status === "accepted" ? "green" : x.status === "pending" ? "amber" : ""}">${esc(x.status)}</span></td>
          <td>${x.status === "pending" ? `<button class="sm ghost" data-act="revoke-inv" data-id="${x.id}" aria-label="Revoke the invitation for ${esc(x.email)}">Revoke</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
        <p class="small muted">${pending.length} pending.</p>` : ""}</section></div>`;
}

function policies() {
  return `<section class="card pad stack" style="max-width:900px"><h2>Policies</h2>
    ${data.policies.policies.map((p) => `<div class="row between"><span><b>${esc(p.title)}</b> <span class="small muted">v${esc(p.version)}</span> ${p.isTemplate ? '<span class="tag">Agamya policy</span>' : '<span class="tag green">your organization version</span>'}</span><span class="small mono">sha256 ${esc(p.contentSha256.slice(0, 12))}…</span></div>`).join("")}
    ${manager() ? `<div class="divider"></div><h3>Publish your organization's version</h3><p class="small muted">Users must accept the new version before continuing. Acceptance is recorded with version and content hash.</p>
      <div class="grid cols-2"><label class="field">Policy<select id="pol-type">${data.policies.policies.map((p) => `<option value="${p.type}">${esc(p.title.replace(" (template)", ""))}</option>`).join("")}</select></label><label class="field">Version<input data-draft="pol-version" placeholder="2026.11"></label></div>
      <label class="field">Text (Markdown)<textarea data-draft="pol-text" rows="6"></textarea></label><div><button class="sm primary" data-act="publish">Publish version</button></div>` : ""}</section>`;
}

function settings() {
  const s = data.settings.settings;
  return `<section class="card pad stack" style="max-width:760px"><h2>Data lifecycle</h2><p class="small muted">Retention per data class. Raw media is short-lived; validated knowledge and audit records are kept. Sweeps run hourly.</p>
    <div class="grid cols-3">${[["raw_media", "Raw media (days)"], ["transcript", "Transcripts (days)"], ["semantic", "Observations (days)"]].map(([k, l]) => `<label class="field">${l}<input type="number" min="1" max="3650" id="ret-${k}" value="${s.retention?.[k] ?? ""}"></label>`).join("")}</div>
    <p class="small muted">Validated knowledge: kept until retired. Audit records: ${s.retention?.audit ?? "—"} days.</p>
    <div class="divider"></div><h2>AI budget</h2><p class="small muted">Model calls are blocked (and the product degrades to deterministic fallbacks) once the monthly estimate is reached.</p>
    <label class="field" style="max-width:240px">Monthly budget (USD)<input type="number" min="0" step="1" id="ai-budget" value="${s.aiMonthlyBudgetUsd ?? ""}"></label>
    <div><button class="primary" data-act="save-settings">Save</button></div></section>`;
}

function audit() {
  return `<section class="card pad"><h2>Audit trail</h2><p class="small muted">Append-only: the application role cannot modify or delete audit records.</p>
    <div class="table-wrap" style="margin-top:10px" role="region" aria-label="Audit trail" tabindex="0"><table class="t"><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Outcome</th></tr>
    ${data.audit.map((a) => `<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${esc(a.actor ?? "system")}</td><td class="mono">${esc(a.action)}</td><td class="small">${esc(a.target_type ?? "")}</td><td><span class="tag ${a.outcome === "success" ? "green" : "red"}">${esc(a.outcome)}</span></td></tr>`).join("")}</table></div></section>`;
}

export async function adminClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  if (a === "tab") { tab = t.dataset.v; return render(); }
  if (a === "role") {
    const m = data.members.find((x) => x.user_id === t.dataset.user);
    const roles = m.roles.includes(t.dataset.role) ? m.roles.filter((r) => r !== t.dataset.role) : [...m.roles, t.dataset.role];
    if (!roles.length) return toast("A member needs at least one role.", true);
    return act("role", async () => { await api("POST", `/api/admin/members/${m.user_id}/roles`, { roles }); data = null; });
  }
  if (a === "remove-member") {
    if (!confirm(`Remove ${t.dataset.name} from this space? Their access ends now and they leave its groups. What they contributed stays. You can invite them again later.`)) return;
    return act("remove", async () => { await api("POST", `/api/admin/members/${t.dataset.user}/remove`, { confirm: true }); toast(`${t.dataset.name} was removed from the space.`); announce(`${t.dataset.name} removed.`); data = null; });
  }
  if (a === "copy-invite") { navigator.clipboard?.writeText(lastInvite.inviteUrl).then(() => { toast("Link copied."); announce("Invitation link copied."); }, () => toast("Copy the link from the box.", true)); return; }
  if (a === "revoke-inv") return act("revoke", async () => { await api("POST", `/api/admin/invitations/${t.dataset.id}/revoke`); toast("Invitation revoked."); data = null; });
  if (a === "invite") {
    const roles = [...document.querySelectorAll("[data-inv-role]")].filter((x) => x.checked).map((x) => x.dataset.invRole);
    const email = draft("inv-email");
    return act("invite", async () => { lastInvite = { ...(await api("POST", "/api/admin/invitations", { email, roles })), email }; state.drafts["inv-email"] = ""; });
  }
  if (a === "publish") return act("publish", async () => { await api("POST", "/api/admin/policies", { type: document.getElementById("pol-type").value, version: draft("pol-version"), content: draft("pol-text") }); toast("Published. Members will be asked to accept it."); data = null; });
  if (a === "save-settings") {
    const retention = Object.fromEntries(["raw_media", "transcript", "semantic"].map((k) => [k, Number(document.getElementById(`ret-${k}`).value)]).filter(([, v]) => v > 0));
    return act("settings", async () => { await api("POST", "/api/admin/settings", { retention, aiMonthlyBudgetUsd: Number(document.getElementById("ai-budget").value) }); toast("Saved."); data = null; });
  }
}
export function invalidateAdmin() { data = null; }

/** After creating an invitation: send it from the inviter's own Gmail (compose window, nothing sent automatically), any mail app, or copy. */
function inviteSent(inv) {
  const space = state.me?.org?.name ?? "our space", from = state.me?.user?.displayName ?? "";
  const subject = `Join ${space} on Agamya`;
  const body = `Hi,

${from ? `${from} invited you` : "You are invited"} to join "${space}" on Agamya, where we capture and pass on how our work is really done.

Open this link to join (valid ${inv.expiresInDays} days, single use):
${inv.inviteUrl}

If you are new, choose your name and a password. If you already use Agamya, enter your existing password.
`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(inv.email ?? "")}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const mailto = `mailto:${encodeURIComponent(inv.email ?? "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `<div class="callout green small stack" role="status"><b>Invitation created for ${esc(inv.email ?? "")}.</b>
    <div class="row wrap"><a class="btn primary sm" href="${esc(gmail)}" target="_blank" rel="noopener">Send with Gmail</a><a class="btn sm" href="${esc(mailto)}">Other email app</a><button class="sm" data-act="copy-invite">Copy link</button></div>
    <code style="word-break:break-all">${esc(inv.inviteUrl)}</code></div>`;
}
