// Personal + Enterprise spaces, invitations, role model, groups, group sharing, notifications, KT missions, storage reuse
// and the derived-answer cache. Offline (scripted fake model), real HTTP stack, real PostgreSQL engine (PGlite) with RLS.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor, PNG } from "./helpers.mjs";

const DOC = "STANDARD PROCEDURE\n1. Check the value.\n2. Do the documented thing.\nDefault: Do the documented thing.";
const DONE = ["asking", "validating", "no_judgment", "done"];

async function account(h, email, orgName, experience = "work") {
  const u = user(h.app);
  const r = await u.call("POST", "/api/auth/signup", { email, password: "correct-horse-battery", displayName: email.split("@")[0], orgName, experience });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = await u.acceptPolicies();
  return { u, me };
}
/** Invite an email into the caller's active space and accept from the invitee's inbox (no token: identity is proven). */
async function inviteAndAccept(owner, invitee, roles) {
  const inv = await owner.post("/api/admin/invitations", { email: invitee.me.user.email, roles });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const inbox = (await invitee.u.get("/api/inbox")).body;
  const item = inbox.invitations.find((i) => i.id === inv.body.id);
  assert.ok(item, "the invitation is in the invitee's inbox");
  assert.equal((await invitee.u.post(`/api/invitations/${item.id}/respond`, { accept: true })).status, 200);
  await invitee.u.post("/api/auth/switch-org", { orgId: item.spaceId });
  return invitee.u.acceptPolicies();
}
const personOf = async (u, name) => (await u.get("/api/people")).body.find((p) => p.display_name === name)?.id;

test("spaces, invitations and the role model", { timeout: 120000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const ana = await account(h, "ana@t.test", "Ana Corp");
    const ben = await account(h, "ben@t.test", "Ben Home", "living");

    await t.test("the creator owns the space; a person can create and belong to both kinds", async () => {
      assert.ok(ana.me.roles.includes("ORG_OWNER") && ana.me.roles.includes("ORG_ADMIN"));
      const r = await ana.u.post("/api/spaces", { name: "Ana's family recipes", kind: "personal" });
      assert.equal(r.status, 200);
      const spaces = (await ana.u.get("/api/spaces")).body.spaces;
      assert.deepEqual(spaces.map((s) => s.kind).sort(), ["enterprise", "personal"]);
      assert.ok(spaces.every((s) => s.roles.includes("ORG_OWNER")));
      await ana.u.post("/api/auth/switch-org", { orgId: spaces.find((s) => s.kind === "enterprise").id });
      await ana.u.acceptPolicies();
    });

    await t.test("an invitation reaches an existing account's inbox; accept adds membership, decline and revoke do not", async () => {
      const me = await inviteAndAccept(ana.u, ben, ["EXPERT"]);
      assert.equal(me.org.name, "Ana Corp");
      assert.deepEqual(me.roles, ["EXPERT"], "roles are per space: Ben is owner at home, expert here");
      const carl = await account(h, "carl@t.test", "Carl Co");
      const inv = (await ana.u.post("/api/admin/invitations", { email: "carl@t.test", roles: ["LEARNER"] })).body;
      assert.equal((await carl.u.post(`/api/invitations/${inv.id}/respond`, { accept: false })).status, 200);
      assert.equal((await carl.u.post("/api/auth/switch-org", { orgId: ana.me.org.id })).status, 403, "declined: no membership");
      const inv2 = (await ana.u.post("/api/admin/invitations", { email: "carl@t.test", roles: ["LEARNER"] })).body;
      assert.equal((await ana.u.post(`/api/admin/invitations/${inv2.id}/revoke`)).status, 200);
      assert.ok(!(await carl.u.get("/api/inbox")).body.invitations.some((i) => i.id === inv2.id), "revoked invitations disappear");
      const viaLink = user(h.app);
      const r = await viaLink.post("/api/auth/accept-invite", { token: inv2.inviteUrl.split("/").pop(), displayName: "Carl", password: "correct-horse-battery" });
      assert.equal(r.status, 404, "a revoked invitation link no longer works");
      assert.match(inv2.inviteUrl, /#\/invite\//, "invitation links use the route the app actually serves");
    });

    await t.test("a coordinator invites experts and receivers only; only an owner grants owner or administrator", async () => {
      const cora = await account(h, "cora@t.test", "Cora Inc");
      await inviteAndAccept(ana.u, cora, ["KT_COORDINATOR"]);
      assert.equal((await cora.u.post("/api/admin/invitations", { email: "x1@t.test", roles: ["LEARNER"] })).status, 200);
      assert.equal((await cora.u.post("/api/admin/invitations", { email: "x2@t.test", roles: ["ORG_ADMIN"] })).status, 403);
      const dee = await account(h, "dee@t.test", "Dee Ltd");
      await inviteAndAccept(ana.u, dee, ["ORG_ADMIN"]);
      const members = (await ana.u.get("/api/admin/members")).body;
      const coraId = members.find((m) => m.email === "cora@t.test").user_id;
      assert.equal((await dee.u.post(`/api/admin/members/${coraId}/roles`, { roles: ["ORG_ADMIN"] })).status, 403, "an administrator cannot create administrators");
      assert.equal((await dee.u.post(`/api/admin/members/${coraId}/roles`, { roles: ["KT_COORDINATOR", "AUDITOR"] })).status, 200, "but can manage ordinary roles");
      const anaId = members.find((m) => m.email === "ana@t.test").user_id;
      assert.equal((await ana.u.post(`/api/admin/members/${anaId}/roles`, { roles: ["ORG_ADMIN"] })).status, 409, "the last owner cannot remove ownership");
    });
  } finally { await h.close(); }
});

