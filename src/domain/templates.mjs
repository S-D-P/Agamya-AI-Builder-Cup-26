// KT mission templates. A template configures the PROCESS (suggested capture methods, starter questions, expected
// outputs, assessment criteria, approval steps, retention preference); it never dictates content and never selects a
// different engine. Every template is a starting point the coordinator edits. "general" fits anything.
// Capture methods: audio · audio_video · screen (with narration) · text (typed steps, documents, manual observations).

export const CAPTURE_METHODS = {
  audio: { label: "Audio recording", source: "live:audio", modalities: ["MICROPHONE"] },
  audio_video: { label: "Audio + video (camera)", source: "live:camera", modalities: ["CAMERA", "MICROPHONE"] },
  screen: { label: "Screen recording with narration", source: "live:screen", modalities: ["SCREEN", "MICROPHONE"] },
  text: { label: "Text, documents and manual observations", source: "manual", modalities: [] },
};

const BASE_RETENTION = { rawMediaDays: 30, note: "Original recordings are kept for 30 days for review, then only the evidence linked to approved knowledge is kept." };

export const BUILTIN_TEMPLATES = [
  {
    key: "software_handover", name: "Software and legacy-system handover", domain: "technical", workflowKind: "software",
    description: "Hand over how an experienced engineer operates, debugs or recovers a system, including what the runbook gets wrong.",
    captureMethods: ["screen", "audio", "text"],
    questions: ["Which alerts or error codes do you treat differently from the runbook, and why?", "What do you check before retrying or restarting anything?", "Which periods (month-end, releases, batch windows) change what is safe?"],
    outputs: ["Decision rules with the conditions that trigger them", "Exceptions to the documented procedure", "Escalation criteria"],
    criteria: ["Explains why the documented step is or is not safe in this situation", "Names the signal that changes the decision", "Knows when to stop and escalate"],
    approvals: ["expert"], retention: BASE_RETENTION,
  },
  {
    key: "business_process", name: "Business process and operational workflow", domain: "business", workflowKind: "document",
    description: "Transfer judgment inside a recurring business process: approvals, reconciliations, reporting, customer handling.",
    captureMethods: ["screen", "audio", "text"],
    questions: ["Where do you deviate from the written process, and what makes you do it?", "Which numbers or fields do you sanity-check, and against what?", "What has gone wrong before, and how did you notice?"],
    outputs: ["Checks and thresholds the expert applies", "Known failure patterns", "Who to involve and when"],
    criteria: ["Applies the expert's checks to a new case", "Recognises a known failure pattern", "Does not apply a special rule outside its condition"],
    approvals: ["expert"], retention: BASE_RETENTION,
  },
  {
    key: "manufacturing", name: "Manufacturing or equipment operation", domain: "physical", workflowKind: "physical",
    description: "Capture how an operator reads machines, materials and conditions. Safety constraints always take precedence.",
    captureMethods: ["audio_video", "audio", "text"],
    questions: ["What do you look, listen or feel for before adjusting the machine?", "Which material or environmental conditions change your settings?", "When do you stop the line?"],
    outputs: ["Sensory signals and thresholds", "Condition-dependent settings", "Stop and escalation rules"],
    criteria: ["Identifies the physical signal that matters", "Adjusts for the condition rather than copying a setting", "Stops when safety requires it"],
    approvals: ["expert", "reviewer"], retention: { rawMediaDays: 90, note: "Recordings may show the workplace; they are kept 90 days for safety review, then only linked evidence is kept." },
  },
  {
    key: "retirement", name: "Expert retirement or employee transition", domain: "transition", workflowKind: "hybrid",
    description: "A planned handover before someone leaves or changes role: capture what only they know, then check that it transferred.",
    captureMethods: ["screen", "audio_video", "audio", "text"],
    questions: ["What do people call you about that nobody else can answer?", "Which decisions would you hate to see made by the book?", "Who should own each of these after you leave?"],
    outputs: ["The decisions only this person makes today", "Contacts and escalation paths", "Open risks after the handover"],
    criteria: ["Handles the expert's most common exception unaided", "Knows who to ask for what remains uncovered"],
    approvals: ["expert"], retention: BASE_RETENTION,
  },
  {
    key: "cultural_craft", name: "Cultural and craft knowledge", domain: "cultural", workflowKind: "physical",
    description: "Preserve a craft, recipe, art or tradition with its sensory signals, materials, timing and local terms.",
    captureMethods: ["audio_video", "audio", "text"],
    questions: ["What tells you it is ready, if not the clock?", "How do materials or the season change what you do?", "Which words for this have no good translation?"],
    outputs: ["Signals to sense", "Materials, tools and conditions", "Local terms with their meaning"],
    criteria: ["Decides by the signal, not by the written quantity or time", "Adapts to a different material or condition"],
    approvals: ["expert"], retention: { rawMediaDays: 365, note: "Recordings of a tradition are kept a year unless the teacher removes them sooner." },
  },
  {
    key: "language", name: "Language and communication knowledge", domain: "language", workflowKind: "hybrid",
    description: "Pass on how something is said: register, phrasing, pronunciation and what a literal translation would lose.",
    captureMethods: ["audio", "audio_video", "text"],
    questions: ["When would you say it this way and not the other?", "What would a literal translation get wrong?", "How does it change with the listener (elder, child, customer)?"],
    outputs: ["Phrases with their context of use", "Translation traps", "Register rules"],
    criteria: ["Chooses the right register for the listener", "Avoids the literal-translation trap"],
    approvals: ["expert"], retention: BASE_RETENTION,
  },
  {
    key: "general", name: "General / custom", domain: "general", workflowKind: "hybrid",
    description: "Any knowledge that does not fit a category. Describe it in your own words.",
    captureMethods: ["audio", "audio_video", "screen", "text"],
    questions: ["What do you do differently from how it is usually described, and why?"],
    outputs: ["Decisions with their reasons and exceptions"],
    criteria: ["Applies the expert's reasoning to a new case"],
    approvals: ["expert"], retention: BASE_RETENTION,
  },
];

