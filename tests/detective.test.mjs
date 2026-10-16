// Missing Knowledge Detective, Judgment Stress Test, Knowledge Loss Radar, Ask (grounded, multilingual) and the language
// layer. Offline with the scripted fake model; real HTTP stack and real PostgreSQL (PGlite).
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor, PNG, WAV } from "./helpers.mjs";

const DOC = "STANDARD PROCEDURE\n1. Check the value.\n2. Do the documented thing.\nDefault: Do the documented thing.";
const ESCALATE = "__ask_expert__";

async function workspace(h, email) {
  const a = user(h.app);
  const me = await a.signup(email, `Org ${email}`);
  const wf = (await a.post("/api/workflows", { name: "Flow", kind: "software", modalities: { screen: true, microphone: true, documents: true }, captureSources: ["live:screen"], documents: [{ title: "SOP", text: DOC }] })).body;
  await waitFor(async () => (await a.get(`/api/workflows/${wf.id}`)).body.status === "active");
  const inv = await a.post("/api/admin/invitations", { email: `learner.${email}`, roles: ["LEARNER"] });
  const learner = user(h.app);
  await learner.post("/api/auth/accept-invite", { token: inv.body.inviteUrl.split("/").pop(), displayName: "Learner", password: "correct-horse-battery" });
  await learner.acceptPolicies();
  return { a, me, wf, learner };
}

async function captureToValidation(a, wfId, { language } = {}) {
  let s = (await a.post("/api/sessions", { workflowId: wfId, source: "live:screen", ...(language ? { language } : {}) })).body;
  s = (await a.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() })).body;
  await a.call("POST", `/api/sessions/${s.id}/media`, PNG(41), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
  await a.post(`/api/sessions/${s.id}/end`);
  s = await waitFor(async () => { const r = (await a.get(`/api/sessions/${s.id}`)).body; return r.status === "asking" ? r : null; }, { timeoutMs: 20000 });
  await a.post(`/api/sessions/${s.id}/answer`, { text: "Because the value was odd, only when it is odd." });
  return waitFor(async () => { const r = (await a.get(`/api/sessions/${s.id}`)).body; return r.status === "validating" ? r : null; }, { timeoutMs: 20000 });
}
const gapsOf = (a, judgmentId) => waitFor(async () => { const r = (await a.get(`/api/judgments/${judgmentId}/gaps`)).body; return !r.analyzing && r.gaps?.length ? r : null; }, { timeoutMs: 20000 });

