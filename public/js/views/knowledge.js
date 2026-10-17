// KNOWLEDGE: evidence-backed artifacts with provenance, open questions and the contributor's sharing choices.
// Workplace: a library per workflow. Living space: "my knowledge" and "shared with me" across skills.
import { state, api, esc, render, act, go, draft, workflow, has, ago, toast, isLiving } from "../core.js";
import { icon } from "../icons.js";
import { orb } from "../persona.js";
import { judgmentChain, boundaryCard, docTriad, conflictCard, evidenceStrip, openEvidence, levels, LEVEL_COPY, EP_COPY, ep, lvl, srcTag } from "../components.js";
import { visTag } from "./living.js";
import { gapsPanel, testsPanel, detectiveClick, detectiveChange, invalidateDetective } from "./detective.js";
import { announce } from "../a11y.js";

let list = null, current = null, people = null, groupsList = null, gov = null, craftEditing = false;
const CRAFT = [["materials", "Materials"], ["tools", "Tools"], ["conditions", "Conditions"], ["sensoryCues", "Signals to sense"], ["timing", "Timing"], ["terms", "Local terms"]];

export function knowledgeView(r) {
  const living = isLiving();
  if (!living && !has("ORG_ADMIN", "WORKFLOW_OWNER", "REVIEWER", "EXPERT")) return `<div class="card pad">${icon("lock", 16)} The knowledge library is for experts, workflow owners and reviewers. Learners practise through lessons, so answers are not shown up front.</div>`;
  const w = workflow();
  if (!living && !w) return `<div class="page-head"><div><h1>Knowledge library</h1></div></div><div class="card pad empty">${orb("observing", 72)}<p>Nothing captured in this space yet. Start a session from <a href="#/">Home</a>; confirmed Work Maps appear there.</p></div>`;
  const key = living ? "mine" : w?.id;
  if (!list || list.key !== key) {
    (living ? api("GET", "/api/knowledge/mine").then((m) => [...m.mine, ...m.sharedWithMe]) : api("GET", `/api/workflows/${w.id}/knowledge`))
      .then((rows) => { list = { key, rows }; render(); }).catch((e) => { list = { key, rows: [] }; toast(e.message, true); render(); }); // fail once, not on every render
    return `<span class="thinking">Loading knowledge</span>`;
  }
  const id = r.id ?? list.rows[0]?.id;
  if (id && (!current || current.id !== id)) { api("GET", `/api/judgments/${id}`).then((j) => { current = j; gov = null; craftEditing = false; render(); }).catch((e) => { toast(e.message, true); }); }
  const head = living
    ? `<div class="page-head"><div><h1>My knowledge</h1><p>What you preserved, and what others chose to share with you. Each item shows what was observed, what was said, and what is still uncertain.</p></div></div>`
    : `<div class="page-head"><div><div class="eyebrow">${esc(w.name)}</div><h1>Knowledge library</h1><p>Every claim shows where it came from: observed, stated by the expert, or inferred by AI. Confirmation comes only from people and evidence, never from model confidence.</p></div></div>`;
  return `${head}
  ${list.rows.length ? `<div class="knowledge-grid">
    <aside class="stack"><ul class="klist plain" aria-label="${living ? "Knowledge" : "Knowledge in this workflow"}">${list.rows.map((k) => `<li><button class="card kitem" data-act="pick" data-id="${k.id}" aria-current="${k.id === id}"><b>${esc(k.title)}</b>
      <span class="small muted">${living ? `${esc(k.workflowName)} · ` : ""}${esc(k.expertName)} · ${ago(k.createdAt)}</span>
      <span class="row">${k.levels ? levels(k.levels.badges) : k.status === "observed" ? '<span class="tag amber">awaiting review</span>' : ""}${k.withdrawn ? '<span class="tag">withdrawn</span>' : visTag(k.visibility, k.sharedCount)}</span></button></li>`).join("")}</ul>
      <details class="card pad small"><summary><b>How to read this</b></summary><div class="legend" style="margin-top:8px">
        <div class="eyebrow">Each field</div>${Object.keys(EP_COPY).map((k) => `<div>${ep(k)} ${esc(EP_COPY[k][1])}</div>`).join("")}
        <div class="eyebrow" style="margin-top:8px">Each piece of knowledge</div>${Object.keys(LEVEL_COPY).filter((k) => k !== "REJECTED").map((k) => `<div>${lvl(k)} ${esc(LEVEL_COPY[k][1])}</div>`).join("")}</div></details></aside>
    <section>${current && current.id === id ? detail(current) : `<span class="thinking">Loading</span>`}</section></div>`
    : `<div class="card empty">${orb("observing", 80)}<p>${living ? "Nothing preserved or shared with you yet." : "No knowledge captured for this workflow yet."}</p>${has("EXPERT") ? `<a class="btn primary" href="#/capture">${icon("capture", 15)} ${living ? "Capture a skill" : "Capture expertise"}</a>` : ""}</div>`}`;
}