test("groups: least privilege, space isolation, explicit sharing, revocation", { timeout: 180000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const ana = await account(h, "ana@g.test", "Ana Corp");
    const lea = await account(h, "lea@g.test", "Lea Home");
    const leaId = (await inviteAndAccept(ana.u, lea, ["LEARNER"])).personId;
    const out = await account(h, "out@g.test", "Elsewhere");
    let groupId;

    await t.test("in an enterprise space only owners, administrators and coordinators manage groups", async () => {
      assert.equal((await lea.u.post("/api/groups", { name: "Payments-New-Joiners" })).status, 403);
      const g = await ana.u.post("/api/groups", { name: "Payments-New-Joiners", description: "Q4 joiners" });
      assert.equal(g.status, 200);
      groupId = g.body.id;
      assert.equal((await ana.u.post("/api/groups", { name: "payments-new-joiners" })).status, 409, "names are unique per space, case-insensitively");
      assert.equal((await ana.u.post(`/api/groups/${groupId}/members`, { personIds: [out.me.personId] })).status, 400, "a person from another space cannot be added");
      assert.equal((await ana.u.post(`/api/groups/${groupId}/members`, { personIds: [leaId] })).status, 200);
      const audit = await h.s.db.system((q) => q("SELECT action FROM audit_events WHERE action LIKE 'group.%'"));
      assert.ok(["group.create", "group.members_add"].every((a) => audit.some((x) => x.action === a)));
    });

    await t.test("members see their group; outsiders cannot see it at all", async () => {
      assert.ok((await lea.u.get("/api/groups")).body.groups.some((g) => g.id === groupId));
      assert.equal((await lea.u.get(`/api/groups/${groupId}`)).status, 200);
      assert.equal((await out.u.get(`/api/groups/${groupId}`)).status, 404, "another space: indistinguishable from missing");
      assert.ok((await lea.u.get("/api/inbox")).body.notifications.some((n) => n.kind === "group.added"));
    });

    await t.test("knowledge shared with a group is visible to its members only, previewed first, and revoked by removal", async () => {
      // In a Personal space members read knowledge shared with them; Ana teaches, Lea learns.
      const home = (await ana.u.post("/api/spaces", { name: "Ana kitchen", kind: "personal" })).body;
      await ana.u.acceptPolicies();
      const leaHome = (await inviteAndAccept(ana.u, lea, ["LEARNER"])).personId;
      const fam = (await ana.u.post("/api/groups", { name: "Family" })).body;
      await ana.u.post(`/api/groups/${fam.id}/members`, { personIds: [leaHome] });
      await ana.u.post("/api/auth/switch-org", { orgId: home.id });
      const wf = (await ana.u.post("/api/workflows", { name: "Recipe", kind: "physical", modalities: { screen: true, microphone: true }, captureSources: ["live:screen"], documents: [] })).body;
      let s = (await ana.u.post("/api/sessions", { workflowId: wf.id, source: "live:screen" })).body;
      await ana.u.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() });
      await ana.u.call("POST", `/api/sessions/${s.id}/media`, PNG(61), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
      await ana.u.post(`/api/sessions/${s.id}/end`);
      s = await waitFor(async () => { const r = (await ana.u.get(`/api/sessions/${s.id}`)).body; return r.status === "asking" ? r : null; }, { timeoutMs: 20000 });
      await ana.u.post(`/api/sessions/${s.id}/answer`, { text: "Because the value was odd, only when it is odd." });
      s = await waitFor(async () => { const r = (await ana.u.get(`/api/sessions/${s.id}`)).body; return r.status === "validating" ? r : null; }, { timeoutMs: 20000 });
      const ap = (await ana.u.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true })).body;
      assert.equal(ap.artifact.governance.visibility, "private", "private by default in a Personal space");
      await lea.u.post("/api/auth/switch-org", { orgId: home.id });
      assert.equal((await lea.u.get(`/api/judgments/${s.judgmentId}`)).status, 404, "private: invisible to Lea");
      const preview = (await ana.u.post(`/api/knowledge/${ap.artifact.id}/access-preview`, { visibility: "named", sharedWith: [leaHome], sharedGroups: [fam.id] })).body;
      assert.equal(preview.people.length, 1, "a person reachable individually and through a group is listed once");
      assert.deepEqual(preview.people[0].via.sort(), ["Family", "individually"].sort());
      assert.equal((await lea.u.post(`/api/knowledge/${ap.artifact.id}/access-preview`, { visibility: "organization" })).status, 404, "only the contributor previews or changes access");
      assert.equal((await ana.u.post(`/api/knowledge/${ap.artifact.id}/sharing`, { visibility: "named", sharedWith: [], sharedGroups: [fam.id] })).status, 200);
      assert.equal((await lea.u.get(`/api/judgments/${s.judgmentId}`)).status, 200, "visible through the group");
      assert.ok((await lea.u.get("/api/knowledge/mine")).body.sharedWithMe.some((k) => k.id === s.judgmentId));
      assert.equal((await lea.u.del(`/api/groups/${fam.id}/members/${leaHome}`)).status, 200, "a member may leave a group");
      assert.equal((await lea.u.get(`/api/judgments/${s.judgmentId}`)).status, 404, "leaving the group revokes access at once");
      await ana.u.post(`/api/groups/${fam.id}/members`, { personIds: [leaHome] });
      assert.equal((await lea.u.get(`/api/judgments/${s.judgmentId}`)).status, 200);
      await ana.u.post(`/api/groups/${fam.id}`, { archive: true });
      assert.equal((await lea.u.get(`/api/judgments/${s.judgmentId}`)).status, 404, "archiving the group revokes access");
      const audit = await h.s.db.system((q) => q("SELECT action FROM audit_events WHERE action = 'knowledge.sharing'"));
      assert.ok(audit.length >= 1);
      await lea.u.post("/api/auth/switch-org", { orgId: ana.me.org.id });
      await ana.u.post("/api/auth/switch-org", { orgId: ana.me.org.id });
    });

    await t.test("personal spaces: any member creates groups and manages only their own", async () => {
      const home = (await ana.u.post("/api/spaces", { name: "Ana family", kind: "personal" })).body;
      await ana.u.acceptPolicies();
      const kid = await account(h, "kid@g.test", "Kid space");
      await inviteAndAccept(ana.u, kid, ["LEARNER"]);
      const g = await kid.u.post("/api/groups", { name: "Cousins" });
      assert.equal(g.status, 200, "a learner may create a personal group");
      const g2 = (await ana.u.post("/api/groups", { name: "Grandparents" })).body;
      assert.equal((await kid.u.post(`/api/groups/${g2.id}`, { name: "Renamed" })).status, 404, "not a member of someone else's group: not visible");
      assert.ok(home.id);
    });
  } finally { await h.close(); }
});

