// TOKEN COMPRESSION BENCHMARK on the v3 engine (live Gemini, in-memory PostgreSQL + storage).
// Same scripted expert sessions (3 demo workflows, judgment + routine cases), same operations and prompts; only the
// context policy differs:
//   naive         every frame at default resolution, UI text ignored, detection after EVERY observation with all frames
//   raw-at-break  every frame at default resolution, detection only at the natural break
//   compressed    the Context Budget Manager (text when available, LOW-res vision on change, repetition dropped,
//                 MEDIUM-res moment frames, top-k knowledge, bounded windows)
// Ground truth for "should the AI ask?" is designer-labelled on scripted cases → SYNTHETIC. Question quality is
// Gemini-as-judge → MODEL_DERIVED. Results → data/benchmark.json (imported into benchmark_runs on next server start).
// Usage: node scripts/benchmark.mjs [--pipelines naive,raw-at-break,compressed] [--cases C1,W1]
import fs from "node:fs";
import path from "node:path";
import { loadDotEnv, getConfig, ROOT } from "../src/config.mjs";
loadDotEnv();
const { buildServices } = await import("../src/app.mjs");
const { createLogger } = await import("../src/platform/logger.mjs");
const { withAiContext, MODEL } = await import("../src/ai/gemini.mjs");
const { judgeQuestion } = await import("../src/ai/ops/teaching.mjs");
const { DEMO_WORKFLOWS } = await import("../src/sim/workflows/index.mjs");
const { DEMO_PASSWORD } = await import("../src/domain/seed.mjs");

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1].split(",") : null; };
const PIPELINES = arg("--pipelines") ?? ["naive", "raw-at-break", "compressed"];
const SECONDS_PER_ACTION = 20; // declared assumption for tokens/minute
const CASES = DEMO_WORKFLOWS.flatMap((d) => d.environment.cases.map((c) => ({ d, c }))).filter(({ c }) => c.id !== "C4" && (!arg("--cases") || arg("--cases").includes(c.id)));

async function runPipeline(pipeline) {
  const cfg = getConfig({ ...process.env, NODE_ENV: "development", PGLITE_DIR: "memory", STORAGE_DIR: "memory", DEMO_SEED: "1", JOB_POLL_MS: "100" });
  cfg.contextPolicy = pipeline;
  cfg.pipeline = pipeline;
  const s = await buildServices(cfg, { log: createLogger({ ...cfg, logLevel: "silent" }) });
  s.jobs.start();
  const loginCtx = async (email) => {
    const r = await s.identity.login({ email, password: DEMO_PASSWORD() });
    return s.identity.resolve(r.token);
  };
  const wfs = await s.db.system((q) => q("SELECT id, key FROM workflows WHERE source = 'demo'"));
  const rows = await Promise.all(CASES.map(async ({ d, c }) => {
    try {
      const ctx = { ...(await loginCtx(`${d.workflow.experts.find((e) => e.id === c.expertId).name.split(" ")[0].toLowerCase()}@demo.local`)), requestId: `bench-${pipeline}-${c.id}` };
      const wfId = wfs.find((w) => `wf-${w.key}` === d.workflow.id).id;
      const sess = await withAiContext({ pipeline }, () => s.capture.startSession(ctx, { workflowId: wfId, source: d.environment.id, caseRef: c.id }));
      await s.capture.grantConsent(ctx, sess.id, { modalities: ["SCREEN", "CAMERA", "MICROPHONE"], clientTime: Date.now() });
      for (const [a, p] of c.script.steps) {
        const v = await s.capture.getSession(ctx, sess.id);
        if (v.status !== "capturing") break;
        await s.capture.simAction(ctx, sess.id, a, p);
        if (pipeline === "naive") { // naive = continuous: re-run detection over everything after every observation
          const [w] = await s.db.tenant(ctx, (q) => q("SELECT * FROM workflows WHERE id = $1", [wfId]));
          const obs = await s.db.tenant(ctx, (q) => q("SELECT seq, modality, text, media_asset_id FROM observations WHERE session_id = $1 AND dropped = false ORDER BY seq", [sess.id]));
          const frames = [];
          for (const o of obs.filter((x) => x.media_asset_id)) { const [m] = await s.db.tenant(ctx, (q) => q("SELECT storage_key, mime_type FROM media_assets WHERE id = $1", [o.media_asset_id])); const b = await s.storage.get(m.storage_key); if (b) frames.push({ mimeType: m.mime_type, data: b.toString("base64") }); }
          const { detectJudgment } = await import("../src/ai/ops/judgment.mjs");
          await withAiContext({ orgId: ctx.orgId, sessionId: sess.id, pipeline }, () => detectJudgment({ wf: w, procedure: null, situation: "", events: obs.map((o) => ({ id: `e${o.seq}`, modality: o.modality, text: o.text })), knowledge: [], media: frames }));
        }
      }
      let v = await s.capture.getSession(ctx, sess.id);
      if (v.status === "capturing") { await s.capture.endTask(ctx, sess.id, { wait: true }); v = await s.capture.getSession(ctx, sess.id); }
      const asked = v.status === "asking";
      const firstQuestion = v.question?.text ?? null;
      const momentSummary = v.candidate?.summary ?? "";
      let i = 0;
      while (v.status === "asking" && i < c.script.answers.length) { await s.capture.answer(ctx, sess.id, { text: c.script.answers[i++], wait: true }); v = await s.capture.getSession(ctx, sess.id); }
      if (v.status === "asking") { await s.capture.stopQuestions(ctx, sess.id, { wait: true }); v = await s.capture.getSession(ctx, sess.id); }
      const j = v.judgmentId ? await s.knowledge.detail({ ...ctx, roles: [...ctx.roles, "REVIEWER"] }, v.judgmentId) : null;
      const [t] = await s.db.system((q) => q(`SELECT count(*)::int AS calls, COALESCE(sum(prompt_tokens + output_tokens + thought_tokens),0)::int AS tokens, COALESCE(sum((tokens_by_modality->>'IMAGE')::int),0)::int AS image,
                                              COALESCE(sum(cost_usd),0)::float AS cost FROM ai_inferences WHERE session_id = $1 AND status = 'ok'`, [sess.id]));
      const q = firstQuestion ? await withAiContext({ pipeline: "judge" }, () => judgeQuestion({ question: firstQuestion, momentSummary })) : null;
      return { pipeline, caseId: c.id, workflow: d.workflow.name, expectedJudgment: c.groundTruth.judgment, asked, tokens: t.tokens, imageTokens: t.image, costUsd: t.cost, calls: t.calls,
        minutes: (c.script.steps.length * SECONDS_PER_ACTION) / 60, fieldsExpertStated: j ? Object.values(j.content.fields).filter((f) => f.status === "EXPERT_STATED").length : 0,
        fieldsWithEvidence: j ? Object.values(j.content.fields).filter((f) => ["EXPERT_STATED", "OBSERVED"].includes(f.status)).length : 0,
        boundaryConfirmed: j?.content.boundary.status === "confirmed", firstQuestion, questionQuality: q ? q.specific + q.nonLeading + q.targetsTacit + q.natural : null };
    } catch (err) { return { pipeline, caseId: c.id, error: err.message }; }
  }));
  await s.jobs.stop();
  await s.db.close();
  return rows;
}

