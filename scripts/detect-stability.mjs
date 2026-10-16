// Judgment-detection stability on the v3 engine (compressed policy, live Gemini): replays demo cases N times up to the
// point where the engine decides whether to ask, and reports agreement with designer labels (SYNTHETIC ground truth).
// Usage: node scripts/detect-stability.mjs [runs] [cases]
import { loadDotEnv, getConfig } from "../src/config.mjs";
loadDotEnv();
const { buildServices } = await import("../src/app.mjs");
const { createLogger } = await import("../src/platform/logger.mjs");
const { DEMO_PASSWORD } = await import("../src/domain/seed.mjs");
const { DEMO_WORKFLOWS } = await import("../src/sim/workflows/index.mjs");
const runs = Number(process.argv[2] || 5);
const only = process.argv[3]?.split(",");
const cfg = getConfig({ ...process.env, PGLITE_DIR: "memory", STORAGE_DIR: "memory", DEMO_SEED: "1", JOB_POLL_MS: "100", JOB_CONCURRENCY: "8" });
const s = await buildServices(cfg, { log: createLogger({ ...cfg, logLevel: "silent" }) });
s.jobs.start();
const wfs = await s.db.system((q) => q("SELECT id, key FROM workflows WHERE source = 'demo'"));
let agree = 0, total = 0;
for (const d of DEMO_WORKFLOWS) for (const c of d.environment.cases) {
  if (c.id === "C4" || (only && !only.includes(c.id))) continue;
  const email = `${d.workflow.experts.find((e) => e.id === c.expertId).name.split(" ")[0].toLowerCase()}@demo.local`;
  const ctx = await s.identity.resolve((await s.identity.login({ email, password: DEMO_PASSWORD() })).token);
  const wfId = wfs.find((w) => `wf-${w.key}` === d.workflow.id).id;
  const outcomes = await Promise.all(Array.from({ length: runs }, async () => {
    const sess = await s.capture.startSession(ctx, { workflowId: wfId, source: d.environment.id, caseRef: c.id });
    await s.capture.grantConsent(ctx, sess.id, { modalities: ["SCREEN", "CAMERA", "MICROPHONE"] });
    for (const [a, p] of c.script.steps) { const v = await s.capture.getSession(ctx, sess.id); if (v.status !== "capturing") break; await s.capture.simAction(ctx, sess.id, a, p); }
    let v = await s.capture.getSession(ctx, sess.id);
    if (v.status === "capturing") { await s.capture.endTask(ctx, sess.id, { wait: true }); v = await s.capture.getSession(ctx, sess.id); }
    return { asked: v.status === "asking", gate: v.gate?.log?.join(" | ") };
  }));
  const ok = outcomes.filter((o) => o.asked === c.groundTruth.judgment).length;
  agree += ok; total += runs;
  console.log(`${c.id} expected ask=${c.groundTruth.judgment}: ${ok}/${runs}${ok < runs ? `  misses: ${outcomes.filter((o) => o.asked !== c.groundTruth.judgment).map((o) => `[${o.gate || "no candidates"}]`).join(" ")}` : ""}`);
}
console.log(`detection agreement with designer labels (SYNTHETIC): ${agree}/${total}`);
await s.jobs.stop(); await s.db.close();
