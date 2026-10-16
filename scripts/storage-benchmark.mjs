// STORAGE + CALL BENCHMARK (offline, deterministic, repeatable; no network, no cost).
// Runs representative simulated sessions (payments console, loom camera, kitchen camera) through the REAL capture
// pipeline (storage, observation planning, jobs) with the scripted test model, and measures on the SAME runs:
//   baseline  = what an unoptimised pipeline would do: store every uploaded object separately, send every captured
//               observation to the model, regenerate every repeated learner answer
//   optimised = what this pipeline actually did: object reuse inside a space, change-based observation planning, Ask cache
// Model TOKENS are not measured here (the scripted model's token counts are fake); token savings come from the live
// context benchmark (data/benchmark.json). Output: data/storage-benchmark.json
import fs from "node:fs";
import path from "node:path";
import { getConfig, ROOT } from "../src/config.mjs";
import { buildServices, buildServer } from "../src/app.mjs";
import { createLogger } from "../src/platform/logger.mjs";
import { fakeModel, user, waitFor } from "../tests/helpers.mjs";

const cfg = getConfig({ NODE_ENV: "test", PGLITE_DIR: "memory", STORAGE_DIR: "memory", DEMO_SEED: "0", PUBLIC_ORIGIN: "http://localhost:3200", ALLOW_SIGNUP: "1", JOB_POLL_MS: "30", SAMPLE_SPACES: "1" });
const fake = fakeModel();
const s = await buildServices(cfg, { log: createLogger({ ...cfg, logLevel: "silent" }), modelAdapter: fake.adapter });
const app = await buildServer(s);
s.jobs.start();
const DONE = ["asking", "validating", "no_judgment", "done"];
const results = [];
let lastSession = null;
try {
  const u = user(app);
  for (const kind of ["work", "living"]) {
    await u.post("/api/samples", { kind });
    await u.acceptPolicies();
    const people = (await u.get("/api/samples/people")).body;
    const runs = kind === "work" ? [["Dana", "Legacy payment operations", "sim:payments-console"], ["Amara", "Hand-loom weaving", "sim:loom-camera"]] : [["Lakshmi", "Amma's ghee", "sim:kitchen-camera"]];
    for (const [expert, wfName, source] of runs) {
      await u.post("/api/samples/switch", { personId: people.find((p) => p.display_name.startsWith(expert)).id });
      await u.acceptPolicies();
      const wf = (await u.get("/api/workflows")).body.find((w) => w.name === wfName);
      // The same task captured twice (e.g. a retried session, or a second capture of an unchanged screen): identical frames.
      const sessions = [];
      for (let rep = 0; rep < 2; rep++) {
        let x = (await u.post("/api/sessions", { workflowId: wf.id, source })).body;
        x = (await u.post(`/api/sessions/${x.id}/consent`, { modalities: ["SCREEN", "CAMERA", "MICROPHONE"], clientTime: Date.now() })).body;
        for (const [action, param] of x.sim.script.steps) { const r = (await u.post(`/api/sessions/${x.id}/sim`, { action, param })).body; if (r.status !== "capturing") break; }
        x = await waitFor(async () => { const r = (await u.get(`/api/sessions/${x.id}`)).body; return DONE.includes(r.status) && !r.processing.pending ? r : null; }, { timeoutMs: 60000 });
        sessions.push(x.id);
        lastSession = x.id;
      }
      const rows = await s.db.system((q) => q("SELECT bytes, storage_key, dedup_of FROM media_assets WHERE session_id = ANY($1::uuid[])", [sessions]));
      const obs = await s.db.system((q) => q("SELECT plan->>'decision' AS decision FROM observations WHERE session_id = ANY($1::uuid[]) AND modality IN ('SCREEN','CAMERA')", [sessions]));
      const uploaded = rows.reduce((n, r) => n + Number(r.bytes), 0);
      const stored = [...new Map(rows.map((r) => [r.storage_key, Number(r.bytes)])).values()].reduce((n, b) => n + b, 0);
      const sentToModel = obs.filter((o) => !["drop_stable", "evidence_only"].includes(o.decision)).length;
      results.push({ workflow: wfName, sessions: 2, uploads: rows.length, baselineStoredBytes: uploaded, optimisedStoredBytes: stored, reusedUploads: rows.filter((r) => r.dedup_of).length,
        visualObservations: obs.length, baselineSentToModel: obs.length, optimisedSentToModel: sentToModel, decisions: Object.fromEntries([...new Set(obs.map((o) => o.decision))].map((d) => [d, obs.filter((o) => o.decision === d).length])) });
    }
  }
  // Ask cache: the same question asked several times over unchanged knowledge (the teacher's own approved knowledge).
  if (lastSession) {
    let st = (await u.get(`/api/sessions/${lastSession}`)).body;
    for (let i = 0; st.status === "asking" && i < 3; i++) {
      await u.post(`/api/sessions/${lastSession}/answer`, { text: st.sim?.script?.answers?.[i] ?? "Because of the colour." });
      st = await waitFor(async () => { const r = (await u.get(`/api/sessions/${lastSession}`)).body; return ["validating", "done", "no_judgment"].includes(r.status) || (r.status === "asking" && r.dialogue.filter((d) => d.answer).length > i) ? r : null; }, { timeoutMs: 60000 });
    }
    if (st.judgmentId) {
      const r = await u.post(`/api/judgments/${st.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
      if (r.status !== 200) console.error("approve failed", r.status, JSON.stringify(r.body).slice(0, 200));
    } else console.error("no judgment to approve; status", st.status);
  }
  const askCalls = () => fake.calls.filter((c) => c.op === "answerFromKnowledge").length;
  const before = askCalls();
  const asks = 5;
  const askLog = [];
  for (let i = 0; i < asks; i++) { const r = await u.post("/api/ask", { question: "What do I do when the value is odd?" }); askLog.push({ status: r.status, source: r.body.source, cached: r.body.cached, grounded: r.body.grounded }); }
  console.error("ask log", JSON.stringify(askLog));
  const askModelCalls = askCalls() - before;
  const total = (k) => results.reduce((n, r) => n + r[k], 0);
  const pct = (a, b) => (a ? Math.round((1 - b / a) * 1000) / 10 : null);
  const out = {
    at: new Date().toISOString(), method: "offline, scripted model, real capture pipeline; baseline and optimised measured on the same runs",
    perWorkflow: results,
    totals: {
      storedBytes: { baseline: total("baselineStoredBytes"), optimised: total("optimisedStoredBytes"), reductionPct: pct(total("baselineStoredBytes"), total("optimisedStoredBytes")) },
      visualObservationsSentToModel: { baseline: total("baselineSentToModel"), optimised: total("optimisedSentToModel"), reductionPct: pct(total("baselineSentToModel"), total("optimisedSentToModel")) },
      askModelCalls: { baseline: asks, optimised: askModelCalls, note: askModelCalls === asks ? "no knowledge visible to this person in the sample: every question answered by rule, nothing to cache" : undefined },
    },
    caveats: [
      "The scenario deliberately repeats each capture once; real-world reuse depends on how often identical bytes recur (re-uploads, retries, identical documents).",
      "Simulated frames are small rendered images; storage ratios on real camera or screen media will differ.",
      "Observation planning savings (frames not sent to the model) come from the change-based sampler; tokens are measured in the live benchmark, not here.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "data", "storage-benchmark.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.totals, null, 2));
} finally {
  await s.jobs.stop(); await app.close(); await s.db.close();
}