const rows = [];
for (const p of PIPELINES) {
  console.log(`\n=== ${p} ===`);
  for (const r of await runPipeline(p)) {
    rows.push(r);
    console.log(r.error ? `${r.caseId} ERROR ${r.error}` : `${r.caseId.padEnd(3)} asked=${String(r.asked).padEnd(5)} expected=${String(r.expectedJudgment).padEnd(5)} tokens=${String(r.tokens).padStart(7)} img=${String(r.imageTokens).padStart(6)} calls=${String(r.calls).padStart(2)} $${r.costUsd.toFixed(4)} evidenced=${r.fieldsWithEvidence} stated=${r.fieldsExpertStated} boundary=${r.boundaryConfirmed} q=${r.questionQuality ?? "-"}`);
  }
}
const summary = PIPELINES.map((p) => {
  const rs = rows.filter((r) => r.pipeline === p && !r.error);
  const jud = rs.filter((r) => r.expectedJudgment), routine = rs.filter((r) => !r.expectedJudgment), q = rs.filter((r) => r.questionQuality != null);
  const avg = (k, xs = rs) => xs.reduce((n, r) => n + r[k], 0) / (xs.length || 1);
  return { pipeline: p, sessions: rs.length, errors: rows.filter((r) => r.pipeline === p && r.error).length,
    tokensPerSession: Math.round(avg("tokens")), imageTokensPerSession: Math.round(avg("imageTokens")), tokensPerMinute: Math.round(rs.reduce((n, r) => n + r.tokens, 0) / (rs.reduce((n, r) => n + r.minutes, 0) || 1)),
    costPerSession: avg("costUsd"), callsPerSession: Math.round(avg("calls") * 10) / 10,
    judgmentRecall: `${jud.filter((r) => r.asked).length}/${jud.length}`, falseAlarms: `${routine.filter((r) => r.asked).length}/${routine.length}`,
    fieldsWithEvidence: Math.round(avg("fieldsWithEvidence", jud) * 10) / 10, fieldsExpertStated: Math.round(avg("fieldsExpertStated", jud) * 10) / 10,
    boundariesConfirmed: `${jud.filter((r) => r.boundaryConfirmed).length}/${jud.length}`, questionQuality: q.length ? Math.round(avg("questionQuality", q) * 10) / 10 : null };
});
const base = summary.find((x) => x.pipeline === "naive"), comp = summary.find((x) => x.pipeline === "compressed");
const headline = base && comp ? `Compressed used ${Math.round((1 - comp.tokensPerSession / base.tokensPerSession) * 100)}% fewer tokens/session than naive (${comp.tokensPerSession.toLocaleString()} vs ${base.tokensPerSession.toLocaleString()}); image tokens ${comp.imageTokensPerSession} vs ${base.imageTokensPerSession}; judgment recall ${comp.judgmentRecall} vs ${base.judgmentRecall}; false alarms ${comp.falseAlarms} vs ${base.falseAlarms}. Single run on scripted cases; expect run-to-run variation.` : "";
console.log("\nSUMMARY"); console.table(summary); console.log(headline);
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "data", "benchmark.json"), JSON.stringify({ at: new Date().toISOString(), model: MODEL(), engine: "v3", secondsPerAction: SECONDS_PER_ACTION, groundTruthSource: "SYNTHETIC", questionQualitySource: "MODEL_DERIVED", summary, rows, headline }, null, 2));
console.log("saved data/benchmark.json");
