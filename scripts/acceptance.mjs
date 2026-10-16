// FINAL ACCEPTANCE TEST (v3, authenticated, live Gemini). Every persona signs in for real, accepts policies,
// consents to capture and acts only within its role.
//   1. Admin creates a NEW workflow from a document (camera + microphone + documents) → Gemini learns the domain.
//   2. Expert works at the loom (pixels only), the AI detects the judgment, asks why; the expert answers BY VOICE
//      (Gemini TTS → uploaded audio chunk → async transcription). Adaptive follow-ups until the boundary is stated.
//   3. Expert approves; knowledge is compiled (rule + embedding) and tests are generated asynchronously.
//   4. Learner 1: wrong → Socratic hint → right on the novel case; boundary understood on the counterfactual.
//      Learner 2: overgeneralises on the counterfactual → detected.
//   5. Multi-expert (payments): Dana C3 then Sam C4 → disagreement + hidden variable.
//   6. Analytics: knowledge, transfer by ground-truth source, AI cost per session / per validated judgment.
// Requires a server started with TEST_HOOKS=1 (answer keys for the scripted learners only).
import fs from "node:fs";
import { client } from "./lib/client.mjs";
const BASE = process.argv[2] || "http://localhost:3200";
const PW = process.env.DEMO_PASSWORD || "agamya-demo-2026";
const say = (s = "") => console.log(s);
const fails = [];
const expect = (c, m) => { if (!c) { fails.push(m); say(`   !! ${m}`); } };
const done = (s) => ["asking", "validating", "no_judgment", "done", "failed"].includes(s.status) && !s.processing?.pending;

async function expertRun(api, { workflowId, source, caseRef, answers, voice = false }) {
  let s = await api.post("/api/sessions", { workflowId, source, caseRef });
  const wf = await api.get(`/api/workflows/${workflowId}`);
  const mods = ["SCREEN", "CAMERA", "MICROPHONE"].filter((m) => wf.modalities[m.toLowerCase()]);
  s = await api.post(`/api/sessions/${s.id}/consent`, { modalities: mods, clientTime: Date.now() });
  say(`   consent: ${s.consent.modalities.join(", ")} (policy ${s.consent.policy_version})`);
  for (const [action, param] of s.sim.script.steps) {
    s = await api.post(`/api/sessions/${s.id}/sim`, { action, param });
    if (s.status !== "capturing") break;
  }
  if (s.status === "capturing") s = await api.post(`/api/sessions/${s.id}/end`);
  s = await api.poll(`/api/sessions/${s.id}`, done);
  const kept = s.observations.filter((o) => !o.dropped);
  say(`   observed ${s.observations.length} (${kept.length} in the inference stream); decisions ${JSON.stringify(s.budget.decisions)}`);
  for (const o of kept.slice(0, 6)) say(`     · [${o.modality}/${o.plan?.decision}${o.plan?.resolution ? "@" + o.plan.resolution.replace("MEDIA_RESOLUTION_", "") : ""}] ${o.text.slice(0, 110)}`);
  say(`   gate: ${s.gate?.log?.join(" | ")}`);
  let i = 0;
  while (s.status === "asking" && i < answers.length) {
    const ans = answers[i++];
    say(`   AI [${s.question.intent}]: ${s.question.text}`);
    if (voice) {
      const wav = await api.req("POST", "/api/voice/tts", { text: ans }, { raw: true });
      await api.req("POST", `/api/sessions/${s.id}/media`, wav, { headers: { "content-type": "audio/wav", "x-modality": "MICROPHONE", "x-kind": "audio_chunk", "x-purpose": "answer", "x-captured-at": String(Date.now()), "x-duration-ms": String(Math.round(((wav.length - 44) / 48000) * 1000)) } });
      // A spoken answer is a draft until the speaker confirms (or corrects) the transcript.
      s = await api.poll(`/api/sessions/${s.id}`, (x) => Boolean(x.answerDraft) || (x.lastError && !x.processing?.pending));
      expect(s.answerDraft, `voice answer ${i} produced a draft transcript`);
      if (!s.answerDraft) break;
      say(`   EXPERT (voice → draft transcript, confirmed): ${s.answerDraft.text}`);
      await api.post(`/api/sessions/${s.id}/answer`, { text: s.answerDraft.text, fromDraft: true });
      s = await api.poll(`/api/sessions/${s.id}`, (x) => done(x) && x.dialogue.filter((d) => d.answer).length >= i);
    } else {
      await api.post(`/api/sessions/${s.id}/answer`, { text: ans });
      s = await api.poll(`/api/sessions/${s.id}`, done);
      say(`   EXPERT: ${ans}`);
    }
  }
  if (s.status === "asking") { await api.post(`/api/sessions/${s.id}/stop`); s = await api.poll(`/api/sessions/${s.id}`, done); }
  return s;
}

