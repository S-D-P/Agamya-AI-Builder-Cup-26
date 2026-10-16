// Deterministic validators applied to model output BEFORE anything is persisted.
// Principle: model confidence is not evidence. A claim keeps its epistemic status only if the evidence it cites
// actually exists (verbatim expert words, real observation ids); otherwise it is downgraded, and the downgrade is
// recorded in `verification` so the UI can show exactly what was changed and why.

export const EPISTEMIC = ["OBSERVED", "EXPERT_STATED", "AI_INFERRED", "INSUFFICIENT_EVIDENCE"];
export const CHAIN_FIELDS = ["context", "observation", "decision", "reason", "condition", "exception", "boundary", "risk", "expectedOutcome"];

// Unicode-aware (Devanagari vowel signs are combining marks, so \p{M} must be kept); NFC so equivalent forms compare equal.
export const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

/** A quote is verified only if it appears verbatim (normalised) in what the expert actually said. */
export function quoteVerified(quote, expertWords) {
  const q = norm(quote);
  return q.length >= 8 && norm(expertWords).includes(q);
}

export function checkQuotes(quotes, expertWords) {
  const kept = [], dropped = [];
  for (const q of quotes ?? []) (quoteVerified(q, expertWords) ? kept : dropped).push(q);
  return { kept, dropped };
}

/**
 * Verify every chain field.
 *  EXPERT_STATED  requires a verbatim quote from the expert's answers
 *  OBSERVED       requires ≥1 cited observation id that exists in this episode
 *  empty value    becomes INSUFFICIENT_EVIDENCE
 * Anything that fails is downgraded to AI_INFERRED.
 */
export function verifyFields(fields, { expertWords, eventIds }) {
  const known = new Set(eventIds);
  const out = {};
  const notes = [];
  for (const f of CHAIN_FIELDS) {
    const x = fields[f] ?? {};
    const value = String(x.value ?? "").trim();
    let status = EPISTEMIC.includes(x.status) ? x.status : "AI_INFERRED";
    const quote = String(x.quote ?? "").trim();
    const ids = (x.eventIds ?? []).filter((id) => known.has(id));
    if (!value) status = "INSUFFICIENT_EVIDENCE";
    else if (status === "EXPERT_STATED" && !quoteVerified(quote, expertWords)) {
      notes.push(`${f}: model said EXPERT_STATED but its quote was not found in the expert's words → AI_INFERRED`);
      status = "AI_INFERRED";
    } else if (status === "OBSERVED" && !ids.length) {
      notes.push(`${f}: model said OBSERVED but cited no valid observation → AI_INFERRED`);
      status = "AI_INFERRED";
    } else if (status === "INSUFFICIENT_EVIDENCE" && value) {
      status = "AI_INFERRED";
    }
    out[f] = { value, status, quote: status === "EXPERT_STATED" ? quote : "", eventIds: status === "OBSERVED" ? ids : [] };
  }
  return { fields: out, notes };
}

/** Token-overlap check used to stop the model attributing a decision to the documented procedure when it is not there. */
export function overlaps(a, b, threshold = 0.34) {
  const w = (s) => new Set(norm(s).split(" ").filter((x) => x.length > 2 && !STOP.has(x)));
  const A = w(a), B = w(b);
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.min(A.size, B.size) >= threshold;
}
const STOP = new Set(["the", "and", "for", "with", "that", "this", "then", "when", "from", "into", "should", "would", "will", "are", "was", "not"]);

/**
 * Documentation separation: the model may only call something "documented" if it is in the documented procedure.
 * Returns the corrected source plus a note when the model's attribution was wrong.
 */
export function verifyDocumentedAttribution(claimSource, claimText, procedure) {
  if (claimSource !== "DOCUMENTED_PROCEDURE") return { source: claimSource, note: null };
  const doc = procedure ? `${procedure.default_decision ?? procedure.defaultDecision ?? ""} ${(procedure.steps ?? []).join(" ")}` : "";
  if (doc && overlaps(claimText, doc)) return { source: "DOCUMENTED_PROCEDURE", note: null };
  return { source: "EXPERT_STATED", note: `model attributed "${String(claimText).slice(0, 80)}" to the documented procedure, but it is not in it → relabelled` };
}

/** Detection contract: a candidate counts as a judgment only with evidence that a CHOICE was made. */
export function verifyCandidate(c, eventIds) {
  const known = new Set(eventIds);
  const reasons = [];
  const evidence = (c.choiceEvidence ?? []).filter((id) => known.has(id));
  if (!c.isJudgment) reasons.push("model classified it as action/outcome, not judgment");
  if (!c.alternatives?.filter((a) => String(a).trim()).length) reasons.push("no alternative the person chose against");
  if (!evidence.length) reasons.push("no observed evidence that a choice was made");
  if (c.judgmentBasis === "none" || c.type === "routine") reasons.push("routine");
  return { valid: reasons.length === 0, reasons, choiceEvidence: evidence };
}