export const templateByKey = (key) => BUILTIN_TEMPLATES.find((t) => t.key === key) ?? null;

/** Sanitise a coordinator-edited template config: only known fields, bounded sizes, known capture methods. */
export function cleanTemplateConfig(input, base) {
  const list = (v, n = 12) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim().slice(0, 300)).filter(Boolean).slice(0, n) : []);
  const c = input ?? {};
  return {
    key: base.key, name: String(c.name ?? base.name).trim().slice(0, 120) || base.name, domain: base.domain, workflowKind: base.workflowKind,
    description: String(c.description ?? base.description).slice(0, 500),
    captureMethods: (list(c.captureMethods, 4).filter((m) => CAPTURE_METHODS[m]).length ? list(c.captureMethods, 4).filter((m) => CAPTURE_METHODS[m]) : base.captureMethods),
    questions: c.questions !== undefined ? list(c.questions) : base.questions,
    outputs: c.outputs !== undefined ? list(c.outputs) : base.outputs,
    criteria: c.criteria !== undefined ? list(c.criteria) : base.criteria,
    approvals: Array.isArray(c.approvals) && c.approvals.every((a) => ["expert", "reviewer"].includes(a)) && c.approvals.includes("expert") ? c.approvals : base.approvals,
    retention: { rawMediaDays: Math.max(1, Math.min(3650, Number(c.retention?.rawMediaDays ?? base.retention.rawMediaDays) || base.retention.rawMediaDays)), note: String(c.retention?.note ?? base.retention.note).slice(0, 300) },
  };
}

// ---------------------------------------------------------------- the KT Mission Brief
export const BRIEF_LISTS = ["objectives", "outcomes", "decisions", "blindSpots", "questions", "acceptance", "constraints"];
export const BRIEF_TEXTS = ["scope", "outOfScope", "sops", "captureNotes", "languageNotes", "retentionNotes"];

export function cleanBrief(input = {}) {
  const out = {};
  for (const k of BRIEF_LISTS) out[k] = Array.isArray(input[k]) ? input[k].map((x) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 400)).filter(Boolean).slice(0, 20) : [];
  for (const k of BRIEF_TEXTS) out[k] = String(input[k] ?? "").trim().slice(0, 4000);
  return out;
}

// Markdown headings → brief fields. English headings; content may be in any language. Unknown sections go to "sops".
const HEADINGS = [
  [/out[- ]of[- ]scope|not in scope/i, "outOfScope"], [/objective|goal|purpose/i, "objectives"], [/outcome|expected learning|learner should/i, "outcomes"],
  [/scope/i, "scope"], [/sop|procedure|documentation|existing instruction|reference/i, "sops"], [/skill|decision|demonstrat/i, "decisions"],
  [/blind ?spot|exception|edge case|failure|pitfall|incident/i, "blindSpots"], [/question/i, "questions"], [/accept|criteria|review requirement|definition of done/i, "acceptance"],
  [/safety|confidential|regulat|constraint|restriction|operational/i, "constraints"], [/capture|method|modalit|recording/i, "captureNotes"],
  [/language/i, "languageNotes"], [/retention|sharing|access/i, "retentionNotes"],
];