test("notifications are private to their recipient and never duplicated", { timeout: 60000 }, async () => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const a = await account(h, "na@n.test", "N Corp");
    const b = await account(h, "nb@n.test", "Other");
    const bId = (await inviteAndAccept(a.u, b, ["LEARNER"])).personId;
    const g = (await a.u.post("/api/groups", { name: "Team" })).body;
    await a.u.post(`/api/groups/${g.id}/members`, { personIds: [bId] });
    await a.u.del(`/api/groups/${g.id}/members/${bId}`);
    await a.u.post(`/api/groups/${g.id}/members`, { personIds: [bId] });
    const inbox = (await b.u.get("/api/inbox")).body;
    assert.equal(inbox.notifications.filter((n) => n.kind === "group.added").length, 1, "re-adding within the hour does not notify twice");
    assert.equal((await a.u.get("/api/inbox")).body.notifications.filter((n) => n.kind === "group.added").length, 0, "the manager does not see the member's notifications");
    const rows = await h.s.db.tenant({ orgId: a.me.org.id, userId: a.me.user.id }, (q) => q("SELECT count(*)::int AS n FROM notifications"));
    assert.equal(rows[0].n, 0, "row-level security: inside a space, people read only their own notifications");
    const id = inbox.notifications[0].id;
    await a.u.post("/api/inbox/read", { ids: [id] });
    assert.equal((await b.u.get("/api/inbox")).body.notifications.find((n) => n.id === id).read, false, "nobody else can mark them read");
    await b.u.post("/api/inbox/read", { all: true });
    assert.ok((await b.u.get("/api/inbox")).body.notifications.every((n) => n.read));
  } finally { await h.close(); }
});

