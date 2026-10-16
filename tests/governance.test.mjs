// Knowledge governance, sample-space isolation and knowledge-transfer authorization (offline, fake model).
// Everything goes through the HTTP API, as a browser would; the database and RLS are real (PGlite).
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor } from "./helpers.mjs";

const DONE = ["asking", "validating", "no_judgment", "done"];
const settled = (u, id) => waitFor(async () => { const r = (await u.get(`/api/sessions/${id}`)).body; return DONE.includes(r.status) && !r.processing.pending ? r : null; }, { timeoutMs: 30000 });

async function sample(app, kind) {
  const v = user(app);
  const r = await v.post("/api/samples", { kind });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await v.acceptPolicies();
  return { v, me };
}
async function switchTo(v, name) {
  const people = (await v.get("/api/samples/people")).body;
  const p = people.find((x) => x.display_name === name);
  assert.ok(p, `${name} exists in the sample space`);
  const r = await v.post("/api/samples/switch", { personId: p.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (await v.get("/api/auth/me")).body;
}

/** The featured journey through the API: Lakshmi makes ghee on the kitchen camera, answers, approves. */
async function captureGhee(v) {
  const wf = (await v.get("/api/workflows")).body.find((w) => w.name === "Amma's ghee");
  assert.ok(wf, "the sample space has the featured skill");
  let s = (await v.post("/api/sessions", { workflowId: wf.id, source: "sim:kitchen-camera", caseRef: "K1" })).body;
  s = (await v.post(`/api/sessions/${s.id}/consent`, { modalities: ["CAMERA", "MICROPHONE"], clientTime: Date.now() })).body;
  for (const [action] of s.sim.script.steps) {
    const r = await v.post(`/api/sessions/${s.id}/sim`, { action });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  s = await settled(v, s.id);
  for (let i = 0; s.status === "asking" && i < 3; i++) {
    await v.post(`/api/sessions/${s.id}/answer`, { text: s.sim.script.answers[i] });
    s = await settled(v, s.id);
  }
  assert.equal(s.status, "validating", "the teacher reviews the structured knowledge");
  return { wf, s };
}

test("governance: consent to record is not consent to share; the contributor controls access", { timeout: 180000 }, async (t) => {
  const h = await harness({ env: { SAMPLE_SPACES: "1" } });
  try {
    const { v, me } = await sample(h.app, "living");
    let judgmentId, artifactId, wfId;

    await t.test("a sample space is an isolated living space signed in as the teacher", async () => {
      assert.equal(me.org.experience, "living");
      assert.equal(me.org.sampleKind, "living");
      assert.equal(me.user.displayName, "Lakshmi");
      assert.ok(me.roles.includes("EXPERT"));
    });

    await t.test("the kitchen capture produces a reviewable judgment; approval saves it PRIVATE by default", async () => {
      const { wf, s } = await captureGhee(v);
      wfId = wf.id; judgmentId = s.judgmentId;
      const r = await v.post(`/api/judgments/${judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.artifact.governance.visibility, "private");
      assert.equal(r.body.artifact.governance.publicPublication, "not offered");
      assert.equal(r.body.artifact.governance.modelTraining, "not offered");
      artifactId = r.body.artifact.id;
    });

    await t.test("private knowledge is invisible to the learner everywhere: lessons, list, detail, sharing", async () => {
      await switchTo(v, "Meera");
      assert.equal((await v.get(`/api/workflows/${wfId}/lessons`)).body.length, 0);
      assert.equal((await v.get(`/api/workflows/${wfId}/knowledge`)).body.length, 0);
      assert.equal((await v.get(`/api/judgments/${judgmentId}`)).status, 404);
      assert.equal((await v.post(`/api/knowledge/${artifactId}/sharing`, { visibility: "organization" })).status, 404);
    });

    await t.test("private knowledge is never used as AI context for someone else's session", async () => {
      const ctx = { orgId: me.org.id };
      const other = (await h.s.knowledge.retrieveForSession(ctx, wfId, "ghee", 3, { forPersonId: "00000000-0000-4000-8000-000000000000" }));
      assert.equal(other.length, 0);
      const own = await h.s.knowledge.retrieveForSession(ctx, wfId, "ghee", 3, { forPersonId: me.personId });
      assert.equal(own.length, 1);
    });

    await t.test("only the contributor can share; restricted knowledge cannot go to the whole space", async () => {
      await switchTo(v, "Lakshmi");
      assert.equal((await v.post(`/api/knowledge/${artifactId}/sharing`, { restricted: true, visibility: "organization" })).status, 400);
      const people = (await v.get("/api/samples/people")).body;
      const meera = people.find((p) => p.display_name === "Meera");
      const r = await v.post(`/api/knowledge/${artifactId}/sharing`, { visibility: "named", sharedWith: [meera.id], restricted: true, restrictionNote: "Family only", craftContext: { tools: "heavy pan" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const audit = await h.s.db.system((q) => q("SELECT metadata FROM audit_events WHERE action = 'knowledge.sharing' AND target_id = $1", [artifactId]));
      assert.equal(audit.length, 1);

      await switchTo(v, "Meera");
      const lessons = (await v.get(`/api/workflows/${wfId}/lessons`)).body;
      assert.equal(lessons.length, 1);
      assert.equal(lessons[0].judgment.restricted, true);
      const d = await v.get(`/api/judgments/${judgmentId}`);
      assert.equal(d.status, 200);
      assert.equal(d.body.artifact.governance.restrictionNote, "Family only");
      assert.equal(d.body.artifact.governance.canEdit, false);
      assert.equal((await v.post(`/api/knowledge/${artifactId}/sharing`, { visibility: "organization" })).status, 403);
      assert.equal((await v.post(`/api/knowledge/${artifactId}/withdraw`)).status, 403);
    });

    await t.test("another visitor's sample space cannot see or enter this one", async () => {
      const { v: other } = await sample(h.app, "living");
      assert.equal((await other.get(`/api/judgments/${judgmentId}`)).status, 404);
      assert.equal((await other.post(`/api/knowledge/${artifactId}/sharing`, { visibility: "private" })).status, 404);
      const meera = (await h.s.db.system((q) => q("SELECT p.id FROM people p WHERE p.org_id = $1 AND p.display_name = 'Meera'", [me.org.id])))[0];
      assert.equal((await other.post("/api/samples/switch", { personId: meera.id })).status, 404);
    });

    await t.test("the shared demo sign-in can never enter a sample space", async () => {
      const [u] = await h.s.db.system((q) => q("SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.org_id = $1 LIMIT 1", [me.org.id]));
      await assert.rejects(() => h.s.identity.demoLogin({ email: u.email }), /not a demo account/);
    });

    await t.test("withdrawing removes it from the learner and deletes the evidence media", async () => {
      await switchTo(v, "Lakshmi");
      const r = await v.post(`/api/knowledge/${artifactId}/withdraw`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const media = await h.s.db.system((q) => q(`SELECT m.status FROM judgment_evidence e JOIN observations o ON o.id = e.observation_id JOIN media_assets m ON m.id = o.media_asset_id WHERE e.judgment_id = $1`, [judgmentId]));
      assert.ok(media.every((m) => m.status === "purged"));
      await switchTo(v, "Meera");
      assert.equal((await v.get(`/api/workflows/${wfId}/lessons`)).body.length, 0);
      assert.equal((await v.get(`/api/judgments/${judgmentId}`)).status, 404);
    });
  } finally {
    await h.close();
  }
});

test("knowledge transfers: managers plan, only the named expert captures, people see only their own", { timeout: 120000 }, async (t) => {
  const h = await harness({ env: { SAMPLE_SPACES: "1" } });
  try {
    const { v, me } = await sample(h.app, "work");
    const people = (await v.get("/api/samples/people")).body;
    const pid = (n) => people.find((p) => p.display_name === n).id;
    const weaving = (await v.get("/api/workflows")).body.find((w) => w.name === "Hand-loom weaving");
    let seeded, created;

    await t.test("the work sample has one scheduled transfer and a manager can plan another", async () => {
      assert.equal(me.org.experience, "work");
      const list = (await v.get("/api/transfers")).body;
      assert.equal(list.length, 1);
      seeded = list[0];
      assert.equal(seeded.stage, "scheduled");
      assert.equal(seeded.expert.name, "Dana Reyes");
      const r = await v.post("/api/transfers", { workflowId: weaving.id, expertPersonId: pid("Amara Okafor"), learnerPersonId: pid("Lee Chen"), purpose: "Dry-weather tension handling" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      created = r.body.id;
      assert.equal((await v.post("/api/transfers", { workflowId: weaving.id, expertPersonId: pid("Lee Chen"), learnerPersonId: pid("Amara Okafor"), purpose: "x" })).status, 400, "roles are checked");
    });

    await t.test("the expert sees what will be captured, why, and who will see it", async () => {
      const d = (await v.get(`/api/transfers/${seeded.id}`)).body;
      assert.match(d.disclosure.access, /Jordan Park/);
      assert.match(d.disclosure.captured, /screen|microphone/);
    });

    await t.test("a learner sees only their own transfers and cannot plan or start one", async () => {
      await switchTo(v, "Jordan Park");
      const mine = (await v.get("/api/transfers")).body;
      assert.deepEqual(mine.map((x) => x.id), [seeded.id]);
      assert.equal((await v.get(`/api/transfers/${created}`)).status, 404);
      assert.equal((await v.post("/api/transfers", { workflowId: weaving.id, expertPersonId: pid("Amara Okafor"), learnerPersonId: pid("Lee Chen"), purpose: "x" })).status, 403);
      assert.equal((await v.post(`/api/transfers/${seeded.id}/start`, { source: "sim:payments-console", caseRef: "C3" })).status, 403);
      const progress = (await v.get(`/api/progress?workflow=${seeded.workflowId}`)).body;
      assert.deepEqual(progress.learners.map((l) => l.learner.name), ["Jordan Park"]);
    });

    await t.test("another expert cannot start someone else's transfer; the named expert can, and it is linked", async () => {
      await switchTo(v, "Sam Ito");
      assert.equal((await v.post(`/api/transfers/${seeded.id}/start`, { source: "sim:payments-console", caseRef: "C3" })).status, 404);
      await switchTo(v, "Dana Reyes");
      const s = await v.post(`/api/transfers/${seeded.id}/start`, { source: "sim:payments-console", caseRef: "C3" });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const [row] = await h.s.db.system((q) => q("SELECT transfer_id FROM expert_sessions WHERE id = $1", [s.body.id]));
      assert.equal(row.transfer_id, seeded.id);
      assert.equal((await v.get(`/api/transfers/${seeded.id}`)).body.progress.stage, "capturing");
    });

    await t.test("transfers are invisible across organizations", async () => {
      const { v: other } = await sample(h.app, "work");
      assert.equal((await other.get(`/api/transfers/${seeded.id}`)).status, 404);
      assert.equal((await other.post(`/api/transfers/${seeded.id}/status`, { status: "cancelled" })).status, 404);
    });
  } finally {
    await h.close();
  }
});
