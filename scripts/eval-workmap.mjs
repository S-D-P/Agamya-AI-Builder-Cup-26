// Public-data evaluation of the Work Map builder (live Gemini; ~2 calls per video, a few US cents for 25 videos).
// Data: YouCook2 validation annotations (real YouTube cooking videos, human-annotated temporal steps). Each annotated
// step becomes a timestamped camera event, as Agamya's capture would record it. Two conditions per video:
//   silent    the cook says nothing: every reason must be labelled AI-inferred, every quote the model claims is unsupported
//   narrated  the cook says each step aloud: quotes taken from that speech must verify verbatim
// Metrics (deterministic, no LLM judge): coverage of annotated steps, cited evidence that does not exist, step order,
// quotes claimed vs verified, unclear questions. A failed model call is NOT EVALUATED, never a pass.
//   node scripts/eval-workmap.mjs [videos=25]   → data/eval-workmap.json
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv, ROOT } from "../src/config.mjs";
loadDotEnv();
const { setModelAdapter, vertexAdapter, setInferenceSink } = await import("../src/ai/gemini.mjs");
const { buildWorkMap } = await import("../src/ai/ops/workmap.mjs");

const N = Number(process.argv[2] ?? 25);
const videos = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "public", "youcook2-val.json"), "utf8")).filter((v) => v.segments.length >= 5).slice(0, N);
const adapter = await vertexAdapter();
if (!adapter) { console.error("Gemini not configured; nothing was evaluated."); process.exit(2); }
setModelAdapter(adapter);
const usage = { calls: 0, failed: 0, costUsd: 0 };
setInferenceSink(async (e) => { usage.calls++; if (e.status !== "ok") usage.failed++; usage.costUsd += e.costUsd ?? 0; });

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const rows = [];
for (const v of videos) {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const events = v.segments.map((s, i) => ({ id: `e${i + 1}`, at: mmss(s.start), modality: "CAMERA", text: s.sentence }));
  for (const cond of ["silent", "narrated"]) {
    const speech = cond === "narrated" ? v.segments.map((s) => ({ at: new Date(t0 + s.start * 1000).toISOString(), text: `Now I ${s.sentence}.` })) : [];
    let raw = null;
    const m = await buildWorkMap({ wf: { name: "A home recipe", description: "Cooking, recorded on camera" }, events, speech, dialogue: [], onRaw: (d) => { raw = d; } });
    if (m.source !== "gemini" || !raw) { rows.push({ video: v.id, cond, evaluated: false, error: m.error ?? "no output" }); console.log(`NOT EVALUATED ${v.id} ${cond}`); continue; }
    const ids = new Set(events.map((e) => e.id));
    const rawIds = (raw.steps ?? []).flatMap((s) => s.eventIds ?? []);
    const cited = new Set(m.steps.flatMap((s) => s.eventIds));
    const firsts = m.steps.map((s) => Math.min(...s.eventIds.map((x) => Number(x.slice(1))))).filter(Number.isFinite);
    const inOrder = firsts.slice(1).filter((x, i) => x >= firsts[i]).length;
    const rawQuotes = (raw.steps ?? []).flatMap((s) => [s.reason?.quote, ...(s.guardrails ?? []).map((g) => g.quote)]).filter((q) => q && q.trim());
    const verified = m.steps.flatMap((s) => [s.reason, ...s.guardrails]).filter((x) => x?.status === "EXPERT_STATED").length;
    const row = { video: v.id, cond, evaluated: true, annotatedSteps: events.length, mapSteps: m.steps.length,
      coverage: cited.size / events.length, invalidIdsCited: rawIds.filter((x) => !ids.has(x)).length, rawIdsCited: rawIds.length,
      orderPairs: Math.max(0, firsts.length - 1), orderPairsInOrder: inOrder, quotesClaimed: rawQuotes.length, quotesVerified: verified, unclear: m.unclear.length };
    rows.push(row);
    console.log(`${cond.padEnd(9)} ${v.id} steps ${row.mapSteps}/${row.annotatedSteps} coverage ${(row.coverage * 100).toFixed(0)}% invalid ids ${row.invalidIdsCited} quotes ${row.quotesVerified}/${row.quotesClaimed} unclear ${row.unclear}`);
  }
}

const summarize = (cond) => {
  const r = rows.filter((x) => x.cond === cond && x.evaluated);
  const sum = (k) => r.reduce((n, x) => n + x[k], 0);
  const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return { videos: r.length, notEvaluated: rows.filter((x) => x.cond === cond && !x.evaluated).length,
    meanCoveragePct: r.length ? Math.round((1000 * sum("coverage")) / r.length) / 10 : null,
    invalidEvidencePct: pct(sum("invalidIdsCited"), sum("rawIdsCited")),
    stepOrderPct: pct(sum("orderPairsInOrder"), sum("orderPairs")),
    quotesClaimed: sum("quotesClaimed"), quotesVerified: sum("quotesVerified"), quoteVerifiedPct: pct(sum("quotesVerified"), sum("quotesClaimed")),
    videosWith3PlusUnclear: r.filter((x) => x.unclear >= 3).length };
};
const out = { dataset: "YouCook2 validation annotations (lmms-eval/YouCook2 mirror)", ranAt: new Date().toISOString(), model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  summary: { silent: summarize("silent"), narrated: summarize("narrated") }, usage, rows };
fs.writeFileSync(path.join(ROOT, "data", "eval-workmap.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2), usage);