test("KT mission: template, brief, group receivers, invitations, brief-guided capture, requirements, honest completion", { timeout: 240000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const ana = await account(h, "ana@m.test", "Mission Corp");
    const exp = await account(h, "eve@m.test", "Eve home");
    const r1 = await account(h, "rui@m.test", "Rui home");
    const r2 = await account(h, "ria@m.test", "Ria home");
    const out = await account(h, "out@m.test", "Out corp");
    const eveId = (await inviteAndAccept(ana.u, exp, ["EXPERT"])).personId;
    const ruiId = (await inviteAndAccept(ana.u, r1, ["LEARNER"])).personId;
    const riaId = (await inviteAndAccept(ana.u, r2, ["LEARNER"])).personId;
    const g = (await ana.u.post("/api/groups", { name: "Payments-New-Joiners" })).body;
    await ana.u.post(`/api/groups/${g.id}/members`, { personIds: [ruiId, riaId, eveId] });
    let missionId;

    await t.test("templates are configuration; every mission can be general/custom", async () => {
      const tp = (await ana.u.get("/api/templates")).body;
      assert.ok(["software_handover", "business_process", "manufacturing", "retirement", "cultural_craft", "language", "general"].every((k) => tp.builtIn.some((x) => x.key === k)));
      const saved = await ana.u.post("/api/templates", { baseKey: "software_handover", config: { name: "Mainframe handover", questions: ["Which batch windows matter?"], captureMethods: ["screen", "bogus"] } });
      assert.equal(saved.status, 200);
      const again = (await ana.u.get("/api/templates")).body.organization.find((x) => x.id === saved.body.id);
      assert.deepEqual(again.captureMethods, ["screen"], "unknown capture methods are dropped");
      assert.equal((await r1.u.post("/api/templates", { baseKey: "general", config: {} })).status, 403);
    });

    await t.test("a coordinator creates a mission with a brief; group receivers resolve once, de-duplicated, without the expert", async () => {
      assert.equal((await r1.u.post("/api/missions", { name: "Nope" })).status, 403, "receivers cannot create missions");
      const m = await ana.u.post("/api/missions", {
        name: "Month-end exceptions handover", templateKey: "software_handover", experts: [eveId], receivers: [ruiId], receiverGroups: [g.id], captureMethods: ["screen", "text"], language: "en",
        brief: { objectives: ["Jordan can handle month-end E217 without Dana"], outcomes: ["Explains why the value matters"], blindSpots: ["What if the value is unreadable?"], acceptance: ["Checks the value before acting"], constraints: ["Never retry a posting twice"], outOfScope: "Card disputes" },
      });
      assert.equal(m.status, 200, JSON.stringify(m.body));
      missionId = m.body.id;
      const rv = (await ana.u.get(`/api/missions/${missionId}/review`)).body;
      assert.deepEqual(rv.receivers.map((x) => x.name).sort(), ["ria", "rui"], "Rui (individual + group) once; Eve, the expert, is not her own receiver");
      assert.equal(rv.receivers.find((x) => x.name === "rui").via, "individually");
      assert.equal(rv.receivers.find((x) => x.name === "ria").via, "Payments-New-Joiners");
      assert.match(rv.access, /shared with people in this space/);
      assert.ok(rv.moti.objectives.length && rv.moti.constraints.length);
    });

    await t.test("drafts are invisible to participants and outsiders; sending invites with minimal content", async () => {
      assert.equal((await exp.u.get(`/api/missions/${missionId}`)).status, 404);
      assert.equal((await out.u.get(`/api/missions/${missionId}`)).status, 404);
      assert.equal((await ana.u.post(`/api/missions/${missionId}/send`)).status, 200);
      assert.equal((await ana.u.post(`/api/missions/${missionId}/send`)).status, 409, "sending twice is refused (no duplicate invitations)");
      const note = (await r2.u.get("/api/inbox")).body.notifications.find((n) => n.kind === "mission.assigned");
      assert.ok(note && /receiver/.test(note.title));
      assert.doesNotMatch(`${note.title} ${note.body}`, /unreadable|retry|E217/, "no brief content in the notification");
      const asReceiver = (await r2.u.get(`/api/missions/${missionId}`)).body;
      assert.deepEqual(Object.keys(asReceiver.brief).sort(), ["constraints", "objectives", "outOfScope", "outcomes", "scope"], "receivers do not see blind spots, questions or acceptance criteria");
      assert.equal(asReceiver.requirements.length, 0);
      assert.equal(asReceiver.stage, "awaiting_participants");
    });

    await t.test("group changes after assignment do not change the mission", async () => {
      const late = await account(h, "late@m.test", "Late home");
      const lateId = (await inviteAndAccept(ana.u, late, ["LEARNER"])).personId;
      await ana.u.post(`/api/groups/${g.id}/members`, { personIds: [lateId] });
      assert.equal((await late.u.get(`/api/missions/${missionId}`)).status, 404, "joining the group later grants nothing on an existing mission");
      const rv = (await ana.u.get(`/api/missions/${missionId}/review`)).body;
      assert.equal(rv.receivers.length, 2);
    });

    let s;
    await t.test("the expert confirms Moti's summary, then captures; the brief reaches the prompts as fenced data", async () => {
      assert.equal((await exp.u.post(`/api/missions/${missionId}/capture`, { method: "screen" })).status, 409, "brief must be confirmed first");
      assert.equal((await r1.u.post(`/api/missions/${missionId}/confirm-brief`)).status, 403);
      assert.equal((await exp.u.post(`/api/missions/${missionId}/confirm-brief`)).status, 200);
      assert.equal((await exp.u.post(`/api/missions/${missionId}/capture`, { method: "audio" })).status, 400, "a method the mission did not enable");
      const calls = h.fake.calls.length;
      s = (await exp.u.post(`/api/missions/${missionId}/capture`, { method: "screen" })).body;
      assert.equal((await exp.u.get(`/api/sessions/${s.id}`)).body.captureSource, "live:screen", "the chosen method decides the capture source");
      await exp.u.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() });
      await exp.u.call("POST", `/api/sessions/${s.id}/media`, PNG(71), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
      await exp.u.post(`/api/sessions/${s.id}/end`);
      s = await waitFor(async () => { const r = (await exp.u.get(`/api/sessions/${s.id}`)).body; return DONE.includes(r.status) && !r.processing.pending ? r : null; }, { timeoutMs: 20000 });
      const q = h.fake.calls.slice(calls).find((c) => c.op === "generateQuestion");
      assert.match(q.prompt, /KT MISSION BRIEF[\s\S]*What if the value is unreadable\?/);
      assert.match(q.prompt, /Out of scope \(do not ask about\): Card disputes/);
      await exp.u.post(`/api/sessions/${s.id}/answer`, { text: "Because the value was odd, only when it is odd." });
      s = await waitFor(async () => { const r = (await exp.u.get(`/api/sessions/${s.id}`)).body; return r.status === "validating" ? r : null; }, { timeoutMs: 20000 });
      assert.ok((await exp.u.get("/api/inbox")).body.notifications.some((n) => n.kind === "mission.review"), "the expert is told the knowledge awaits review");
      const gapCall = await waitFor(async () => h.fake.calls.slice(calls).find((c) => c.op === "detectGaps"), { timeoutMs: 15000 });
      assert.match(gapCall.prompt, /KT MISSION BRIEF/);
    });

    await t.test("requirements: verified citations only; a person's decision stands; the AI never overwrites it", async () => {
      const m = await waitFor(async () => { const r = (await ana.u.get(`/api/missions/${missionId}`)).body; return r.requirements.some((x) => x.basis !== "NONE") && !r.assessing ? r : null; }, { timeoutMs: 20000 });
      assert.equal(m.stage, "knowledge_review");
      const [first, second] = m.requirements;
      assert.equal(first.status, "satisfied");
      assert.equal(first.basis, "AI_VERIFIED");
      assert.equal(first.evidence[0].quote, "the value was odd");
      assert.equal(second.status, "unresolved", "a 'satisfied' claim whose quote is not in the knowledge is downgraded");
      assert.match(second.explanation, /could not be verified/);
      assert.equal((await r1.u.post(`/api/requirements/${second.id}/decide`, { status: "not_applicable" })).status, 403, "receivers cannot decide requirements");
      assert.equal((await exp.u.post(`/api/requirements/${second.id}/decide`, { status: "satisfied" })).status, 400, "a person marking satisfied must say why");
      assert.equal((await exp.u.post(`/api/requirements/${second.id}/decide`, { status: "not_applicable", note: "Covered in a different mission" })).status, 200);
    });

    await t.test("completion requires the criteria, or an explicit recorded exception", async () => {
      const r = await ana.u.post(`/api/missions/${missionId}/complete`, {});
      assert.equal(r.status, 409);
      assert.match(r.body.error, /not complete/);
      assert.equal((await exp.u.post(`/api/missions/${missionId}/complete`, { exceptionNote: "x" })).status, 403, "the expert cannot close the mission");
      const done = await ana.u.post(`/api/missions/${missionId}/complete`, { exceptionNote: "Handover deadline reached; receivers continue under supervision." });
      assert.equal(done.body.status, "completed_with_exceptions");
      assert.equal((await ana.u.get(`/api/missions/${missionId}`)).body.exceptionNote, "Handover deadline reached; receivers continue under supervision.");
    });

    await t.test("missions never cross spaces", async () => {
      const foreign = await out.u.post("/api/missions", { name: "Probe", experts: [eveId] });
      assert.equal(foreign.status, 400, "a person id from another space is unknown here");
      assert.equal((await out.u.get(`/api/missions/${missionId}`)).status, 404, "another space's mission does not exist for this caller");
      const own = await out.u.post("/api/missions", { name: "Probe", receiverGroups: [g.id] });
      assert.equal(own.status, 400, "a group id from another space is rejected");
    });
  } finally { await h.close(); }
});