test("Missing Knowledge Detective: evidence-linked gaps, targeted questions, approval, versioned update, re-evaluation", { timeout: 180000 }, async (t) => {
  const h = await harness();
  try {
    const { a, wf, learner } = await workspace(h, "detective@t.test");
    const s = await captureToValidation(a, wf.id);
    let gaps;

    await t.test("gaps are detected after capture, each with what is missing, why it matters, evidence and a specific question", async () => {
      gaps = (await gapsOf(a, s.judgmentId)).gaps;
      const kinds = gaps.map((g) => `${g.basis}:${g.kind}:${g.field}`);
      assert.ok(kinds.includes("RULE:exception:boundary") || kinds.some((k) => k.startsWith("RULE:")), JSON.stringify(kinds));
      const ai = gaps.find((g) => g.basis === "AI_INFERRED");
      assert.ok(ai, "the AI gap with real evidence is kept");
      assert.equal(ai.evidence.length, 1, "evidence links resolve to the captured observation");
      assert.ok(!gaps.some((g) => g.missing === "Uncited claim"), "an AI gap citing non-existent evidence is dropped");
      for (const g of gaps) { assert.ok(g.missing && g.whyItMatters && g.question.length > 12); assert.doesNotMatch(g.question, /^can you explain more\??$/i); assert.equal(g.status, "open"); }
    });

    await t.test("re-running detection never duplicates gaps (idempotent)", async () => {
      await a.post(`/api/judgments/${s.judgmentId}/gaps/reanalyze`);
      await new Promise((r) => setTimeout(r, 600));
      const again = await gapsOf(a, s.judgmentId);
      assert.equal(again.gaps.length, gaps.length);
    });

    await t.test("only the contributor answers or decides; others are refused by the server", async () => {
      const g = gaps.find((x) => x.basis === "AI_INFERRED");
      const r = await learner.post(`/api/gaps/${g.id}/answer`, { text: "I would guess something." });
      assert.ok([403, 404].includes(r.status));
      assert.ok([403, 404].includes((await learner.post(`/api/gaps/${g.id}/decide`, { action: "not_applicable" })).status));
    });

    await t.test("answer → proposal (quote verified) → approval → new version with expert-stated field → gap resolved", async () => {
      const g = gaps.find((x) => x.basis === "AI_INFERRED");
      const before = (await a.get(`/api/judgments/${s.judgmentId}`)).body;
      assert.equal((await a.post(`/api/gaps/${g.id}/answer`, { text: "I always check the value first. Then I decide." })).status, 200);
      const withProposal = await waitFor(async () => (await a.get(`/api/judgments/${s.judgmentId}/gaps`)).body.gaps.find((x) => x.id === g.id && x.proposal), { timeoutMs: 15000 });
      assert.equal(withProposal.status, "answered");
      assert.equal(withProposal.proposal.quoteVerified, true);
      assert.equal(withProposal.proposal.quote, "I always check the value first");
      const decided = await a.post(`/api/gaps/${g.id}/decide`, { action: "approve" });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      const after = (await a.get(`/api/judgments/${s.judgmentId}`)).body;
      assert.equal(after.currentVersion, before.currentVersion + 1, "a new version, not an overwrite");
      assert.equal(after.content.fields.context.status, "EXPERT_STATED");
      assert.equal(after.content.fields.context.quote, "I always check the value first");
      assert.ok(after.versions.some((v) => v.notes.some((n) => /missing knowledge filled/.test(n))));
      const gNow = decided.body.gaps.find((x) => x.id === g.id);
      assert.equal(gNow.status, "resolved");
      assert.equal(gNow.appliedVersion, after.currentVersion);
    });

    await t.test("an expert can leave a gap unresolved, defer it, or mark it not applicable, without inventing an answer", async () => {
      const open = (await a.get(`/api/judgments/${s.judgmentId}/gaps`)).body.gaps.filter((x) => x.status === "open");
      assert.ok(open.length >= 1);
      const r1 = await a.post(`/api/gaps/${open[0].id}/decide`, { action: "accept_unresolved", note: "Genuinely varies; I don't know a rule." });
      assert.equal(r1.body.gaps.find((x) => x.id === open[0].id).status, "accepted_unresolved");
      if (open[1]) assert.equal((await a.post(`/api/gaps/${open[1].id}/decide`, { action: "defer" })).body.gaps.find((x) => x.id === open[1].id).status, "deferred");
      const audit = await h.s.db.system((q) => q("SELECT action FROM audit_events WHERE action LIKE 'knowledge.gap_%'"));
      assert.ok(audit.some((x) => x.action === "knowledge.gap_accept_unresolved"));
    });

    await t.test("after approval, filling a gap creates a new KNOWLEDGE version too", async () => {
      await a.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
      const reopenable = (await a.get(`/api/judgments/${s.judgmentId}/gaps`)).body.gaps.find((x) => x.status === "accepted_unresolved");
      await a.post(`/api/gaps/${reopenable.id}/decide`, { action: "reopen" });
      await a.post(`/api/gaps/${reopenable.id}/answer`, { text: "I always check the value first, every time." });
      await waitFor(async () => (await a.get(`/api/judgments/${s.judgmentId}/gaps`)).body.gaps.find((x) => x.id === reopenable.id && x.proposal), { timeoutMs: 15000 });
      await a.post(`/api/gaps/${reopenable.id}/decide`, { action: "approve" });
      const [art] = await h.s.db.system((q) => q("SELECT current_version FROM knowledge_artifacts WHERE judgment_id = $1", [s.judgmentId]));
      assert.ok(art.current_version >= 2);
    });
  } finally {
    await h.close();
  }
});