function show(j) {
  const f = j.content.fields;
  for (const k of ["decision", "reason", "condition", "exception", "risk"]) say(`     ${k.padEnd(10)} [${f[k].status}] ${f[k].value}`);
  const b = j.content.boundary;
  say(`     boundary   ${b.boundaryCondition} [${b.status}]${b.boundaryQuote ? ` quote: "${b.boundaryQuote.slice(0, 70)}"` : ""}`);
  say(`     default    ${b.default.when} → ${b.default.decision} (source ${b.default.source})`);
  say(`     documented ${j.content.documentation.documentedProcedure}`);
  say(`     levels     ${j.levels.badges.join(", ")}; verification notes: ${(j.verification?.notes ?? []).length}`);
  for (const d of j.docConflicts) say(`     doc gap    ${d.gap_type}: ${d.analysis}`);
}

const admin = client(BASE);
say("1. NEW WORKFLOW (admin)");
const me = await admin.login("alex@demo.local", PW);
say(`   signed in as ${me.user.displayName} (${me.roles.join(", ")}) in ${me.org.name}`);
const people = await admin.get("/api/people");
const pid = (name) => people.find((p) => p.display_name === name).id;
const doc = fs.readFileSync(new URL("../public/samples/studio-weaving-guide.md", import.meta.url), "utf8");
let wf = await admin.post("/api/workflows", {
  name: `Studio weaving ${Date.now().toString(36)}`, description: "How our master weaver keeps cotton warps from breaking.", kind: "physical",
  modalities: { camera: true, microphone: true, documents: true }, captureSources: ["sim:loom-camera", "live:camera"],
  documents: [{ title: "Studio Weaving Guide", text: doc }], expertPersonIds: [pid("Amara Okafor")], learnerPersonIds: [pid("Lee Chen"), pid("Jordan Park")],
});
wf = await admin.poll(`/api/workflows/${wf.id}`, (w) => w.status === "active");
say(`   Gemini profile: ${wf.profile.domainSummary}`);
say(`   procedures from the document: ${wf.procedures.map((p) => `"${p.title}"`).join(", ")}`);
expect(wf.procedures.length > 0, "procedures extracted from the document");

