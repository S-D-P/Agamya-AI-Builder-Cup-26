// MARATHI EVALUATION (live Gemini, run sparingly: ~12 model calls, a few US cents).
// Runs data/eval/marathi.json through the REAL operations and deterministic checks, once. A case whose model call
// failed (timeout / 429 / error) is reported as NOT EVALUATED, never as a pass: an error is not evidence of quality.
// The eval set has not been reviewed by a native Marathi speaker yet (see its "provenance" field).
// Usage: node scripts/eval-marathi.mjs        → data/eval/marathi-results.json
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv, ROOT } from "../src/config.mjs";
loadDotEnv();
const { setModelAdapter, vertexAdapter, setInferenceSink, tts } = await import("../src/ai/gemini.mjs");
const { generateQuestion, extractKnowledge } = await import("../src/ai/ops/judgment.mjs");
const { answerFromKnowledge } = await import("../src/ai/ops/detective.mjs");
const { transcribe } = await import("../src/ai/ops/perception.mjs");
const { devanagariShare } = await import("../src/ai/language.mjs");
const { quoteVerified } = await import("../src/ai/validators.mjs");

const set = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "eval", "marathi.json"), "utf8"));
const adapter = await vertexAdapter();
if (!adapter) { console.error("Gemini not configured (no Vertex credentials); nothing was evaluated."); process.exit(2); }
setModelAdapter(adapter);
const usage = { calls: 0, failedCalls: 0, costUsd: 0 };
setInferenceSink(async (e) => { usage.calls++; if (e.status !== "ok") usage.failedCalls++; usage.costUsd += e.costUsd ?? 0; });

const isMr = (s) => devanagariShare(s) >= 0.5;
const noBerry = (s) => !/\bberr(y|ies)\b/i.test(String(s ?? ""));
const results = [];
const record = (id, category, outcome, checks, detail) => { results.push({ id, category, outcome, checks, detail }); console.log(`${outcome.padEnd(14)} ${id}  ${checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join(" · ")}`); };
const verdict = (checks) => (checks.every((c) => c.ok) ? "pass" : "fail");

const wf = { name: "Amma's ghee", kind: "physical", description: "Making ghee from butter at home: the signals to watch instead of the clock.", profile: null };
const procedure = { title: "Ghee from butter (recipe card)", applies_when: "Making ghee from butter", steps: ["Melt 500 g unsalted butter on medium heat.", "Simmer for 20 minutes, stirring now and then.", "Turn off the heat and strain into a dry jar."], default_decision: "Simmer for 20 minutes, then turn off the heat and strain", resolution_actions: [] };
const events = [
  { id: "e1", modality: "CAMERA", text: "Pan on medium flame; butter melted, thick white foam on top. Timer shows 6 min." },
  { id: "e2", modality: "CAMERA", text: "Teacher tilts the pan; the solids at the bottom are light golden; the foam has cleared. Timer shows 11 min." },
  { id: "e3", modality: "CAMERA", text: "Teacher turns the flame off at 11 min, before the 20 minutes on the recipe card." },
];
const candidate = { action: "Turned off the heat at 11 minutes", alternatives: ["Keep simmering until 20 minutes as the card says"], summary: "Stopped early when the solids turned golden", eventIds: ["e2", "e3"] };

// ---------------------------------------------------------------- capture: question + extraction in Marathi
for (const c of set.capture) {
  const q = await generateQuestion({ wf, procedure, candidate, events, intent: "why", language: "mr" });
  if (q.source !== "gemini") { record(c.id, c.category, "not_evaluated", [], { reason: `question: ${q.error ?? "fallback"}` }); continue; }
  const dialogue = [{ intent: "why", question: q.question, answer: c.answer }];
  const k = await extractKnowledge({ wf, procedure, candidate, events, dialogue, language: "mr" });
  if (k.source !== "gemini") { record(c.id, c.category, "not_evaluated", [{ name: "question in Devanagari", ok: isMr(q.question) }], { question: q.question, reason: `extraction: ${k.error ?? "fallback"}` }); continue; }
  const fields = Object.entries(k.fields ?? {}).filter(([, f]) => f?.value);
  const stated = fields.filter(([, f]) => f.status === "EXPERT_STATED");
  // Only EXPERT_STATED quotes must come from the expert's answer; OBSERVED fields quote the observed events.
  const quotes = stated.map(([, f]) => f.quote).filter(Boolean);
  const checks = [
    { name: "question in Devanagari", ok: isMr(q.question) },
    { name: "expert-stated values in Devanagari (not translated)", ok: stated.length > 0 && stated.every(([, f]) => devanagariShare(f.value) >= 0.3) },
    { name: "every expert-stated quote verbatim from the answer", ok: quotes.length > 0 && quotes.every((x) => quoteVerified(x, c.answer)) },
    { name: "no literal 'berry' in any English rendering", ok: fields.every(([, f]) => noBerry(f.valueEn)) && noBerry(k.rule) },
  ];
  if (c.id === "mr-trap") checks.push({ name: "'बेरी' kept in a Marathi value", ok: fields.some(([, f]) => /बेरी/.test(f.value)) });
  record(c.id, c.category, verdict(checks), checks, { question: q.question, fields: Object.fromEntries(fields.map(([n, f]) => [n, { value: f.value, valueEn: f.valueEn, status: f.status, quote: f.quote }])) });
}