test("Judgment Stress Test: approved criteria only, four case types, credit for escalating when evidence is missing", { timeout: 180000 }, async (t) => {
  const h = await harness();
  try {
    const { a, wf, learner } = await workspace(h, "stress@t.test");
    const s = await captureToValidation(a, wf.id);
    await a.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
    const review = await waitFor(async () => { const r = (await a.get(`/api/judgments/${s.judgmentId}/scenarios`)).body; return r.scenarios?.length === 4 ? r : null; }, { timeoutMs: 20000 });
    const byKind = Object.fromEntries(review.scenarios.map((x) => [x.kind, x]));

    await t.test("generation yields ordinary, boundary, counterexample and insufficient-evidence drafts with decision criteria", async () => {
      assert.deepEqual(Object.keys(byKind).sort(), ["apply", "boundary", "counterfactual", "insufficient"]);
      assert.equal(byKind.insufficient.answerKey, ESCALATE);
      assert.ok(byKind.apply.criteria.length >= 1);
      assert.ok(review.scenarios.every((x) => x.reviewStatus === "draft" && x.groundTruthSource === "MODEL_DERIVED"));
      assert.equal((await learner.get(`/api/workflows/${wf.id}/lessons`)).body[0].scenarios.length, 0, "nothing to take until the expert approves");
    });

    await t.test("the expert approves (and may edit criteria); approved tests count as expert-validated ground truth", async () => {
      const r = await a.post(`/api/scenarios/${byKind.apply.id}/review`, { approve: true, criteria: ["Checks whether the value is odd", "Names why the documented step is wrong here"] });
      assert.equal(r.body.groundTruthSource, "EXPERT");
      for (const k of ["boundary", "counterfactual", "insufficient"]) await a.post(`/api/scenarios/${byKind[k].id}/review`, { approve: true });
      assert.equal((await learner.get(`/api/workflows/${wf.id}/lessons`)).body[0].scenarios.length, 4);
    });

    await t.test("escalating on the insufficient-evidence case is correct and earns 'demonstrated in simulation'", async () => {
      const at = (await learner.post("/api/attempts", { scenarioId: byKind.insufficient.id })).body;
      assert.equal(at.scenario.escalateOption, ESCALATE);
      assert.equal(at.criteria, undefined, "criteria are not revealed before the attempt is complete");
      const done = (await learner.post(`/api/attempts/${at.id}/decide`, { choice: ESCALATE, reasoning: "The value cannot be read, so I would ask." })).body;
      assert.equal(done.status, "complete");
      assert.equal(done.result.escalatedAppropriately, true);
      assert.equal(done.result.status, "demonstrated_in_simulation");
      assert.ok(done.support, "an evidence-grounded explanation is shown after the attempt");
    });

    await t.test("acting confidently without the deciding information is flagged as false confidence", async () => {
      const other = await (async () => { const inv = await a.post("/api/admin/invitations", { email: "l2.stress@t.test", roles: ["LEARNER"] }); const u = user(h.app); await u.post("/api/auth/accept-invite", { token: inv.body.inviteUrl.split("/").pop(), displayName: "L2", password: "correct-horse-battery" }); await u.acceptPolicies(); return u; })();
      const at = (await other.post("/api/attempts", { scenarioId: byKind.insufficient.id })).body;
      const r = (await other.post(`/api/attempts/${at.id}/decide`, { choice: "A", reasoning: "I'd just do the usual." })).body;
      assert.equal(r.status, "reconsider");
      assert.equal(r.steps.find((x) => x.type === "decision").evaluation.errorType, "false_confidence");
    });

    await t.test("stopping to ask when the facts were enough is 'unnecessary escalation', not overgeneralization", async () => {
      const at = (await learner.post("/api/attempts", { scenarioId: byKind.apply.id })).body;
      const r = (await learner.post(`/api/attempts/${at.id}/decide`, { choice: ESCALATE, reasoning: "Not sure." })).body;
      assert.equal(r.steps.find((x) => x.type === "decision").evaluation.errorType, "unnecessary_escalation");
      const fin = (await learner.post(`/api/attempts/${at.id}/decide`, { choice: "A", reasoning: "The value is odd, so the documented step does not apply." })).body;
      assert.equal(fin.result.status, "needs_further_practice", "recovering after a hint is not the same as knowing");
      assert.ok(Array.isArray(fin.criteria) && fin.criteria.length === 2);
    });
  } finally {
    await h.close();
  }
});

