// The interruption gate: decides whether a detected candidate is worth an expert's time. Pure and deterministic,
// so it is unit-testable and identical in production, tests and benchmarks.
import { verifyCandidate } from "./validators.mjs";

export const SALIENCE_MIN = 0.5;
const STRONG = new Set(["deviation", "manual_override", "correction", "reversal", "exception", "threshold", "context_dependent_choice", "escalation"]);

/**
 * @param det        detectJudgment output
 * @param events     events in the window [{id, structured}]
 * @param procedure  documented procedure row (resolution_actions used when app events exist)
 * @param knowledge  aliased approved knowledge [{id, expertPersonId}]
 * @param expertPersonId the expert being captured
 * @returns {{chosen, intent, related, resolutionDiffers, log}}
 */
export function gate({ det, events, procedure, knowledge = [], expertPersonId }) {
  const structured = events.filter((e) => e.structured?.kind === "resolve");
  const resolutionActions = procedure?.resolution_actions ?? procedure?.resolutionActions ?? [];
  // With structured app events, "did they do something different?" is answered deterministically.
  const resolutionDiffers = structured.length && resolutionActions.length ? structured.some((e) => !resolutionActions.includes(e.structured.action)) : det.actionDiffersFromProcedure;
  const ids = events.map((e) => e.id);
  const log = [];
  for (const c of det.candidates) {
    const v = verifyCandidate(c, ids);
    if (c.matchesKnowledgeId && !c.contradictsKnowledgeId) { log.push(`${c.type}: applies known practice ${c.matchesKnowledgeId} → recorded as another example, no question`); continue; }
    const contra = knowledge.find((k) => k.id === c.contradictsKnowledgeId);
    if (contra && contra.expertPersonId !== expertPersonId) return { chosen: { ...c, choiceEvidence: v.choiceEvidence }, intent: "consistency", related: contra, resolutionDiffers: Boolean(resolutionDiffers), log: [...log, `${c.type}: contradicts ${contra.id} (another expert's approved practice) → ask`] };
    if (!v.valid) { log.push(`${c.type}: not a judgment (${v.reasons.join("; ")}) → skip`); continue; }
    if (c.salience < SALIENCE_MIN) { log.push(`${c.type}: salience ${c.salience} → skip`); continue; }
    const strong = STRONG.has(c.type) && c.salience >= 0.75 && c.changesWhatIsDone;
    if (!resolutionDiffers && (structured.length || !strong)) { log.push(`${c.type}: what was done matches the documented procedure → skip`); continue; }
    const deterministicDiff = structured.length && resolutionDiffers && STRONG.has(c.type);
    if (!c.changesWhatIsDone && !deterministicDiff) { log.push(`${c.type}: does not change what is done → skip`); continue; }
    return { chosen: { ...c, choiceEvidence: v.choiceEvidence }, intent: "why", related: null, resolutionDiffers: Boolean(resolutionDiffers), log: [...log, `${c.type}: judgment with evidence (${v.choiceEvidence.join(", ")}), salience ${c.salience} → ask`] };
  }
  return { chosen: null, intent: null, related: null, resolutionDiffers: Boolean(resolutionDiffers), log };
}