say("\n2. EXPERT WORKS (camera) AND EXPLAINS (voice)");
const amara = client(BASE);
await amara.login("amara@demo.local", PW);
const W1 = ["The thread feels dry. When cotton gets that papery feel it snaps if you keep it at full tension, so I back the dial off.", "No, only when the thread is dry, which is basically when the room humidity drops below about 35 percent. On a normal day it stays at 6.", "If it feels soft and springy again I go back to 6."];
let s = await expertRun(amara, { workflowId: wf.id, source: "sim:loom-camera", caseRef: "W1", answers: W1, voice: true });
expect(s.status === "validating", `weaving session should reach validation (got ${s.status})`);
if (s.judgmentId) {
  const j = await amara.get(`/api/judgments/${s.judgmentId}`);
  show(j);
  expect(j.content.fields.decision.status !== "INSUFFICIENT_EVIDENCE", "decision has evidence");
  await amara.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true, expectedVersion: j.version });
  for (const d of j.docConflicts) await amara.post(`/api/doc-conflicts/${d.id}`, { decision: "confirm" });
  const learnerTry = client(BASE);
  await learnerTry.login("lee@demo.local", PW);
  let denied = false;
  try { await learnerTry.get(`/api/sessions/${s.id}`); } catch (e) { denied = e.status === 403; }
  expect(denied, "a learner cannot open the expert's capture session");

  say("\n2b. MISSING KNOWLEDGE DETECTIVE");
  const g = await amara.poll(`/api/judgments/${j.id}/gaps`, (x) => !x.analyzing, { timeoutMs: 120000 });
  say(`   ${g.gaps.length} gap(s): ${g.gaps.map((x) => `${x.basis}/${x.kind}/${x.field}`).join(", ")}`);
  for (const x of g.gaps.slice(0, 4)) say(`     · ${x.missing} | Q: ${x.question} | evidence ${x.evidence.map((e) => e.alias).join(",") || "none"}`);
  const first = g.gaps.find((x) => x.status === "open");
  if (first) {
    await amara.post(`/api/gaps/${first.id}/answer`, { text: "If the yarn is from a new dye lot I always weave a test strip first, because the shade can shift." });
    const withP = await amara.poll(`/api/judgments/${j.id}/gaps`, (x) => x.gaps.find((y) => y.id === first.id)?.proposal, { timeoutMs: 90000 });
    const prop = withP.gaps.find((y) => y.id === first.id).proposal;
    say(`   proposal → ${prop.field}: ${prop.value} (quote verified: ${prop.quoteVerified})`);
    expect(prop.quoteVerified, "gap proposal quotes the expert verbatim");
    const before = (await amara.get(`/api/judgments/${j.id}`)).currentVersion;
    await amara.post(`/api/gaps/${first.id}/decide`, { action: "approve" });
    const after = (await amara.get(`/api/judgments/${j.id}`)).currentVersion;
    expect(after === before + 1, "approving a gap answer creates a new version");
  }

  say("\n2c. STRESS TEST REVIEW (generated cases are drafts until the expert approves them)");
  const rv = await amara.poll(`/api/judgments/${j.id}/scenarios`, (x) => !x.generating && x.scenarios.length, { timeoutMs: 120000 });
  say(`   ${rv.scenarios.map((x) => `${x.kind}:${x.reviewStatus}`).join(", ")}`);
  expect(["apply", "counterfactual", "boundary", "insufficient"].every((k) => rv.scenarios.some((x) => x.kind === k)), "four case types drafted");
  for (const sc of rv.scenarios) await amara.post(`/api/scenarios/${sc.id}/review`, { approve: true });
}
s = await amara.get(`/api/sessions/${s.id}`);
say(`   tokens: ${s.tokens.prompt + s.tokens.output} in ${s.tokens.calls} calls ($${s.tokens.cost.toFixed(4)}); image tokens ${s.tokens.image} vs ${s.tokens.imageIfDefault} if every frame were sent at default resolution`);
say(`   moment evidence: ${s.budget.momentEvidence}`);

say("\n3-4. APPRENTICE");
const lessonsFor = async (api) => api.poll(`/api/workflows/${wf.id}/lessons`, (l) => l.length && l.every((x) => x.scenarios.length >= 2 || x.generationFailed), { timeoutMs: 120000 });
async function attempt(api, scenario, picks) {
  let at = await api.post("/api/attempts", { scenarioId: scenario.id });
  say(`   [${at.kind}] ${at.scenario.title} (ground truth: ${at.scenario.groundTruthSource}): ${at.scenario.narrative}`);
  for (const p of picks) {
    if (at.status === "complete") break;
    at = await api.post(`/api/attempts/${at.id}/decide`, { choice: p.choice, reasoning: p.reasoning, expectedVersion: at.version });
    const d = at.steps.filter((x) => x.type === "decision").at(-1);
    say(`     LEARNER: ${d.choice} → ${d.correct ? "correct" : "incorrect"} (${d.evaluation?.errorType}, condition named: ${d.evaluation?.namedCondition})`);
    const t = at.steps.at(-1);
    if (t.type === "intervention") say(`     AI L${t.level} ${t.technique}: ${t.message}`);
  }
  say(`     RESULT: ${JSON.stringify({ transfer: at.result?.transfer, overgeneralized: at.result?.overgeneralized, boundaryUnderstood: at.result?.boundaryUnderstood })}`);
  return at;
}
const lee = client(BASE);
await lee.login("lee@demo.local", PW);
const lessons = await lessonsFor(lee);
const apply = lessons[0].scenarios.find((x) => x.kind === "apply");
const cf = lessons[0].scenarios.find((x) => x.kind === "counterfactual");
expect(apply && cf, "novel + counterfactual generated");
const key = async (sc) => lee.get(`/api/test/scenarios/${sc.id}/key`);
const kA = await key(apply), kC = await key(cf);
const a1 = await attempt(lee, apply, [{ choice: kC.answerKey, reasoning: "The guide says cotton is always at the standard tension." }, { choice: kA.answerKey, reasoning: "The warp feels dry and the air is dry, so it could snap at full tension." }, { choice: kA.answerKey, reasoning: "dry thread snaps" }]);
expect(a1.result?.transfer === "Successful", "learner 1 transfer on the novel case");
const c1 = await attempt(lee, cf, [{ choice: kC.answerKey, reasoning: "Humidity is normal and the thread feels soft, so the dry-thread exception does not apply." }]);
expect(c1.result?.boundaryUnderstood === true, "learner 1 understands the boundary");
const jordan = client(BASE);
await jordan.login("jordan@demo.local", PW);
await attempt(jordan, apply, [{ choice: kA.answerKey, reasoning: "Lower tension stops breaks." }]);
const c2 = await attempt(jordan, cf, [{ choice: kA.answerKey, reasoning: "Lower tension is always safer for cotton." }, { choice: kC.answerKey, reasoning: "The thread is soft and humidity is normal." }]);
expect(c2.result?.overgeneralized === true, "learner 2 overgeneralization detected");

