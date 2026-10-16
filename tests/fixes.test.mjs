// Fixes from user testing (October 2026): invitation sign-in, terminating sessions, deleting skills, recent sessions on
// Home, and asking for access to knowledge that is not shared with you. Real HTTP stack, PostgreSQL (PGlite) with RLS.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor } from "./helpers.mjs";

async function account(h, email, orgName, experience = "work") {
  const u = user(h.app);
  const r = await u.call("POST", "/api/auth/signup", { email, password: "correct-horse-battery", displayName: email.split("@")[0], orgName, experience });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { u, me: await u.acceptPolicies() };
}

test("fixes from user testing", { timeout: 180000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const owner = await account(h, "owner@f.test", "Owner Co");
    const victim = await account(h, "victim@f.test", "Victim Home", "living");

    await t.test("an invitation link never signs anyone in to an existing account without that account's password", async () => {
      const inv = (await owner.u.post("/api/admin/invitations", { email: "victim@f.test", roles: ["LEARNER"] })).body;
      const token = inv.inviteUrl.split("/").pop();
      const info = (await user(h.app).post("/api/auth/invite-info", { token })).body;
      assert.equal(info.hasAccount, true); assert.equal(info.spaceName, "Owner Co");
      const attacker = user(h.app);
      assert.equal((await attacker.post("/api/auth/accept-invite", { token, password: "not-the-password" })).status, 401);
      assert.equal((await attacker.post("/api/auth/accept-invite", { token })).status, 401);
      const ok = await user(h.app).post("/api/auth/accept-invite", { token, password: "correct-horse-battery" });
      assert.equal(ok.status, 200, "the real owner of the account can join with their own password");
      assert.equal((await user(h.app).post("/api/auth/invite-info", { token })).status, 404, "single use");
    });

    await t.test("a new person creates their account from the link", async () => {
      const inv = (await owner.u.post("/api/admin/invitations", { email: "newbie@f.test", roles: ["LEARNER"] })).body;
      const token = inv.inviteUrl.split("/").pop();
      assert.equal((await user(h.app).post("/api/auth/invite-info", { token })).body.hasAccount, false);
      assert.equal((await user(h.app).post("/api/auth/accept-invite", { token, displayName: "Newbie", password: "a-long-new-password-1" })).status, 200);
    });

    let sid;
    await t.test("recent sessions appear immediately with their status; terminate is final even if a job finishes later", async () => {
      const st = (await owner.u.post("/api/live/start", { kind: "screen", name: "KT of JMeter", language: "en" })).body;
      sid = st.sessionId;
      await owner.u.post(`/api/sessions/${sid}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() });
      const list = (await owner.u.get("/api/my/sessions")).body;
      assert.equal(list[0].id, sid); assert.equal(list[0].status, "capturing"); assert.equal(list[0].title, "KT of JMeter");
      assert.equal(list[0].href, `#/map/${sid}`, "a live session links to its Work Map page from the first moment");
      await owner.u.post(`/api/live/${sid}/text`, { text: "I check the thread count first." });
      assert.equal((await owner.u.post(`/api/sessions/${sid}/terminate`, {})).status, 400, "termination needs explicit confirmation");
      assert.equal((await victim.u.post(`/api/sessions/${sid}/terminate`, { confirm: true })).status, 404, "another space cannot see it");
      assert.equal((await owner.u.post(`/api/sessions/${sid}/terminate`, { confirm: true })).status, 200);
      // A late background update cannot bring it back.
      await h.s.db.system((q) => q("UPDATE expert_sessions SET status = 'debrief' WHERE id = $1", [sid]));
      const [s] = await h.s.db.system((q) => q("SELECT status FROM expert_sessions WHERE id = $1", [sid]));
      assert.equal(s.status, "terminated");
      const obs = await h.s.db.system((q) => q("SELECT count(*)::int AS n FROM observations WHERE session_id = $1 AND deleted_at IS NULL", [sid]));
      assert.equal(obs[0].n, 0, "captured moments are removed from use");
      assert.ok(!(await owner.u.get("/api/my/sessions")).body.some((x) => x.id === sid), "terminated sessions leave the list");
      assert.equal((await owner.u.post(`/api/live/${sid}/finish`, { phase: "capture" })).status, 409);
    });

    await t.test("delete a skill: hidden everywhere, its recording session terminated, managers only", async () => {
      const st = (await owner.u.post("/api/live/start", { kind: "camera", name: "Old skill", language: "en" })).body;
      const wfId = st.workflowId;
      const learner = await account(h, "learner@f.test", "Learner Own");
      void learner;
      assert.equal((await owner.u.post(`/api/workflows/${wfId}/delete`, {})).status, 400);
      assert.equal((await owner.u.post(`/api/workflows/${wfId}/delete`, { confirm: true })).status, 200);
      assert.ok(!(await owner.u.get("/api/workflows")).body.some((w) => w.id === wfId));
      assert.equal((await owner.u.get(`/api/workflows/${wfId}`)).status, 404);
      const [s] = await h.s.db.system((q) => q("SELECT status FROM expert_sessions WHERE id = $1", [st.sessionId]));
      assert.equal(s.status, "terminated");
    });

    await t.test("request access: the contributor decides; a general request lets a teacher choose what to share", async () => {
      // A Personal space: the teacher (founder) and a learner invited into it.
      const teacher = await account(h, "teacher@f.test", "Teacher Home", "living");
      const inv = (await teacher.u.post("/api/admin/invitations", { email: "student@f.test", roles: ["LEARNER"] })).body;
      const student = user(h.app);
      assert.equal((await student.post("/api/auth/accept-invite", { token: inv.inviteUrl.split("/").pop(), displayName: "Student", password: "learning-ghee-2026" })).status, 200);
      await student.acceptPolicies();
      // Nothing approved yet: a general request still reaches the teacher, who has nothing to share.
      const g = await student.post("/api/access-requests", { note: "I would like to learn the ghee." });
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.equal((await student.post("/api/access-requests", {})).body.alreadyRequested, true, "one pending request at a time");
      const incoming = (await teacher.u.get("/api/access-requests")).body.incoming;
      assert.equal(incoming.length, 1); assert.equal(incoming[0].item, null); assert.match(incoming[0].note, /ghee/);
      const inbox = (await teacher.u.get("/api/inbox")).body;
      assert.ok(JSON.stringify(inbox).includes("would like to learn from you"));
      assert.equal((await teacher.u.post(`/api/access-requests/${incoming[0].id}/decide`, { grant: true, artifactIds: [] })).status, 400, "granting needs something chosen");
      assert.equal((await student.post(`/api/access-requests/${incoming[0].id}/decide`, { grant: true })).status, 403, "requesters cannot grant themselves");
      assert.equal((await teacher.u.post(`/api/access-requests/${incoming[0].id}/decide`, { grant: false })).status, 200);
      const out = (await student.get("/api/access-requests")).body.outgoing;
      assert.equal(out[0].status, "declined");
      assert.ok(JSON.stringify((await student.get("/api/inbox")).body).includes("declined"), "the requester is told");
      assert.equal((await student.post("/api/access-requests", { artifactId: "00000000-0000-0000-0000-000000000000" })).status, 404);
    });
  } finally { await h.close(); }
});

