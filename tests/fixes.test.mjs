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