/** Deterministic, model-free parsing of a README-style brief. The coordinator reviews the result before it is used. */
export function parseBriefMarkdown(text) {
  const brief = cleanBrief({});
  let field = "sops";
  const unmatched = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // "## Heading" or a short "Heading:" line that is not itself a list item
    const h = /^#{1,6}\s+(.+)$/.exec(line) ?? (line.length < 60 && !/^([-*•]|\d+[.)])\s/.test(line) ? /^(.+):$/.exec(line) : null);
    if (h) { const hit = HEADINGS.find(([re]) => re.test(h[1])); field = hit ? hit[1] : "sops"; if (!hit) unmatched.push(h[1].slice(0, 60)); continue; }
    const item = line.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s+/, "").trim();
    if (!item) continue;
    if (BRIEF_LISTS.includes(field)) brief[field].push(item.slice(0, 400));
    else brief[field] = (brief[field] ? `${brief[field]}\n` : "") + item;
  }
  return { brief: cleanBrief(brief), unmatchedHeadings: unmatched };
}

/** The brief as Markdown (stored as the mission workflow's document so existing document understanding can use it). */
export function briefToMarkdown(name, b) {
  const sec = (title, v) => (Array.isArray(v) ? (v.length ? `## ${title}\n${v.map((x) => `- ${x}`).join("\n")}\n` : "") : v ? `## ${title}\n${v}\n` : "");
  return [`# KT Mission Brief: ${name}`, sec("Objectives", b.objectives), sec("Expected outcomes", b.outcomes), sec("Scope", b.scope), sec("Out of scope", b.outOfScope),
    sec("Existing instructions and SOPs", b.sops), sec("Decisions the receiver must demonstrate", b.decisions), sec("Known blind spots and exceptions", b.blindSpots),
    sec("Questions for the expert", b.questions), sec("Acceptance criteria", b.acceptance), sec("Constraints", b.constraints), sec("Capture", b.captureNotes),
    sec("Language", b.languageNotes), sec("Retention and sharing", b.retentionNotes)].filter(Boolean).join("\n");
}

/** Moti's pre-capture summary: built from the brief itself (no model), so the expert confirms exactly what was written. */
export function motiSummary(m, b) {
  return {
    purpose: b.objectives[0] ?? m.description ?? "",
    objectives: b.objectives, outcomes: b.outcomes, decisions: b.decisions,
    constraints: b.constraints, outOfScope: b.outOfScope,
    focus: { blindSpots: b.blindSpots.length, questions: b.questions.length, acceptance: b.acceptance.length },
    note: "This summary repeats the brief; it does not add to it. The brief guides questions and checks. It cannot change who may see anything, consent, or safety rules.",
  };
}

/** Text given to the model as untrusted focus data during capture and gap detection (never as instructions). */
export function briefFocus(b) {
  const parts = [];
  if (b.objectives.length) parts.push(`Objectives: ${b.objectives.join("; ")}`);
  if (b.decisions.length) parts.push(`Decisions the receiver must be able to make: ${b.decisions.join("; ")}`);
  if (b.blindSpots.length) parts.push(`Known blind spots / exceptions to explore: ${b.blindSpots.join("; ")}`);
  if (b.questions.length) parts.push(`Questions the coordinator wants answered: ${b.questions.join("; ")}`);
  if (b.outOfScope) parts.push(`Out of scope (do not ask about): ${b.outOfScope}`);
  if (b.constraints.length) parts.push(`Constraints (never ask the expert to break these): ${b.constraints.join("; ")}`);
  return parts.join("\n").slice(0, 3000);
}

/** Requirements tracked for a mission, derived from the brief. */
export function requirementsFromBrief(b) {
  const rows = [];
  for (const [field, kind] of [["outcomes", "outcome"], ["decisions", "decision"], ["blindSpots", "blind_spot"], ["questions", "question"], ["acceptance", "acceptance"]]) {
    for (const text of b[field]) rows.push({ kind, text });
  }
  return rows;
}