say("\n5. MULTIPLE EXPERTS (payments)");
const wfs = await admin.get("/api/workflows");
const pay = wfs.find((w) => w.key === "payments");
const dana = client(BASE); await dana.login("dana@demo.local", PW);
const C3 = ["Those FZ-MIG freezes come from the core migration and they release themselves in the nightly batch. If you escalate, Tier 2 just bounces the ticket back the next morning and the supplier gets paid a day late.", "No. Only FZ-MIG. Any other freeze code, especially FZ-LGL (legal) or FZ-FRD (fraud), goes straight to Tier 2 and you never retry those.", "Yes, as long as it's FZ-MIG and the payment can wait until tomorrow morning."];
let p = await expertRun(dana, { workflowId: pay.id, source: "sim:payments-console", caseRef: "C3", answers: C3 });
if (p.judgmentId) { const j = await dana.get(`/api/judgments/${p.judgmentId}`); show(j); await dana.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true }); }
await admin.poll(`/api/workflows/${pay.id}/knowledge`, (k) => k.length > 0, { timeoutMs: 30000 });
await new Promise((r) => setTimeout(r, 4000)); // let compile_knowledge embed the rule
const sam = client(BASE); await sam.login("sam@demo.local", PW);
const C4 = ["It's a same-day value payment. If it waits for the nightly batch it posts tomorrow, the supplier misses the value date and we pay penalty interest. Tier 2 can force-release a migration freeze, so for same-day payments I escalate even when it's FZ-MIG.", "If the value date is tomorrow or later, the nightly batch is fine and I'd just schedule the retry."];
p = await expertRun(sam, { workflowId: pay.id, source: "sim:payments-console", caseRef: "C4", answers: C4 });
if (p.judgmentId) {
  const j = await sam.get(`/api/judgments/${p.judgmentId}`);
  show(j);
  const c = j.conflicts[0];
  say(`   DISAGREEMENT: ${c ? `${c.relation}; hidden variable: ${c.hidden_variable}; status ${c.status}` : "none"}`);
  expect(Boolean(c), "expert disagreement detected");
  await sam.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true });
}

say("\n5b. PIXEL-ONLY SCREEN (analytics: no UI text or app events, the model must read the sheet)");
const an = wfs.find((w) => w.key === "analytics");
const priya = client(BASE); await priya.login("priya@demo.local", PW);
const anCase = (await import("../src/sim/workflows/analytics.mjs")).default.environment.cases;
p = await expertRun(priya, { workflowId: an.id, source: "sim:revenue-sheet", caseRef: "D1", answers: anCase.find((c) => c.id === "D1").script.answers });
expect(Boolean(p.judgmentId), "analytics: judgment captured from pixels alone");
if (p.judgmentId) { const j = await priya.get(`/api/judgments/${p.judgmentId}`); show(j); await priya.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true }); }
p = await expertRun(priya, { workflowId: an.id, source: "sim:revenue-sheet", caseRef: "D2", answers: [] });
expect(!p.judgmentId, "analytics: routine playbook case is not interrupted");