function detail(j) {
  const c = j.content, g = j.artifact?.governance, living = j.experience === "living";
  const canPeer = j.status === "approved" && state.me.roles.includes("EXPERT") && !j.isMine && !j.validations.some((v) => v.kind === "PEER_CONFIRMED" && v.display_name === state.me.user.displayName);
  return `<div class="card pad stack">
    <div class="row between"><div><div class="eyebrow">${esc(j.workflowName)} · ${living ? "taught" : "captured"} by ${esc(j.expertName)} · v${j.currentVersion} ${srcTag(j.extractionSource)}</div><h2>${esc(c.title)}</h2>
      ${g?.attribution ? `<div class="small muted">Attribution: ${esc(g.attribution)}</div>` : ""}</div><div class="row">${levels(j.levels.badges)}</div></div>
    ${j.artifact?.status === "retired" ? `<div class="callout">${icon("eyeoff", 14)} Withdrawn by its contributor ${j.artifact.withdrawnAt ? ago(j.artifact.withdrawnAt) : ""}. It is no longer taught or used, and its evidence media was deleted.</div>` : ""}
    ${g?.restricted ? `<div class="callout amber small">${icon("shield", 14)} <b>Restricted.</b> ${esc(g.restrictionNote || "Shared only with named people.")}</div>` : ""}
    ${j.artifact ? `<div class="callout small"><b>In one line:</b> ${esc(j.artifact.rule)} ${j.artifact.embedded ? '<span class="tag sky">searchable</span>' : ""}</div>` : ""}
    ${boundaryCard(c)}
    ${j.status === "rejected" ? "" : gapsPanel(j)}
    ${testsPanel(j)}
    ${j.unresolved?.length ? `<section class="callout amber small"><b>${icon("question", 14)} Still uncertain</b><ul>${j.unresolved.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></section>` : ""}
    <div class="kdetail"><div>${judgmentChain(c)}</div><div class="stack">
      ${g ? governance(j, g) : ""}
      ${living || Object.keys(g?.craftContext ?? {}).length ? craft(j, g) : ""}
      <div class="card pad"><div class="eyebrow">Evidence (click to open the moment)</div>${evidenceStrip(j.evidence, j.sessionId)}</div>
      <div class="card pad small stack"><div class="eyebrow">Provenance</div>
        <dl class="kv"><dt>${living ? "Skill" : "Workflow"}</dt><dd>${esc(j.workflowName)}</dd><dt>${living ? "Teacher" : "Expert"}</dt><dd>${esc(j.expertName)}</dd><dt>Captured</dt><dd>${new Date(j.createdAt).toLocaleString()}</dd>
          <dt>${living ? "Written recipe" : "Source document"}</dt><dd>${esc(j.provenance.sourceDocument ?? "—")}</dd><dt>AI confidence (self-reported)</dt><dd>${c.aiConfidence ?? "—"} <span class="muted" style="font-weight:500">not used as evidence</span></dd>
          <dt>Last validated</dt><dd>${j.artifact ? ago(j.artifact.lastValidatedAt) : "never"}</dd><dt>Learner attempts</dt><dd>${j.provenance.learnerAttempts}</dd></dl>
        <div class="eyebrow">Validations</div>${j.validations.map((v) => `<div class="row"><span class="tag ${v.kind.includes("LEARNER_OVER") ? "red" : v.kind.includes("LEARNER") ? "pink" : v.kind === "RETIRED" ? "" : "green"}">${esc(v.kind.replace(/_/g, " ").toLowerCase())}</span>${esc(v.display_name ?? "")} <span class="faint">${ago(v.created_at)}${v.ground_truth_source ? ` · ${esc(v.ground_truth_source.toLowerCase().replace("_", " "))}` : ""}</span></div>`).join("") || '<span class="muted">none yet</span>'}
        ${canPeer ? `<button class="sm" data-act="peer" data-id="${j.artifact.id}">${icon("validate", 14)} Confirm as another expert</button>` : ""}</div>
      <div class="card pad small"><div class="eyebrow">Versions</div><div class="versions">${j.versions.map((v) => `<div><b>v${v.version}</b> · ${v.authorType === "ai" ? "AI draft" : living ? "teacher" : "expert"} · ${ago(v.createdAt)}${v.notes?.length ? `<ul>${v.notes.map((n) => `<li class="muted">${esc(n)}</li>`).join("")}</ul>` : ""}</div>`).join("")}</div></div>
    </div></div>
    ${docTriad(c, j.docConflicts, { onDecide: j.isMine || state.me.roles.includes("WORKFLOW_OWNER") })}
    ${j.conflicts.map((x) => conflictCard(x, { canAnswer: state.me.roles.some((r) => ["EXPERT", "WORKFLOW_OWNER"].includes(r)) })).join("")}
    ${j.status === "observed" ? `<div class="callout amber">Awaiting review by ${esc(j.expertName)}. ${j.isMine ? `<a href="#/session/${j.sessionId}">Review it now</a>` : ""}</div>` : ""}
  </div>`;
}

function governance(j, g) {
  const VIS = { private: "Only the contributor", named: "Named people", organization: j.experience === "living" ? "Everyone in this space" : "Everyone in the organization who learns this workflow" };
  if (g.canEdit && gov) {
    const others = (people ?? []).filter((p) => p.id !== state.me.personId);
    return `<div class="card pad stack small"><div class="eyebrow">${icon("users", 13)} Who can see this</div>
      <div class="seg" role="group" aria-label="Visibility">${Object.entries(VIS).map(([v, l]) => `<button aria-pressed="${gov.visibility === v}" data-act="gov-vis" data-v="${v}" data-focus="gov-v-${v}" ${gov.restricted && v === "organization" ? "disabled" : ""}>${esc(l.split(" ").slice(0, 2).join(" "))}</button>`).join("")}</div>
      ${gov.visibility === "named" ? `<div class="stack"><span class="eyebrow">People</span><div class="row" role="group" aria-label="People to share with">${others.map((p) => `<button class="chip" aria-pressed="${gov.named.has(p.id)}" data-act="gov-person" data-p="${p.id}" data-focus="gov-p-${p.id}">${esc(p.display_name)}</button>`).join("")}</div>
        ${(groupsList ?? []).length ? `<span class="eyebrow">Groups</span><div class="row" role="group" aria-label="Groups to share with">${groupsList.map((g) => `<button class="chip" aria-pressed="${gov.groups.has(g.id)}" data-act="gov-group" data-g="${g.id}" data-focus="gov-g-${g.id}">${icon("users", 12)} ${esc(g.name)} <span class="muted">(${g.members})</span></button>`).join("")}</div>
          <p class="small muted">Sharing with a group follows its membership: people who leave the group lose access; people who join gain it.</p>` : ""}</div>` : ""}
      ${gov.preview ? `<div class="callout small stack" role="status" aria-live="polite"><b>Who will be able to see this</b>
        ${gov.preview.everyone ? `<p>Everyone in this space (${gov.preview.count} people).</p>` : gov.preview.people.length ? `<ul class="plain">${gov.preview.people.map((p) => `<li>${esc(p.name)} <span class="muted">· ${esc(p.via.join(", "))}</span></li>`).join("")}</ul>` : `<p>Only you.</p>`}
        <p class="muted">Public publication and use for training AI models are not offered.</p></div>` : ""}
      <label class="check"><input type="checkbox" id="gov-restricted" ${gov.restricted ? "checked" : ""}> Restricted (named people only)</label>
      ${gov.restricted ? `<input data-draft="gov-note" placeholder="Note for learners, e.g. family only">` : ""}
      <label class="field">Attribution<input data-draft="gov-attr" placeholder="Lakshmi, as her mother taught her"></label>
      <div class="row"><button class="primary sm" data-act="gov-save" ${state.busy ? "disabled" : ""}>${gov.preview ? "Confirm and save" : "Review who can see this"}</button><button class="ghost sm" data-act="gov-cancel">Cancel</button></div></div>`;
  }
  return `<div class="card pad small stack"><div class="eyebrow">${icon("users", 13)} Who can see this</div>
    <div>${visTag(g.visibility, g.sharedWith.length + (g.sharedGroups?.length ?? 0))} ${g.visibility === "named" ? esc([...g.sharedWith.map((p) => p.name), ...(g.sharedGroups ?? []).map((x) => `group ${x.name}${x.archived ? " (archived)" : ""}`)].join(", ")) : ""}</div>
    <dl class="kv"><dt>Public publication</dt><dd>Not offered</dd><dt>Use to train AI models</dt><dd>Not offered</dd></dl>
    ${g.canEdit ? `<div class="row"><button class="sm" data-act="gov-edit">${icon("share", 13)} Change sharing</button><button class="sm danger" data-act="withdraw" data-id="${j.artifact.id}">Withdraw</button></div>` : ""}</div>`;
}

function craft(j, g) {
  const cc = g?.craftContext ?? {};
  if (craftEditing && g?.canEdit) {
    return `<div class="card pad stack small"><div class="eyebrow">Context that matters</div>
      ${CRAFT.map(([k, l]) => `<label class="field">${l}<textarea data-draft="cc-${k}" rows="2"></textarea></label>`).join("")}
      <div class="row"><button class="primary sm" data-act="cc-save" ${state.busy ? "disabled" : ""}>Save</button><button class="ghost sm" data-act="cc-cancel">Cancel</button>${suggestion() ? `<button class="sm ghost" data-act="cc-fill">Use the sample notes</button>` : ""}</div>
      <p class="small muted">Written by the teacher, in their own words. Agamya does not invent these.</p></div>`;
  }
  const filled = CRAFT.filter(([k]) => cc[k]);
  return `<div class="card pad small stack"><div class="eyebrow">Context that matters</div>
    ${filled.length ? `<dl class="facts">${filled.map(([k, l]) => `<dt>${l}</dt><dd>${esc(cc[k])}</dd>`).join("")}</dl>` : `<p class="muted">Materials, tools, conditions, sensory signals, timing and local terms${g?.canEdit ? ", in your own words." : " have not been added."}</p>`}
    ${g?.canEdit ? `<div><button class="sm" data-act="cc-edit">${filled.length ? "Edit" : "Add context"}</button></div>` : ""}</div>`;
}

// Sample spaces only: the scripted notes for the featured journey, clearly offered as a suggestion the teacher can change.
let sessionScript = null;
function suggestion() { return state.me?.org?.sampleKind === "living" ? sessionScript : null; }

export async function knowledgeClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const a = t.dataset.act;
  const refresh = async () => { current = await api("GET", `/api/judgments/${current.id}`); list = null; return current; };
  if (current && await detectiveClick(e, current, refresh)) return;
  if (a === "pick") return go(`#/knowledge/${t.dataset.id}`);
  if (a === "evidence") return openEvidence(t.dataset.session, t.dataset.at);
  if (a === "peer") return act("peer", async () => { await api("POST", `/api/knowledge/${t.dataset.id}/peer-confirm`); await refresh(); });
  if (a === "gap") return act("gap", async () => { await api("POST", `/api/doc-conflicts/${t.dataset.id}`, { decision: t.dataset.v }); await refresh(); });
  if (a === "conflict-answer") { const ans = draft(`conflict-${t.dataset.id}`); if (!ans) return; return act("conflict", async () => { await api("POST", `/api/expert-conflicts/${t.dataset.id}/answer`, { answer: ans }); await refresh(); }); }
  if (a === "gov-edit") {
    const g = current.artifact.governance;
    if (!people) people = await api("GET", "/api/people");
    if (!groupsList) groupsList = (await api("GET", "/api/groups").catch(() => ({ groups: [] }))).groups;
    gov = { visibility: g.visibility, named: new Set(g.sharedWith.map((p) => p.id)), groups: new Set((g.sharedGroups ?? []).filter((x) => !x.archived).map((x) => x.id)), restricted: g.restricted, preview: null };
    state.drafts["gov-note"] = g.restrictionNote ?? ""; state.drafts["gov-attr"] = g.attribution ?? "";
    return render();
  }
  if (a === "gov-cancel") { gov = null; return render(); }
  if (a === "gov-vis") { gov.visibility = t.dataset.v; gov.preview = null; return render(); }
  if (a === "gov-person") { gov.named.has(t.dataset.p) ? gov.named.delete(t.dataset.p) : gov.named.add(t.dataset.p); gov.preview = null; return render(); }
  if (a === "gov-group") { gov.groups.has(t.dataset.g) ? gov.groups.delete(t.dataset.g) : gov.groups.add(t.dataset.g); gov.preview = null; return render(); }
  if (a === "gov-save") {
    const named = gov.visibility === "named";
    const body = { visibility: gov.visibility, sharedWith: named ? [...gov.named] : [], sharedGroups: named ? [...gov.groups] : [] };
    // Two steps: first show exactly who would have access, then save on confirmation.
    if (!gov.preview) return act("share", async () => { gov.preview = await api("POST", `/api/knowledge/${current.artifact.id}/access-preview`, body); announce("Review who will be able to see this, then confirm."); });
    return act("share", async () => {
      await api("POST", `/api/knowledge/${current.artifact.id}/sharing`, { ...body, restricted: gov.restricted, restrictionNote: draft("gov-note"), attribution: draft("gov-attr") });
      gov = null; await refresh(); toast("Sharing updated."); announce("Sharing updated.");
    });
  }
  if (a === "withdraw") {
    if (!confirm("Withdraw this knowledge? It is removed from everyone's lessons and its evidence media is deleted. This cannot be undone.")) return;
    return act("withdraw", async () => { await api("POST", `/api/knowledge/${t.dataset.id}/withdraw`); await refresh(); toast("Withdrawn."); });
  }
  if (a === "cc-edit") {
    const cc = current.artifact.governance.craftContext ?? {};
    for (const [k] of CRAFT) state.drafts[`cc-${k}`] = cc[k] ?? "";
    if (state.me?.org?.sampleKind === "living" && !sessionScript) sessionScript = (await api("GET", `/api/sessions/${current.sessionId}`).catch(() => null))?.sim?.script?.craftContext ?? null;
    craftEditing = true; return render();
  }
  if (a === "cc-fill") { for (const [k] of CRAFT) if (sessionScript?.[k]) state.drafts[`cc-${k}`] = sessionScript[k]; return render(); }
  if (a === "cc-cancel") { craftEditing = false; return render(); }
  if (a === "cc-save") return act("craft", async () => {
    await api("POST", `/api/knowledge/${current.artifact.id}/sharing`, { craftContext: Object.fromEntries(CRAFT.map(([k]) => [k, draft(`cc-${k}`)])) });
    craftEditing = false; await refresh(); toast("Saved.");
  });
}

export function knowledgeChange(e) {
  if (detectiveChange(e)) return;
  if (e.target.id === "gov-restricted" && gov) { gov.restricted = e.target.checked; gov.preview = null; if (gov.restricted && gov.visibility === "organization") gov.visibility = "named"; return render(); }
}
export function invalidateKnowledge() { invalidateDetective(); groupsList = null; list = null; current = null; gov = null; craftEditing = false; }