test("three domains through one engine: technical (payments), physical (weaving), cultural in Marathi (ghee)", { timeout: 300000 }, async (t) => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const settle = (u, id) => waitFor(async () => { const r = (await u.get(`/api/sessions/${id}`)).body; return DONE.includes(r.status) && !r.processing.pending ? r : null; }, { timeoutMs: 30000 });
    async function missionRun(u, { name, wfName, expert, receivers = [], groups = [], source, language = "en", template }) {
      const wf = (await u.get("/api/workflows")).body.find((w) => w.name === wfName);
      const pid = await personOf(u, expert);
      const ids = [];
      for (const r of receivers) ids.push(await personOf(u, r));
      const m = (await u.post("/api/missions", { name, workflowId: wf.id, templateKey: template, experts: [pid], receivers: ids, receiverGroups: groups, language,
        brief: { objectives: [`${name}: pass on the judgment`], blindSpots: ["What the written instructions get wrong"], acceptance: ["Decides by the signal, not the written step"] } })).body;
      assert.ok(m.id, JSON.stringify(m));
      assert.equal((await u.post(`/api/missions/${m.id}/send`)).status, 200);
      return { m, wf };
    }
    async function captureAs(u, missionId, source, answers) {
      await u.post(`/api/missions/${missionId}/confirm-brief`);
      let s = (await u.post(`/api/missions/${missionId}/capture`, { source })).body;
      assert.ok(s.id, JSON.stringify(s));
      const mods = ["SCREEN", "CAMERA", "MICROPHONE"];
      s = (await u.post(`/api/sessions/${s.id}/consent`, { modalities: mods, clientTime: Date.now() })).body;
      for (const [action, param] of s.sim.script.steps) { const r = (await u.post(`/api/sessions/${s.id}/sim`, { action, param })).body; if (r.status !== "capturing") break; }
      s = await settle(u, s.id);
      for (let i = 0; s.status === "asking" && i < 3; i++) { await u.post(`/api/sessions/${s.id}/answer`, { text: s.sim.script.answers[i] ?? answers }); s = await settle(u, s.id); }
      return s;
    }
    const switchTo = async (u, name) => { const p = (await u.get("/api/samples/people")).body.find((x) => x.display_name.startsWith(name)); await u.post("/api/samples/switch", { personId: p.id }); return u.acceptPolicies(); };

    const work = user(h.app);
    assert.equal((await work.post("/api/samples", { kind: "work" })).status, 200);
    await work.acceptPolicies();
    const group = (await work.get("/api/groups")).body.groups.find((g) => g.name === "Operations-New-Joiners");
    assert.ok(group, "the sample space has a receiver group");

    for (const d of [
      { label: "technical: payments", name: "Month-end payments handover", wfName: "Legacy payment operations", expert: "Dana Reyes", source: "sim:payments-console", template: "retirement" },
      { label: "physical: weaving", name: "Warp tension in humid weather", wfName: "Hand-loom weaving", expert: "Amara", source: "sim:loom-camera", template: "cultural_craft" },
    ]) {
      await t.test(d.label, async () => {
        await switchTo(work, "Alex");
        const expertName = (await work.get("/api/people")).body.find((p) => p.display_name.startsWith(d.expert)).display_name;
        const { m } = await missionRun(work, { ...d, expert: expertName, groups: [group.id] });
        await switchTo(work, d.expert);
        const s = await captureAs(work, m.id, d.source, "Because the value was odd.");
        assert.ok(s.judgmentId, `${d.label}: a judgment was captured`);
        await work.post(`/api/judgments/${s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
        const view = await waitFor(async () => { const r = (await work.get(`/api/missions/${m.id}`)).body; return ["knowledge_review", "transfer_assessment"].includes(r.stage) ? r : null; }, { timeoutMs: 20000 });
        assert.ok(view.knowledge.length >= 1);
        assert.ok(view.participants.filter((p) => p.role === "receiver").length >= 2, "group receivers resolved");
      });
    }

    await t.test("cultural, in Marathi: ghee in a Personal space", async () => {
      const home = user(h.app);
      assert.equal((await home.post("/api/samples", { kind: "living" })).status, 200);
      await home.acceptPolicies();
      const calls = h.fake.calls.length;
      const { m } = await missionRun(home, { name: "अम्माचं तूप", wfName: "Amma's ghee", expert: "Lakshmi", receivers: ["Meera"], language: "mr", template: "cultural_craft" });
      const s = await captureAs(home, m.id, "sim:kitchen-camera", "बेरी सोनेरी झाली की तूप तयार.");
      assert.equal(s.language, "mr", "the mission's language becomes the session's content language");
      const q = h.fake.calls.slice(calls).find((c) => c.op === "generateQuestion");
      assert.match(q.prompt, /Marathi \(मराठी/);
      assert.match(q.prompt, /KT MISSION BRIEF/);
      assert.ok(s.judgmentId);
      const v = (await home.get(`/api/missions/${m.id}`)).body;
      assert.equal(v.language, "mr");
      assert.ok(v.requirements.length >= 2);
    });
  } finally { await h.close(); }
});

test("storage: identical bytes are stored once per space; deleting one copy keeps the other; the report is measured", { timeout: 120000 }, async () => {
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const a = await account(h, "st@s.test", "Store Corp");
    const meUser = (await a.u.get("/api/admin/members")).body[0].user_id;
    await a.u.post(`/api/admin/members/${meUser}/roles`, { roles: ["ORG_OWNER", "ORG_ADMIN", "WORKFLOW_OWNER", "EXPERT"] });
    await a.u.acceptPolicies();
    const wf = (await a.u.post("/api/workflows", { name: "Flow", kind: "software", modalities: { screen: true, documents: true }, captureSources: ["live:screen"], documents: [{ title: "SOP", text: DOC }] })).body;
    await waitFor(async () => (await a.u.get(`/api/workflows/${wf.id}`)).body.status === "active");
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const s = (await a.u.post("/api/sessions", { workflowId: wf.id, source: "live:screen" })).body;
      await a.u.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN"], clientTime: Date.now() });
      await a.u.call("POST", `/api/sessions/${s.id}/media`, PNG(99), { "content-type": "image/png", "x-modality": "SCREEN", "x-kind": "frame", "x-captured-at": String(Date.now()) });
      sessions.push(s.id);
    }
    const rows = await h.s.db.system((q) => q("SELECT id, session_id, storage_key, dedup_of FROM media_assets WHERE session_id = ANY($1::uuid[]) ORDER BY created_at", [sessions]));
    assert.equal(rows.length, 2, "each session keeps its own record");
    assert.equal(rows[0].storage_key, rows[1].storage_key, "one stored object");
    assert.equal(rows[1].dedup_of, rows[0].id);
    const rep = (await a.u.get("/api/storage/report")).body;
    assert.ok(rep.layers.A.reusedBytes > 0 && rep.layers.A.reusedUploads === 1);
    assert.ok("B" in rep.layers && "C" in rep.layers && "D" in rep.layers);
    assert.match(rep.baseline.note, /computed baseline/);
    // Delete the first session's moment: the object must survive for the second session.
    await waitFor(async () => (await a.u.get(`/api/sessions/${sessions[0]}`)).body.observations.length > 0, { timeoutMs: 15000 });
    const obs = (await a.u.get(`/api/sessions/${sessions[0]}`)).body.observations[0];
    assert.equal((await a.u.del(`/api/observations/${obs.id}`)).status, 200);
    assert.ok(await h.s.storage.get(rows[0].storage_key), "still referenced by the other session: not deleted");
    const obs2 = await waitFor(async () => (await a.u.get(`/api/sessions/${sessions[1]}`)).body.observations[0], { timeoutMs: 15000 });
    await a.u.del(`/api/observations/${obs2.id}`);
    assert.equal(await h.s.storage.get(rows[0].storage_key), null, "last reference gone: deleted");
    // A learner (no cost access) cannot read the report.
    const l = await account(h, "sl@s.test", "L home");
    await inviteAndAccept(a.u, l, ["LEARNER"]);
    assert.equal((await l.u.get("/api/storage/report")).status, 403);
  } finally { await h.close(); }
});
