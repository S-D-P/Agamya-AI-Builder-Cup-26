// Shared renderers. Everything that shows knowledge also shows where it came from.
import { esc, fmt, api, toast } from "./core.js";
import { icon, MOD_ICON } from "./icons.js";
import { focusSelectorFor, restoreFocus } from "./a11y.js";
import { langAttr, scriptLang } from "./i18n.js";
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };

export const EP_COPY = {
  OBSERVED: ["Observed", "Directly supported by captured evidence"],
  EXPERT_STATED: ["Expert stated", "The expert said this; their words are quoted"],
  AI_INFERRED: ["AI inferred", "The model's interpretation; not confirmed by evidence or the expert"],
  INSUFFICIENT_EVIDENCE: ["Insufficient evidence", "Not enough evidence to state this safely"],
};
export const LEVEL_COPY = {
  OBSERVED: ["Observed", "Extracted by AI, awaiting the expert's validation"],
  EXPERT_CONFIRMED: ["Expert confirmed", "Approved by the expert who taught it"],
  MULTI_EXPERT_CONFIRMED: ["Multi-expert confirmed", "Confirmed by two or more experts"],
  LEARNER_VALIDATED: ["Learner validated", "Learners transferred it and recognised where it does not apply"],
  CONFLICTED: ["Conflicted", "Experts disagree; the deciding condition is not settled"],
  STALE: ["Stale", "Not revalidated recently"],
  INSUFFICIENT_EVIDENCE: ["Insufficient evidence", "A key field lacks evidence; do not apply blindly"],
  REJECTED: ["Rejected", "Rejected by the expert"],
};
export const GT_COPY = { EXPERT: "Expert-reviewed", REVIEWER: "Reviewer-validated", SYNTHETIC: "Designer-authored (synthetic)", MODEL_DERIVED: "Model-derived (not human-validated)" };

export const ep = (s) => `<span class="ep ep-${s}" title="${esc(EP_COPY[s]?.[1])}">${esc(EP_COPY[s]?.[0] ?? s)}</span>`;
export const lvl = (l) => `<span class="lvl lvl-${l}" title="${esc(LEVEL_COPY[l]?.[1])}">${esc(LEVEL_COPY[l]?.[0] ?? l)}</span>`;
export const levels = (badges = []) => badges.map(lvl).join(" ");
export const gt = (g) => `<span class="tag ${g === "EXPERT" || g === "REVIEWER" ? "green" : g === "SYNTHETIC" ? "sky" : "amber"}" title="Ground-truth source">${esc(GT_COPY[g] ?? g)}</span>`;
export const srcTag = (s) => (s && s !== "gemini" ? `<span class="tag amber" title="Produced without the model">${esc(s === "fallback" ? "deterministic fallback" : s)}</span>` : "");

const CHAIN = [
  ["context", "Context", "the class of situation"], ["observation", "Observation", "the cue the expert looks for"], ["decision", "Decision", "what they do"],
  ["reason", "Reason", "why"], ["condition", "Condition", "what must be true"], ["exception", "Exception", "when the normal way applies"],
  ["boundary", "Boundary", "what flips the decision"], ["risk", "Risk", "what goes wrong otherwise"], ["expectedOutcome", "Outcome", "when done right"],
];