// ---------------------------------------------------------------- ask: grounded Marathi answers
const items = [{ judgmentId: "eval", title: set.knowledge.title, expertName: "Lakshmi", text: set.knowledge.text }];
for (const c of set.ask) {
  const r = await answerFromKnowledge({ question: c.question, language: "mr", items });
  if (r.unavailable) { record(c.id, c.category, "not_evaluated", [], { reason: r.error ?? "unavailable" }); continue; }
  const text = r.answer ?? r.clarifyingQuestion ?? "";
  const checks = [{ name: "reply in Devanagari", ok: !text || isMr(text) }];
  if (c.expect === "grounded") checks.push({ name: "grounded with a verified citation", ok: r.grounded && r.citations.length > 0 });
  if (c.expect === "insufficient") checks.push({ name: "says it is not covered (no confident answer)", ok: r.insufficient && !r.grounded });
  if (c.expect === "grounded_or_clarify") checks.push({ name: "grounded or asks to clarify (never invents)", ok: (r.grounded && r.citations.length > 0) || r.needsClarification || r.insufficient });
  if (c.id === "ask-grounded") checks.push({ name: "answer points to the colour, not the time", ok: /रंग|सोनेरी|बेरी|पांढरी/.test(text) });
  record(c.id, c.category, verdict(checks), checks, { answer: text, grounded: r.grounded, insufficient: r.insufficient, needsClarification: r.needsClarification, citations: r.citations, droppedCitations: r.unverifiedCitationsDropped });
}

// ---------------------------------------------------------------- speech round trip
for (const c of set.speech) {
  const wav = await tts(c.text);
  if (!wav) { record(c.id, c.category, "not_evaluated", [], { reason: "TTS unavailable" }); continue; }
  const t = await transcribe({ media: { mimeType: "audio/wav", data: Buffer.from(wav).toString("base64") }, expectedLanguage: "mr" });
  if (t.source !== "gemini") { record(c.id, c.category, "not_evaluated", [], { reason: t.error ?? "fallback" }); continue; }
  const chars = (s) => new Set([...String(s).normalize("NFC")].filter((x) => /[ऀ-ॿ]/.test(x)));
  const a = chars(c.text), b = chars(t.transcript);
  const overlap = [...a].filter((x) => b.has(x)).length / Math.max(1, a.size);
  const checks = [{ name: "transcript in Devanagari", ok: isMr(t.transcript) }, { name: "character overlap ≥ 0.8", ok: overlap >= 0.8 }, { name: "language reported as mr", ok: t.language === "mr" }];
  record(c.id, c.category, verdict(checks), checks, { spoken: c.text, transcript: t.transcript, language: t.language, confidence: t.confidence, overlap: Number(overlap.toFixed(2)), caveat: c.caveat });
}

const summary = { pass: results.filter((r) => r.outcome === "pass").length, fail: results.filter((r) => r.outcome === "fail").length, notEvaluated: results.filter((r) => r.outcome === "not_evaluated").length };
const out = { at: new Date().toISOString(), model: process.env.GEMINI_MODEL || "default", reviewedByNativeSpeaker: false, summary, usage: { ...usage, costUsd: Number(usage.costUsd.toFixed(5)) }, results };
fs.writeFileSync(path.join(ROOT, "data", "eval", "marathi-results.json"), JSON.stringify(out, null, 2));
console.log(`\n${summary.pass} pass · ${summary.fail} fail · ${summary.notEvaluated} not evaluated · ${usage.calls} model calls (${usage.failedCalls} failed) · $${usage.costUsd.toFixed(4)}`);
