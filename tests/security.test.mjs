// Security tests through the real HTTP stack (Fastify inject), real PostgreSQL RLS (PGlite), fake model.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor, PNG, WAV } from "./helpers.mjs";

const DOC = "STANDARD PROCEDURE\n1. Check the value.\n2. Do the documented thing.\nDefault: Do the documented thing.";

test("security: authentication, CSRF, policies, RBAC, uploads, tenant isolation", { timeout: 120000 }, async (t) => {
  const h = await harness();
  const { app, s } = h;
  try {
    // ---------------------------------------------------------------- fixtures: two organizations
    const a = user(app); const meA = await a.signup("admin@a.test", "Org A");
    const b = user(app); const meB = await b.signup("admin@b.test", "Org B");
    assert.notEqual(meA.org.id, meB.org.id);

    const wfRes = await a.post("/api/workflows", { name: "A flow", kind: "software", modalities: { screen: true, microphone: true, documents: true }, captureSources: ["live:screen"], documents: [{ title: "SOP", text: DOC }] });
    assert.equal(wfRes.status, 200, JSON.stringify(wfRes.body));
    const wfA = wfRes.body.id;
    await waitFor(async () => (await a.get(`/api/workflows/${wfA}`)).body.status === "active");

    // invite an expert and a learner into org A
    const inviteE = await a.post("/api/admin/invitations", { email: "expert@a.test", roles: ["EXPERT"] });
    const inviteL = await a.post("/api/admin/invitations", { email: "learner@a.test", roles: ["LEARNER"] });
    const expertA = user(app), learnerA = user(app);
    await expertA.post("/api/auth/accept-invite", { token: inviteE.body.inviteUrl.split("/").pop(), displayName: "Exp A", password: "correct-horse-battery" });
    await expertA.acceptPolicies();
    await learnerA.post("/api/auth/accept-invite", { token: inviteL.body.inviteUrl.split("/").pop(), displayName: "Learner A", password: "correct-horse-battery" });
    await learnerA.acceptPolicies();

    // a full capture in org A (admin is owner + expert participant of their own workflow)
    let sess = (await a.post("/api/sessions", { workflowId: wfA, source: "live:screen" })).body;
    assert.equal(sess.status, "awaiting_consent");
    sess = (await a.post(`/api/sessions/${sess.id}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() })).body;
    const up = await a.call("POST", `/api/sessions/${sess.id}/media`, PNG(7), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
    assert.equal(up.status, 202, JSON.stringify(up.body));
    await a.post(`/api/sessions/${sess.id}/end`);
    await waitFor(async () => (await a.get(`/api/sessions/${sess.id}`)).body.status === "asking", { timeoutMs: 20000 });
    await a.post(`/api/sessions/${sess.id}/answer`, { text: "Because the value was odd, only when it is odd." });
    sess = await waitFor(async () => { const r = (await a.get(`/api/sessions/${sess.id}`)).body; return r.status === "validating" ? r : null; }, { timeoutMs: 20000 });
    const judgmentA = sess.judgmentId;
    const obsA = sess.observations[0].id;
    const assetA = up.body.assetId;
    const approve = await a.post(`/api/judgments/${judgmentA}/validate`, { decision: "approve", confirmBoundary: true });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    // Generated tests are drafts: no learner sees or is assessed on them until the contributor approves them.
    const review = await waitFor(async () => { const r = (await a.get(`/api/judgments/${judgmentA}/scenarios`)).body; return r.scenarios?.length === 4 ? r : null; }, { timeoutMs: 20000 });
    assert.ok(review.scenarios.every((x) => x.reviewStatus === "draft"));
    assert.equal((await learnerA.get(`/api/judgments/${judgmentA}/scenarios`)).status, 403, "learners never see answer keys or drafts");
    assert.equal((await learnerA.post("/api/attempts", { scenarioId: review.scenarios[0].id })).status, 409, "no assessment against an unapproved test");
    for (const sc of review.scenarios) assert.equal((await a.post(`/api/scenarios/${sc.id}/review`, { approve: true })).status, 200);
    const lessons = await waitFor(async () => { const l = (await a.get(`/api/workflows/${wfA}/lessons`)).body; return l[0]?.scenarios.length === 4 ? l : null; }, { timeoutMs: 20000 });
    const scenarioA = lessons[0].scenarios[0].id;
    // learner needs to be a participant? lessons are org-level; learner can attempt
    const att = await learnerA.post("/api/attempts", { scenarioId: scenarioA });
    assert.equal(att.status, 200, JSON.stringify(att.body));
    const attemptA = att.body.id;

    // ---------------------------------------------------------------- authentication
    await t.test("unauthenticated requests are rejected", async () => {
      const anon = user(app);
      assert.equal((await anon.get("/api/workflows")).status, 401);
      assert.equal((await anon.get(`/api/media/${assetA}`)).status, 401);
    });

    await t.test("wrong password returns a generic error; repeated failures lock the account", async () => {
      const x = user(app);
      const r = await x.post("/api/auth/login", { email: "expert@a.test", password: "nope-nope-nope" });
      assert.equal(r.status, 401);
      const r2 = await x.post("/api/auth/login", { email: "nobody@a.test", password: "nope-nope-nope" });
      assert.equal(r2.body.error, r.body.error, "no account enumeration");
      for (let i = 0; i < 5; i++) await x.post("/api/auth/login", { email: "learner@a.test", password: `bad-password-${i}` });
      const locked = await x.post("/api/auth/login", { email: "learner@a.test", password: "correct-horse-battery" });
      assert.equal(locked.status, 429);
    });

    await t.test("weak passwords are refused at sign-up", async () => {
      const r = await user(app).post("/api/auth/signup", { email: "w@w.test", password: "short", displayName: "w", orgName: "W" });
      assert.equal(r.status, 400);
    });

    await t.test("logout revokes the server-side session", async () => {
      const x = user(app); await x.login("admin@b.test");
      assert.equal((await x.post("/api/auth/logout")).status, 200);
      assert.equal((await x.get("/api/workflows")).status, 401);
    });

    await t.test("session cookie is HttpOnly + SameSite and the token is stored hashed", async () => {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@b.test", password: "correct-horse-battery" } });
      const c = [].concat(r.headers["set-cookie"])[0];
      assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/);
      const token = c.split(";")[0].split("=")[1];
      const rows = await s.db.system((q) => q("SELECT count(*)::int AS n FROM auth_sessions WHERE token_hash = $1", [token]));
      assert.equal(rows[0].n, 0, "raw token must never be stored");
    });

    // ---------------------------------------------------------------- CSRF + origin
    await t.test("state-changing requests need the CSRF token and a same-origin Origin", async () => {
      const x = user(app); await x.login("admin@b.test");
      x.clearCsrf();
      assert.equal((await x.post("/api/workflows", { name: "x" })).status, 403);
      await x.acceptPolicies();
      const evil = await x.call("POST", "/api/auth/switch-org", { orgId: meB.org.id }, { origin: "https://evil.example" });
      assert.equal(evil.status, 403);
    });

    // ---------------------------------------------------------------- policy gate
    await t.test("API use requires accepting current policies", async () => {
      const x = user(app);
      await x.post("/api/auth/signup", { email: "fresh@c.test", password: "correct-horse-battery", displayName: "fresh", orgName: "C" });
      await x.get("/api/auth/me");
      const r = await x.get("/api/workflows");
      assert.equal(r.status, 428);
      assert.equal(r.body.code, "POLICIES_PENDING");
    });

    // ---------------------------------------------------------------- RBAC
    await t.test("learners cannot create workflows, capture, read sessions, knowledge or audit", async () => {
      assert.equal((await learnerA.post("/api/workflows", { name: "x", documents: [{ title: "d", text: DOC }] })).status, 403);
      assert.equal((await learnerA.post("/api/sessions", { workflowId: wfA })).status, 403);
      assert.equal((await learnerA.get(`/api/sessions/${sess.id}`)).status, 403);
      assert.equal((await learnerA.get(`/api/judgments/${judgmentA}`)).status, 403);
      assert.equal((await learnerA.get("/api/admin/audit")).status, 403);
      assert.equal((await learnerA.get(`/api/media/${assetA}`)).status, 403);
    });

    await t.test("an expert cannot approve another expert's judgment or administer members", async () => {
      assert.equal((await expertA.post(`/api/judgments/${judgmentA}/validate`, { decision: "reject" })).status, 403);
      assert.equal((await expertA.post("/api/admin/invitations", { email: "z@a.test", roles: ["ORG_ADMIN"] })).status, 403);
      assert.equal((await expertA.post(`/api/admin/members/${meA.user.id}/roles`, { roles: ["LEARNER"] })).status, 403);
    });

    await t.test("the last admin cannot be demoted", async () => {
      assert.equal((await a.post(`/api/admin/members/${meA.user.id}/roles`, { roles: ["EXPERT"] })).status, 409);
    });

    await t.test("only the captured expert can consent, upload, answer or pause", async () => {
      assert.equal((await expertA.post(`/api/sessions/${sess.id}/privacy`, { paused: true })).status, 403);
      assert.equal((await expertA.call("POST", `/api/sessions/${sess.id}/media`, PNG(9), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame" })).status, 403);
    });

    await t.test("authorization denials are audited", async () => {
      const rows = await s.db.system((q) => q("SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.denied' AND org_id = $1", [meA.org.id]));
      assert.ok(rows[0].n > 0);
    });

    // ---------------------------------------------------------------- tenant isolation (IDOR): B knows A's ids
    await t.test("tenant B cannot read or act on tenant A's resources even with their ids", async () => {
      const probes = [
        ["GET", `/api/workflows/${wfA}`], ["GET", `/api/sessions/${sess.id}`], ["GET", `/api/media/${assetA}`], ["GET", `/api/judgments/${judgmentA}`],
        ["GET", `/api/attempts/${attemptA}`], ["GET", `/api/scenarios/${scenarioA}/visual`], ["GET", `/api/workflows/${wfA}/knowledge`],
        ["GET", `/api/sessions/${sess.id}/window?at=${new Date().toISOString()}`],
        ["POST", `/api/judgments/${judgmentA}/validate`, { decision: "reject" }], ["DELETE", `/api/observations/${obsA}`],
        ["POST", "/api/sessions", { workflowId: wfA }], ["POST", "/api/attempts", { scenarioId: scenarioA }],
        ["POST", `/api/sessions/${sess.id}/consent`, { modalities: ["SCREEN"] }],
      ];
      for (const [m, u, body] of probes) {
        const r = await b.call(m, u, body);
        assert.ok([403, 404].includes(r.status), `${m} ${u} → ${r.status} ${JSON.stringify(r.body)}`);
      }
      const list = await b.get(`/api/workflows/${wfA}/lessons`);
      assert.ok(list.status === 200 ? list.body.length === 0 : [403, 404].includes(list.status));
      const metrics = (await b.get("/api/analytics/metrics")).body;
      assert.equal(metrics.knowledge.knowledgeCaptured, 0, "B's analytics contain none of A's knowledge");
      const wfs = (await b.get("/api/workflows")).body;
      assert.ok(!wfs.some((w) => w.id === wfA));
      assert.equal((await b.post("/api/auth/switch-org", { orgId: meA.org.id })).status, 403);
    });

    await t.test("the database itself enforces isolation: app role sees nothing without the tenant setting", async () => {
      const rows = await s.db.tenant({ orgId: meB.org.id }, (q) => q("SELECT count(*)::int AS n FROM judgments"));
      assert.equal(rows[0].n, 0);
      await assert.rejects(s.db.tenant({ orgId: meB.org.id }, (q) => q("INSERT INTO workspaces (org_id, name) VALUES ($1, 'x')", [meA.org.id])), /row-level security/);
      await assert.rejects(s.db.tenant({ orgId: meA.org.id }, (q) => q("SELECT * FROM users")), /permission denied/);
      await assert.rejects(s.db.tenant({ orgId: meA.org.id }, (q) => q("DELETE FROM audit_events")), /permission denied/);
    });

    // ---------------------------------------------------------------- uploads + consent
    await t.test("uploads are checked by magic bytes, size, consent and capture state", async () => {
      let s2 = (await a.post("/api/sessions", { workflowId: wfA, source: "live:screen" })).body;
      const notConsented = await a.call("POST", `/api/sessions/${s2.id}/media`, PNG(3), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame" });
      assert.equal(notConsented.status, 409, "no capture before consent");
      s2 = (await a.post(`/api/sessions/${s2.id}/consent`, { modalities: ["SCREEN"] })).body;
      const fake = await a.call("POST", `/api/sessions/${s2.id}/media`, Buffer.from("<script>alert(1)</script>".padEnd(80, " ")), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame" });
      assert.equal(fake.status, 415, "content-type is never trusted");
      const mic = await a.call("POST", `/api/sessions/${s2.id}/media`, WAV(1), { "content-type": "audio/wav", "x-modality": "MICROPHONE", "x-kind": "audio_chunk" });
      assert.equal(mic.status, 403, "microphone was not consented");
      await a.post(`/api/sessions/${s2.id}/privacy`, { excluded: { SCREEN: true } });
      const excluded = await a.call("POST", `/api/sessions/${s2.id}/media`, PNG(4), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame" });
      assert.equal(excluded.status, 409);
      await a.post(`/api/sessions/${s2.id}/privacy`, { excluded: { SCREEN: false }, paused: true });
      const paused = await a.call("POST", `/api/sessions/${s2.id}/media`, PNG(5), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame" });
      assert.equal(paused.status, 409);
      const consent = await s.db.system((q) => q("SELECT modalities, policy_version FROM consent_records WHERE session_id = $1", [s2.id]));
      assert.deepEqual(consent[0].modalities, ["SCREEN"]);
      assert.ok(consent[0].policy_version);
    });

    await t.test("PDFs with active content are rejected", async () => {
      const pdf = Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj");
      const r = await a.post("/api/workflows", { name: "pdf", documents: [{ title: "bad.pdf", dataBase64: pdf.toString("base64") }] });
      assert.equal(r.status, 422);
    });

    await t.test("security headers are present", async () => {
      const r = await app.inject({ method: "GET", url: "/" });
      assert.match(r.headers["content-security-policy"], /default-src 'self'/);
      assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.match(r.headers["permissions-policy"], /camera=\(self\)/);
      assert.equal(r.headers["cache-control"], "no-cache", "UI assets revalidate so a deploy never leaves clients on stale code");
    });

    await t.test("database conflicts are client errors that leak no internals", async () => {
      const dup = await a.post("/api/workflows", { name: "A flow", kind: "software", modalities: { screen: true, documents: true }, captureSources: ["live:screen"], documents: [{ title: "SOP", text: DOC }] });
      assert.equal(dup.status, 409, JSON.stringify(dup.body));
      assert.equal(dup.body.code, undefined);
      assert.doesNotMatch(JSON.stringify(dup.body), /23505|duplicate key|constraint/i);
    });
  } finally {
    await h.close();
  }
});