export function judgmentChain(content, { editing = false } = {}) {
  const f = content.fields;
  if (editing) {
    return `<div class="grid cols-2">${CHAIN.map(([k, label]) => `<label class="field">${label}<textarea data-edit="${k}" rows="2">${esc(f[k]?.value)}</textarea></label>`).join("")}
      <label class="field">Deciding condition<textarea data-edit="boundaryCondition" rows="2">${esc(content.boundary?.boundaryCondition)}</textarea></label>
      <label class="field">Normal behaviour applies when<textarea data-edit="defaultWhen" rows="2">${esc(content.boundary?.default?.when)}</textarea></label>
      <label class="field">Normal behaviour<textarea data-edit="defaultDecision" rows="2">${esc(content.boundary?.default?.decision)}</textarea></label></div>`;
  }
  return `<ol class="chain" aria-label="Judgment chain">${CHAIN.map(([k, label, hint], i) => {
    const x = f[k] ?? { status: "INSUFFICIENT_EVIDENCE" };
    return `<li class="node ep-n-${x.status}"><span class="pin" aria-hidden="true">${i + 1}</span><div>
      <div class="node-label">${label} <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:500">${hint}</span> ${ep(x.status)}</div>
      <div class="node-value ${x.value ? "" : "empty"}"${langAttr(scriptLang(x.value))}>${x.value ? esc(x.value) : "Not captured"}</div>
      ${x.valueEn && x.valueEn !== x.value ? `<div class="small muted"><span class="eyebrow">AI translation, not the expert's words</span> <span lang="en">${esc(x.valueEn)}</span></div>` : ""}
      ${x.quote ? `<div class="quote"${langAttr(scriptLang(x.quote))}>“${esc(x.quote)}”</div>` : ""}
      ${x.eventIds?.length ? `<div class="small faint">evidence: ${x.eventIds.map(esc).join(", ")}</div>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

export function boundaryCard(content) {
  const b = content.boundary;
  if (!b) return "";
  const st = b.status === "confirmed" ? `<span class="tag green">${icon("validate", 12)} Boundary confirmed${b.confirmedByExpert ? " by the expert" : " in the expert's words"}</span>` : `<span class="tag amber">${b.status === "unknown" ? "Boundary unknown" : "Needs expert confirmation"}</span>`;
  const srcCopy = { DOCUMENTED_PROCEDURE: "from the documented procedure", EXPERT_STATED: "stated by the expert", OTHER_EXPERT: "another expert's practice", UNKNOWN: "source unknown" };
  return `<section class="boundary" aria-label="Decision boundary"><div class="row between"><h3>Judgment boundary</h3>${st}</div>
    <div class="ifthen"><div><b>IF</b><br>${esc(b.exception?.when || content.fields.condition.value)}<br><b>THEN</b><br>${esc(b.exception?.decision || content.fields.decision.value)}</div>
      <div><b>BUT IF</b><br>${esc(b.default?.when)}<br><b>THEN</b><br>${esc(b.default?.decision)} <span class="small muted">(${srcCopy[b.default?.source] ?? ""})</span></div></div>
    <div class="small"><b>Deciding condition:</b> ${esc(b.boundaryCondition || "—")}${b.status !== "confirmed" && b.hypothesis ? ` · <i>${esc(b.hypothesis)}</i>` : ""}</div>
    ${b.boundaryQuote ? `<div class="small" style="color:var(--rind);font-style:italic;margin-top:4px">“${esc(b.boundaryQuote)}”</div>` : ""}</section>`;
}

/** Documented procedure vs observed behaviour vs expert explanation: never collapsed into one field. */
export function docTriad(content, docConflicts = [], { onDecide = false } = {}) {
  const d = content.documentation ?? {};
  const gap = docConflicts[0];
  const kind = { undocumented_exception: "Undocumented exception", incomplete_procedure: "Incomplete procedure", obsolete_procedure: "Possibly obsolete procedure", contradicts_procedure: "Practice contradicts procedure" };
  return `<section aria-label="Documentation comparison">
    <div class="row between"><h3>${gap ? `${icon("alert", 16)} Potential knowledge gap: ${esc(kind[gap.gap_type] ?? gap.gap_type)}` : "Documentation comparison"}</h3>
      ${gap ? `<span class="tag ${gap.status === "confirmed" ? "green" : gap.status === "dismissed" ? "" : "amber"}">${gap.status === "confirmed" ? "Confirmed: flagged for the procedure owner" : gap.status === "dismissed" ? "Dismissed" : "Needs expert confirmation"}</span>` : ""}</div>
    <div class="triad" style="margin-top:8px"><div><h4>Documented procedure</h4>${esc(d.documentedProcedure ?? "No documented procedure")}<div class="small faint">copied from the organization's documents</div></div>
      <div><h4>Observed expert behaviour</h4>${esc(d.observedBehavior)}</div><div><h4>Expert explanation</h4>${esc(d.expertExplanation)}</div></div>
    ${gap ? `<p class="small muted" style="margin-top:8px">${esc(gap.analysis)} The procedure is not assumed to be wrong.</p>` : ""}
    ${gap && onDecide && gap.status === "unconfirmed" ? `<div class="row" style="margin-top:8px"><button class="sm" data-act="gap" data-id="${gap.id}" data-v="confirm">${icon("validate", 14)} Confirm: a real exception</button><button class="sm ghost" data-act="gap" data-id="${gap.id}" data-v="dismiss">Dismiss</button></div>` : ""}
  </section>`;
}

export function conflictCard(c, { canAnswer = false } = {}) {
  return `<section class="callout ${c.status === "resolved" ? "green" : "red"}" aria-label="Expert disagreement">
    <div class="row between"><h3>${icon("split", 16)} ${c.relation === "compatible_refinement" ? "Expert refinement" : "Expert disagreement"}: ${esc(c.expert_a)} vs ${esc(c.expert_b)}</h3><span class="tag ${c.status === "resolved" ? "green" : "red"}">${c.status === "resolved" ? "Resolved" : "Open"}</span></div>
    <p class="small" style="margin-top:6px">${esc(c.shared_situation)}</p>
    <p style="margin-top:8px"><b>Hidden variable:</b> ${esc(c.hidden_variable || "not yet identified")}</p>
    ${c.distinguishing_facts?.length ? `<table class="t" style="margin-top:8px"><tr><th>Fact</th><th>${esc(c.expert_a)}</th><th>${esc(c.expert_b)}</th></tr>${c.distinguishing_facts.map((f) => `<tr><td>${esc(f.fact)}</td><td>${esc(f.inA)}</td><td>${esc(f.inB)}</td></tr>`).join("")}</table>` : ""}
    ${c.resolution ? `<p class="small" style="margin-top:8px"><b>Merged rule (from the experts' own words):</b> ${esc(c.resolution)}</p>` : ""}
    ${(c.answers ?? []).map((a) => `<p class="small"><b>${esc(a.display_name)}:</b> ${esc(a.answer)}</p>`).join("")}
    ${canAnswer && c.status === "open" ? `<div class="stack" style="margin-top:10px"><label class="field">${esc(c.question)}<textarea data-draft="conflict-${c.id}" rows="2"></textarea></label><button class="sm primary" data-act="conflict-answer" data-id="${c.id}">Answer</button></div>` : ""}
  </section>`;
}

export function evidenceStrip(evidence = [], sessionId) {
  if (!evidence.length) return `<p class="small muted">No evidence linked.</p>`;
  return `<div class="evidence-strip">${evidence.map((e) => {
    if (e.deleted_at) return `<span class="ev-text" aria-disabled="true">${icon(MOD_ICON[e.modality], 12)} removed by the expert</span>`;
    const at = new Date(e.captured_at).toISOString();
    if (e.media_asset_id && (e.kind === "frame" || e.kind === "rendered_frame") && !["purged", "deleted"].includes(e.media_status)) {
      return `<button class="ev-thumb" data-act="evidence" data-session="${sessionId}" data-at="${at}" aria-label="Open evidence from ${new Date(e.captured_at).toLocaleTimeString()}"><img src="/api/media/${e.media_asset_id}" alt="" loading="lazy"><span>${esc(e.role.replace("_", " "))} · ${new Date(e.captured_at).toLocaleTimeString()}</span></button>`;
    }
    return `<button class="ev-text" data-act="evidence" data-session="${sessionId}" data-at="${at}">${icon(MOD_ICON[e.modality], 12)} <b>${esc(e.role.replace("_", " "))}</b> ${esc(clip(e.text, 110))}</button>`;
  }).join("")}</div>`;
}

/** Evidence viewer: the temporal window around a moment, across modalities. */
export async function openEvidence(sessionId, at) {
  let w;
  const back = focusSelectorFor(document.activeElement);
  try { w = await api("GET", `/api/sessions/${sessionId}/window?at=${encodeURIComponent(at)}&span=8000`); } catch (e) { return toast(e.message, true); }
  const dlg = document.createElement("dialog");
  dlg.setAttribute("aria-labelledby", "ev-dlg-h");
  dlg.innerHTML = `<div class="dialog-head"><h2 id="ev-dlg-h">${icon("clock", 18)} Evidence around ${new Date(at).toLocaleTimeString()}</h2><button class="ghost icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="dialog-body stack">
      <p class="small muted">Everything captured within ±${w.spanMs / 1000}s, across modalities, in time order. Raw media may have been purged by the retention policy; the extracted text remains.</p>
      ${w.observations.map((o) => `<div class="event"><span class="ico">${icon(MOD_ICON[o.modality], 14)}</span><div><div class="small faint">${new Date(o.captured_at).toLocaleTimeString()} · ${o.modality}</div>
        ${o.media_asset_id && !o.deleted_at && ["SCREEN", "CAMERA"].includes(o.modality) ? `<img src="/api/media/${o.media_asset_id}" alt="Captured frame" style="width:100%;max-width:520px;border-radius:10px;margin:6px 0;border:1px solid var(--line)" data-fallback="raw frame purged by retention">` : ""}
        ${o.media_asset_id && !o.deleted_at && o.modality === "MICROPHONE" ? `<audio controls src="/api/media/${o.media_asset_id}" style="width:100%;margin:6px 0"></audio>` : ""}
        <div>${o.deleted_at ? "<i>deleted by the expert</i>" : esc(o.text || "(no meaningful change)")}</div></div><span></span></div>`).join("") || `<p class="muted">Nothing in this window.</p>`}
      ${w.transcript.length ? `<h3>Transcript</h3>${w.transcript.map((t) => `<p class="small"><span class="faint">${new Date(t.start_at).toLocaleTimeString()}</span> ${esc(t.text)}</p>`).join("")}` : ""}
      ${w.videoChunks.length ? `<h3>Video evidence</h3>${w.videoChunks.map((v) => `<video controls src="/api/media/${v.id}" style="width:100%;border-radius:10px"></video>`).join("")}` : ""}
    </div>`;
  document.body.appendChild(dlg);
  // no inline handlers (strict CSP): attach fallbacks programmatically
  dlg.querySelectorAll("img[data-fallback]").forEach((img) => img.addEventListener("error", () => img.replaceWith(Object.assign(document.createElement("span"), { className: "small faint", textContent: img.dataset.fallback }))));
  dlg.addEventListener("close", () => { dlg.remove(); restoreFocus(back, document.getElementById("main")); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-close]")) dlg.close(); });
  dlg.showModal();
}

export function signal(value, label, cls = "", hint = "") {
  return `<div class="signal ${cls}" ${hint ? `title="${esc(hint)}"` : ""}><span class="v">${value}</span><span class="k">${esc(label)}</span></div>`;
}

export function bars(rows, { valueKey, labelKey, winner, format = fmt }) {
  const max = Math.max(...rows.map((r) => r[valueKey] || 0), 1);
  return `<div class="bars" role="list">${rows.map((r) => `<div class="bar-row" role="listitem"><span>${esc(r[labelKey])}</span><div class="bar" aria-hidden="true"><i class="${r[labelKey] === winner ? "win" : ""}" style="width:${((r[valueKey] || 0) / max) * 100}%"></i></div><span>${format(r[valueKey])}</span></div>`).join("")}</div>`;
}

export function statusChip(status) {
  const map = {
    awaiting_consent: ["Awaiting consent", ""], capturing: ["Capturing", "live"], processing: ["Processing media", "busy"], analyzing: ["Looking back for judgment", "busy"],
    asking: ["Question for the expert", "ask"], extracting: ["Structuring the explanation", "busy"], validating: ["Awaiting expert validation", "ask"], done: ["Knowledge recorded", "done"],
    no_judgment: ["No interruption needed", "done"], failed: ["Failed", ""],
  };
  const [label, cls] = map[status] ?? [status, ""];
  return `<span class="status-chip ${cls}" role="status">${cls === "live" ? '<span class="rec" aria-hidden="true"></span>' : cls === "busy" ? '<span class="thinking" aria-hidden="true"></span>' : ""}${esc(label)}</span>`;
}