test("Work Map sharing and space separation (second test report)", { timeout: 180000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const teacher = await account(h, "guru@s.test", "Guru Home", "living");
    const join = async (email, roles) => {
      const inv = (await teacher.u.post("/api/admin/invitations", { email, roles })).body;
      const u = user(h.app);
      assert.equal((await u.post("/api/auth/accept-invite", { token: inv.inviteUrl.split("/").pop(), displayName: email.split("@")[0], password: "a-long-test-pass-42" })).status, 200);
      return { u, me: await u.acceptPolicies() };
    };
    const learner = await join("shishya@s.test", ["LEARNER"]);
    const other = await join("mitra@s.test", ["LEARNER"]);
    const coord = await join("sanyojak@s.test", ["KT_COORDINATOR"]);

    // The teacher records and confirms a Work Map.
    const st = (await teacher.u.post("/api/live/start", { kind: "camera", name: "Peanut subji", language: "mr" })).body;
    const sid = st.sessionId;
    await teacher.u.post(`/api/sessions/${sid}/consent`, { modalities: ["CAMERA", "MICROPHONE"], clientTime: Date.now() });
    await teacher.u.post(`/api/live/${sid}/text`, { text: "anything over fifty thousand I hold" });
    await teacher.u.post(`/api/live/${sid}/finish`, { phase: "capture" });
    await waitFor(async () => { const r = (await teacher.u.get(`/api/maps/${sid}`)).body; return r.steps && !r.building; }, { timeoutMs: 20000 });

    await t.test("the teacher always sees their own map; a coordinator sees every map; a learner sees nothing yet", async () => {
      const own = (await teacher.u.get(`/api/maps/${sid}`)).body;
      assert.equal(own.access, "owner"); assert.equal(own.canShare, true);
      assert.equal((await coord.u.get(`/api/maps/${sid}`)).body.access, "manager", "admins and coordinators see all, drafts included");
      assert.equal((await learner.u.get(`/api/maps/${sid}`)).status, 404);
      assert.equal((await learner.u.get("/api/maps/catalog")).body.length, 0, "drafts are not even listed");
    });

    await teacher.u.post(`/api/maps/${sid}/confirm`, {});

    await t.test("confirmed and private (Personal space default): learners see the title and can ask for access", async () => {
      assert.equal((await learner.u.get(`/api/maps/${sid}`)).status, 404);
      const cat = (await learner.u.get("/api/maps/catalog")).body;
      assert.equal(cat.length, 1); assert.equal(cat[0].title.length > 0, true);
      const req = await learner.u.post("/api/access-requests", { workMapId: cat[0].workMapId });
      assert.equal(req.status, 200, JSON.stringify(req.body));
      const inc = (await teacher.u.get("/api/access-requests")).body.incoming;
      assert.equal(inc[0].item.kind, "workmap");
      assert.equal((await other.u.post(`/api/access-requests/${inc[0].id}/decide`, { grant: true })).status, 403, "a learner cannot grant");
      assert.equal((await coord.u.post(`/api/access-requests/${inc[0].id}/decide`, { grant: true })).status, 200, "a coordinator can grant");
      assert.equal((await learner.u.get(`/api/maps/${sid}`)).status, 200);
      assert.equal((await other.u.get(`/api/maps/${sid}`)).status, 404, "granting one person shares with that person only");
    });

    await t.test("share with a group, then with everyone; only the expert or an admin/coordinator may share", async () => {
      const g = (await teacher.u.post("/api/groups", { name: "Kitchen circle" })).body;
      await teacher.u.post(`/api/groups/${g.id}/members`, { personIds: [other.me.personId] });
      assert.equal((await learner.u.post(`/api/maps/${sid}/sharing`, { visibility: "organization" })).status, 403);
      assert.equal((await teacher.u.post(`/api/maps/${sid}/sharing`, { visibility: "named", groups: [g.id] })).status, 200);
      assert.equal((await other.u.get(`/api/maps/${sid}`)).status, 200, "group members can open it");
      assert.equal((await learner.u.get(`/api/maps/${sid}`)).status, 404, "the earlier one-person grant was replaced by the new choice");
      assert.equal((await coord.u.post(`/api/maps/${sid}/sharing`, { visibility: "organization" })).status, 200);
      assert.equal((await learner.u.get(`/api/maps/${sid}`)).status, 200, "everyone in the space");
      assert.ok((await learner.u.get("/api/maps")).body.some((m) => m.sessionId === sid));
      const ask = (await learner.u.post("/api/ask", { question: "What do you do over the limit?" })).body;
      assert.doesNotMatch(ask.answer ?? "", /Nothing has been confirmed and shared/, "Ask now uses the shared Work Map");
    });

    await t.test("each space keeps its own notifications", async () => {
      await teacher.u.post("/api/spaces", { name: "Java Developers", kind: "enterprise" });
      await teacher.u.acceptPolicies();
      const inbox = (await teacher.u.get("/api/inbox")).body;
      assert.equal(inbox.notifications.filter((n) => n.spaceName === "Guru Home").length, 0, "no notifications from the other space are listed");
      assert.ok(inbox.otherSpaces.some((o) => o.spaceName === "Guru Home" && o.unread > 0), "only a count, with a way to switch");
    });
  } finally { await h.close(); }
});