test("Knowledge Loss Radar: explainable, evidence-backed statuses that change with real records", { timeout: 180000 }, async (t) => {
  const h = await harness();
  try {
    const { a, wf, learner } = await workspace(h, "radar@t.test");
    const row = async () => (await a.get("/api/radar")).body.workflows.find((w) => w.workflow.id === wf.id);

    await t.test("with nothing captured the status is 'insufficient evidence', not safe or unsafe", async () => {
      assert.equal((await row()).status, "insufficient_evidence");
      assert.equal((await learner.get("/api/radar")).status, 403, "the radar is a manager view");
    });

    await t.test("after capture: awaiting approval; after approval with one holder and no trained learner: at risk", async () => {
      const s = await captureToValidation(a, wf.id);
      let r = await row();
      assert.equal(r.status, "needs_attention");
      assert.ok(r.findings.some((f) => f.key === "awaiting_approval" && f.action.type === "request_approval"));
      await a.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
      await gapsOf(a, s.judgmentId);
      r = await row();
      assert.equal(r.status, "at_risk");
      const single = r.findings.find((f) => f.key === "single_holder");
      assert.ok(single && single.records.length && single.action.type === "plan_transfer");
      assert.ok(r.findings.find((f) => f.key === "open_gaps")?.records.every((x) => x.detail));
    });
  } finally {
    await h.close();
  }
});

