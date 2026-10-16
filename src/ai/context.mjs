// Context Budget Manager: the minimum information Gemini needs for each operation.
//
// Principle: CAPTURE NEVER DEGRADES, INFERENCE CONTEXT DOES. Everything is stored (object storage + metadata);
// what is SENT is compiled progressively:
//   L0 raw evidence        frame / audio / document bytes       (stored, referenced, sent only when needed)
//   L1 observation         "tension lowered 6→4 [humidity=28%]" (app event, UI text, transcript or one LOW-res look)
//   L2 semantic event      PROCEDURE_STEP / ROUTINE / DEVIATION  (labels from detectJudgment)
//   L3 judgment candidate  action / outcome / alternatives / choice evidence
//   L4 validated judgment  the expert-approved chain
//   L5 compact knowledge   IF/THEN/BUT IF rule + embedding, retrieved top-k
// Every AI call records a manifest of which levels it received, so cost and context are auditable per call.
import { Resvg } from "@resvg/resvg-js";

// Measured on gemini-2.5-flash (Vertex), Oct 2026: a 960px frame = 1806 tokens at default resolution, 258 at
// MEDIUM, 66 at LOW (text on screen read correctly at all three). Several images in one request bill ~258 each.
// Audio ≈ 25 tokens/second.
export const TOKENS = { imageDefault: 1806, imageMedium: 258, imageLow: 66, audioPerSec: 25, charsPerToken: 4 };

export const POLICIES = {
  compressed: {
    name: "compressed", routineResolution: "MEDIA_RESOLUTION_LOW", momentResolution: "MEDIA_RESOLUTION_MEDIUM",
    // Screens are text-dense: LOW (66 tok) read gauges/scenes reliably but missed small spreadsheet annotations in 1/6
    // runs; screen pixels without UI text therefore start at MEDIUM (258 tok). Camera frames stay at LOW.
    routineResolutionByModality: { SCREEN: "MEDIA_RESOLUTION_MEDIUM" },
    escalateBelowConfidence: 0.7, useUiTextInsteadOfPixels: true, dropRepetitiveFrames: true, detectOn: "break",
    knowledgeTopK: 3, maxEvents: 40, momentFrames: 2, sendAllFrames: false,
  },
  "raw-at-break": {
    name: "raw-at-break", routineResolution: undefined, momentResolution: undefined, escalateBelowConfidence: 0,
    useUiTextInsteadOfPixels: false, dropRepetitiveFrames: false, detectOn: "break", knowledgeTopK: Infinity, maxEvents: Infinity, momentFrames: Infinity, sendAllFrames: true,
  },
  naive: {
    name: "naive", routineResolution: undefined, momentResolution: undefined, escalateBelowConfidence: 0,
    useUiTextInsteadOfPixels: false, dropRepetitiveFrames: false, detectOn: "every", knowledgeTopK: Infinity, maxEvents: Infinity, momentFrames: Infinity, sendAllFrames: true,
  },
};

/**
 * Operation profiles: what each operation may receive under the compressed policy. Profiles are the contract the
 * rest of the system relies on; the manifest proves each call respected it.
 */
export const OPERATION_PROFILES = {
  buildWorkMap: { levels: ["L1 session events (text)", "L2 expert speech + dialogue", "previous map"], pixels: "none" },
  judgeTutorTurn: { levels: ["confirmed map (text)", "last turns"], pixels: "none" },
  understandWorkflow: { levels: ["EXTERNAL_DOCUMENT"], pixels: "none" },
  interpretObservation: { levels: ["L0 frame (LOW, escalate to MEDIUM on low confidence)", "L1 last 4 events"], pixels: "one frame" },
  transcribe: { levels: ["L0 audio segment"], pixels: "none" },
  detectJudgment: { levels: ["L1 bounded event window", "procedure", "L5 top-k knowledge"], pixels: "none" },
  contradictsKnowledge: { levels: ["L1 event window", "L5 other experts' knowledge"], pixels: "none" },
  generateQuestion: { levels: ["L1 events", "L3 candidate", "dialogue", "L0 moment frames (MEDIUM) if pixel-sourced"], pixels: "moment only" },
  extractKnowledge: { levels: ["L1 events", "L3 candidate", "dialogue", "L0 moment frames (MEDIUM) if pixel-sourced"], pixels: "moment only" },
  findBoundary: { levels: ["L3 draft", "dialogue", "procedure"], pixels: "none" },
  detectConflict: { levels: ["procedure (documented)", "observed behaviour", "expert explanation"], pixels: "none" },
  reconcileExperts: { levels: ["two L4 judgments", "situation facts", "procedure"], pixels: "none" },
  generateScenarios: { levels: ["L5 rule"], pixels: "none" },
  tutor: { levels: ["scenario", "L5 rule", "learner history"], pixels: "none" },
  evaluateLearner: { levels: ["scenario", "L5 rule", "learner reasoning"], pixels: "none" },
};