say("\n5c. LIVING KNOWLEDGE: Lakshmi teaches Meera to make ghee (a private sample space, same engine)");
const fam = client(BASE);
await fam.post("/api/samples", { kind: "living" });
let fme = await fam.get("/api/auth/me");
if (fme.policies?.pending?.length) await fam.post("/api/policies/accept", { ids: fme.policies.pending });
fme = await fam.get("/api/auth/me");
expect(fme.org.experience === "living" && fme.user.displayName === "Lakshmi", "sample space opens as the teacher in a living space");
const kwf = (await fam.get("/api/workflows")).find((w) => w.name === "Amma's ghee");
const k1 = (await import("../src/sim/workflows/kitchen.mjs")).default.environment.cases.find((c) => c.id === "K1");
const ks = await expertRun(fam, { workflowId: kwf.id, source: "sim:kitchen-camera", caseRef: "K1", answers: k1.script.answers });
expect(Boolean(ks.judgmentId), "living: the kitchen camera produced a judgment worth asking about");
const famPeople = await fam.get("/api/samples/people");
const as = async (name) => { const p = famPeople.find((x) => x.display_name === name); await fam.post("/api/samples/switch", { personId: p.id }); return p; };
if (ks.judgmentId) {
  const kj = await fam.get(`/api/judgments/${ks.judgmentId}`);
  show(kj);
  const approved = await fam.post(`/api/judgments/${kj.id}/validate`, { decision: "approve", confirmBoundary: true, expectedVersion: kj.version });
  expect(approved.artifact.governance.visibility === "private", "saving is not sharing: approved knowledge starts private");
  const meera = await as("Meera");
  expect((await fam.get(`/api/workflows/${kwf.id}/lessons`)).length === 0, "private knowledge produces no lesson for Meera");
  await as("Lakshmi");
  await fam.post(`/api/knowledge/${approved.artifact.id}/sharing`, { visibility: "named", sharedWith: [meera.id] });
  await as("Meera");
  const kl = await fam.get(`/api/workflows/${kwf.id}/lessons`);
  expect(kl.length === 1 && kl[0].scenarios.length === 4, "once shared, Meera gets an ordinary case, a counterexample, a boundary case and a missing-information case");
  const kApply = kl[0].scenarios.find((x) => x.kind === "apply"), kCf = kl[0].scenarios.find((x) => x.kind === "counterfactual");
  const keyA = (await fam.get(`/api/test/scenarios/${kApply.id}/key`)).answerKey, keyC = (await fam.get(`/api/test/scenarios/${kCf.id}/key`)).answerKey;
  await attempt(fam, kApply, [{ choice: keyA, reasoning: "The specks are light golden and the foam has cleared, so it is done even though the card says 20." }]);
  const mc = await attempt(fam, kCf, [{ choice: keyA, reasoning: "Amma turned it off at about 12 minutes." }, { choice: keyC, reasoning: "The specks are still white and it is crackling loudly, so the water hasn't cooked off yet." }]);
  expect(mc.result?.overgeneralized === true && mc.result?.finalCorrect === true, "Meera's overgeneralization is caught, then corrected after a hint");
  await as("Lakshmi");
  await fam.post(`/api/knowledge/${approved.artifact.id}/withdraw`);
  await as("Meera");
  expect((await fam.get(`/api/workflows/${kwf.id}/lessons`)).length === 0, "withdrawn knowledge leaves Meera's lessons");
}

say("\n6. RESULTS (admin)");
const m = await admin.get("/api/analytics/metrics");
const cost = await admin.get("/api/analytics/cost");
say(`   KNOWLEDGE  ${JSON.stringify(m.knowledge)}`);
say(`   TRANSFER   ${JSON.stringify({ ...m.transfer, byArm: undefined })}`);
say(`   AI COST    ${JSON.stringify({ calls: cost.calls, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, imageTokens: cost.imageTokens, usd: cost.estimatedCostUsd, perSession: cost.costPerSession, perValidatedJudgment: cost.costPerValidatedJudgment })}`);
say(`   RISK       ${JSON.stringify(m.risk.map((r) => [r.area, r.level, r.experts, r.trainedSuccessors]))}`);
say(fails.length ? `\n${fails.length} expectation(s) failed` : "\nAcceptance test: all expectations met");
process.exit(fails.length ? 1 : 0);