test("Ask + language layer: Marathi in, Marathi out, grounded or honestly insufficient; spoken answers are checked before they count", { timeout: 180000 }, async (t) => {
  const h = await harness();
  try {
    const { a, wf, learner } = await workspace(h, "lang@t.test");

    await t.test("a Marathi session asks in Marathi (the language instruction reaches the model) and records answer language", async () => {
      await a.post("/api/me/language", { language: "mr" });
      const calls = h.fake.calls.length;
      const s = await captureToValidation(a, wf.id, { language: "mr" });
      assert.equal(s.language, "mr");
      const q = h.fake.calls.slice(calls).find((c) => c.op === "generateQuestion");
      assert.match(q.prompt, /Marathi \(मराठी/);
      assert.equal(s.dialogue[0].question_language, "mr");
      assert.equal(s.dialogue[0].answer_language, "mr");
      await a.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
      assert.equal((await a.get("/api/auth/me")).body.user.language, "mr");
    });

    await t.test("a learner's Marathi question gets a Marathi answer with a verified citation", async () => {
      const r = (await learner.post("/api/ask", { question: "मूल्य विषम असेल तर काय करायचं?" })).body;
      assert.equal(r.language, "mr");
      assert.equal(r.grounded, true);
      assert.ok(r.citations.length && r.citations[0].quote === "only when it is odd");
      assert.match(r.answer, /[ऀ-ॿ]/);
    });

    await t.test("when the knowledge does not cover it, the answer says so, in Marathi", async () => {
      const r = (await learner.post("/api/ask", { question: "उद्याचे हवामान कसे असेल?" })).body;
      assert.equal(r.insufficient, true);
      assert.equal(r.grounded, false);
    });

    await t.test("a confident answer whose citations do not verify is withheld, never shown as fact", async () => {
      const r = (await learner.post("/api/ask", { question: "Please invent a rule for me" })).body;
      assert.equal(r.grounded, false);
      assert.equal(r.withheldUngrounded, true);
      assert.doesNotMatch(r.answer, /Confident but made up/);
    });

    await t.test("private knowledge is never an answer source for someone it is not shared with", async () => {
      const s2 = await captureToValidation(a, wf.id);
      await a.post(`/api/judgments/${s2.judgmentId}/validate`, { decision: "approve", confirmBoundary: true, visibility: "private" });
      const calls = h.fake.calls.length;
      await learner.post("/api/ask", { question: "What do I do when the value is odd?" });
      const call = h.fake.calls.slice(calls).find((c) => c.op === "answerFromKnowledge");
      const items = (call.prompt.match(/\[k\d+\]/g) ?? []).length;
      assert.equal(items, 1, "only the shared item reaches the model");
    });

    await t.test("a spoken answer becomes a draft the expert checks; corrections keep the machine transcript", async () => {
      let s = (await a.post("/api/sessions", { workflowId: wf.id, source: "live:screen", language: "mr" })).body;
      s = (await a.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() })).body;
      await a.call("POST", `/api/sessions/${s.id}/media`, PNG(77), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
      await a.post(`/api/sessions/${s.id}/end`);
      await waitFor(async () => (await a.get(`/api/sessions/${s.id}`)).body.status === "asking", { timeoutMs: 20000 });
      await a.call("POST", `/api/sessions/${s.id}/media`, WAV(5), { "content-type": "audio/wav", "x-modality": "MICROPHONE", "x-kind": "audio_chunk", "x-purpose": "answer", "x-captured-at": String(Date.now()), "x-duration-ms": "2000" });
      const withDraft = await waitFor(async () => { const r = (await a.get(`/api/sessions/${s.id}`)).body; return r.answerDraft ? r : null; }, { timeoutMs: 15000 });
      assert.equal(withDraft.status, "asking", "nothing is recorded until the speaker confirms");
      assert.equal((await learner.get(`/api/sessions/${s.id}`)).status, 403);
      await a.post(`/api/sessions/${s.id}/answer`, { text: "Because the value was odd, only when it is odd (corrected).", fromDraft: true });
      const after = await waitFor(async () => { const r = (await a.get(`/api/sessions/${s.id}`)).body; return r.dialogue[0].answer ? r : null; }, { timeoutMs: 15000 });
      assert.equal(after.dialogue[0].answer_source, "voice_corrected");
      assert.equal(after.dialogue[0].answer_original, withDraft.answerDraft.text);
    });
  } finally {
    await h.close();
  }
});

test("a gap answer that would overwrite an expert-stated field is flagged, never silent", { timeout: 120000 }, async () => {
  const h = await harness();
  try {
    const { a, wf } = await workspace(h, "overwrite@t.test");
    const s = await captureToValidation(a, wf.id);
    h.fake.overrides.integrateGapAnswer = () => ({ field: "reason", value: "Something unrelated about dye lots", valueEn: "", quote: "Always weave a test strip", resolves: true, explanation: "x" });
    const g = (await gapsOf(a, s.judgmentId)).gaps.find((x) => x.status === "open");
    await a.post(`/api/gaps/${g.id}/answer`, { text: "Always weave a test strip first if the yarn is from a new dye lot." });
    const p = await waitFor(async () => (await a.get(`/api/judgments/${s.judgmentId}/gaps`)).body.gaps.find((x) => x.id === g.id && x.proposal)?.proposal, { timeoutMs: 15000 });
    assert.equal(p.replacesExpertStated, true, "the reason was expert-stated; replacing it is flagged for the expert");
    assert.equal(p.before.status, "EXPERT_STATED");
  } finally { await h.close(); }
});