export function manifest(op, extra = {}) {
  return { op, profile: OPERATION_PROFILES[op]?.levels ?? [], ...extra };
}

// ---------------------------------------------------------------- observation planning (adaptive visual sampling)
export function thumbFromSvg(svg) {
  const img = new Resvg(svg, { fitTo: { mode: "width", value: 32 } }).render();
  const px = img.pixels;
  const out = new Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) | 0;
  return out;
}

export function thumbDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / (a.length * 255);
}

/**
 * Decide what one observation needs. Pure function of (observation, policy, sampler state).
 *   use_text       structured text exists (app event, UI text, document, typed answer)
 *   evidence_only  an app event already describes this screen; keep the pixels as evidence, send nothing
 *   transcribe     speech must be heard once
 *   vision         pixels must be interpreted at `resolution`
 *   drop_stable    no change / repetitive motion; keep reference per retention, send nothing
 */
export function planObservation(obs, policy, sampler) {
  const { modality } = obs;
  if (["APP_EVENT", "DOCUMENT", "TEXT"].includes(modality)) return { decision: "use_text", reason: "structured text available", estTokens: est(obs.text) };
  if (modality === "MICROPHONE") return { decision: "transcribe", reason: obs.text ? "transcript supplied" : "speech must be heard once", estTokens: obs.text ? est(obs.text) : Math.ceil((obs.durationSec ?? 5) * TOKENS.audioPerSec) };
  if (policy.useUiTextInsteadOfPixels && obs.uiText !== undefined && sampler?.appEventsPresent) return { decision: "evidence_only", reason: "app event already describes this screen; pixels kept as evidence", estTokens: 0 };
  if (policy.useUiTextInsteadOfPixels && obs.uiText) return { decision: "use_text", reason: "UI text available; screenshot kept as evidence", estTokens: est(obs.uiText) };
  if (!policy.dropRepetitiveFrames) return { decision: "vision", reason: "naive: every frame interpreted", resolution: policy.routineResolution, estTokens: TOKENS.imageDefault };
  if (!sampler?.seen) return { decision: "vision", reason: "first frame establishes the scene", resolution: policy.routineResolutionByModality?.[modality] ?? policy.routineResolution, estTokens: TOKENS.imageLow };
  const diff = obs.diffScore ?? 1;
  if (diff < 0.002) return { decision: "drop_stable", reason: `no visible change (Δ ${(diff * 100).toFixed(2)}%)`, estTokens: 0 };
  if ((obs.cycleDiff ?? 1) < 0.0035 && sampler.droppedSinceVision < 3) return { decision: "drop_stable", reason: `repetitive motion (matches a recent frame, Δ ${((obs.cycleDiff ?? 0) * 100).toFixed(2)}%)`, estTokens: 0 };
  const resolution = policy.routineResolutionByModality?.[modality] ?? policy.routineResolution;
  return { decision: "vision", reason: `visual change (Δ ${(diff * 100).toFixed(1)}%)`, resolution, estTokens: resolution === "MEDIA_RESOLUTION_MEDIUM" ? TOKENS.imageMedium : TOKENS.imageLow };
}

const est = (s) => Math.ceil(String(s ?? "").length / TOKENS.charsPerToken);

export function rawEquivalentTokens(obs) {
  if (obs.modality === "SCREEN" || obs.modality === "CAMERA") return obs.media_asset_id || obs.hasRaw ? TOKENS.imageDefault : 0;
  if (obs.modality === "MICROPHONE") return Math.ceil((obs.durationSec ?? 0) * TOKENS.audioPerSec) || est(obs.text);
  return est(obs.text);
}

/**
 * Bounded event window for detection. Long sessions never send unbounded history: the oldest events beyond
 * `maxEvents` are compacted into one deterministic summary line (counts + latest readings).
 */
export function eventWindow(events, maxEvents) {
  if (!Number.isFinite(maxEvents) || events.length <= maxEvents) return { events, summary: null };
  const older = events.slice(0, events.length - maxEvents);
  const byModality = older.reduce((m, e) => ((m[e.modality] = (m[e.modality] ?? 0) + 1), m), {});
  const summary = `Earlier in this session: ${older.length} observations (${Object.entries(byModality).map(([k, v]) => `${v} ${k}`).join(", ")}); details omitted to bound context.`;
  return { events: events.slice(-maxEvents), summary };
}

// ---------------------------------------------------------------- L4 / L5
export function toRule(j) {
  const v = (f) => (typeof j[f] === "object" && j[f] ? j[f].value : j[f]) ?? "";
  const b = j.boundary ?? {};
  const parts = [`IF ${v("condition") || v("context")}`, `THEN ${v("decision")}`];
  if (v("reason")) parts.push(`BECAUSE ${v("reason")}`);
  if (b.default?.decision) parts.push(`BUT IF ${b.default.when} THEN ${b.default.decision}`);
  if (v("risk")) parts.push(`RISK: ${v("risk")}`);
  return parts.join(" · ");
}