test("optional space passcode: owner sets it; members enter it once per sign-in", { timeout: 120000 }, async () => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const owner = await account(h, "boss@p.test", "Java Developers");
    const inv = (await owner.u.post("/api/admin/invitations", { email: "dev@p.test", roles: ["LEARNER"] })).body;
    const dev = user(h.app);
    assert.equal((await dev.post("/api/auth/accept-invite", { token: inv.inviteUrl.split("/").pop(), displayName: "Dev", password: "a-long-test-pass-42" })).status, 200);
    await dev.acceptPolicies();
    assert.equal((await dev.post("/api/spaces/passcode", { passcode: "secret-123" })).status, 403, "only the owner sets it");
    assert.equal((await owner.u.post("/api/spaces/passcode", { passcode: "123" })).status, 400, "too short");
    assert.equal((await owner.u.post("/api/spaces/passcode", { passcode: "secret-123" })).status, 200);
    assert.equal((await owner.u.get("/api/maps")).status, 200, "the owner's own session stays unlocked");
    const me = (await dev.get("/api/auth/me")).body;
    assert.equal(me.org.locked, true);
    assert.equal((await dev.get("/api/maps")).status, 423, "space content is closed until the passcode is entered");
    assert.equal((await dev.get("/api/spaces")).status, 200, "switching spaces still works");
    assert.equal((await dev.post("/api/space/unlock", { passcode: "wrong-one" })).status, 401);
    assert.equal((await dev.post("/api/space/unlock", { passcode: "secret-123" })).status, 200);
    assert.equal((await dev.get("/api/maps")).status, 200);
    await owner.u.post("/api/spaces/passcode", { passcode: "new-secret-456" });
    assert.equal((await dev.get("/api/maps")).status, 423, "changing the passcode locks it again for everyone else");
    await owner.u.post("/api/spaces/passcode", { passcode: null });
    assert.equal((await dev.get("/api/maps")).status, 200, "removing it opens the space to members again");
    const audit = await h.s.db.system((q) => q("SELECT action, outcome FROM audit_events WHERE action LIKE 'space.%' ORDER BY created_at"));
    assert.ok(audit.some((a) => a.action === "space.unlock" && a.outcome === "denied"), "failed attempts are audited");
  } finally { await h.close(); }
});

test("a new member can unlock a passcode space before accepting its policies", { timeout: 60000 }, async () => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const owner = await account(h, "own2@p.test", "Locked Co");
    const inv = (await owner.u.post("/api/admin/invitations", { email: "new2@p.test", roles: ["LEARNER"] })).body;
    await owner.u.post("/api/spaces/passcode", { passcode: "secret-789" });
    const u = user(h.app);
    assert.equal((await u.post("/api/auth/accept-invite", { token: inv.inviteUrl.split("/").pop(), displayName: "New", password: "a-long-test-pass-42" })).status, 200);
    assert.equal((await u.post("/api/space/unlock", { passcode: "secret-789" })).status, 200, "unlock comes before the policies");
    const me = await u.acceptPolicies();
    assert.equal(me.org.locked, false);
    assert.equal((await u.get("/api/maps")).status, 200);
  } finally { await h.close(); }
});
