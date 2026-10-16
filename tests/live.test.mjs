// Live Moti → Work Map → tutor, offline: a scripted fake Gemini Live session behind the real WebSocket relay, the real
// HTTP stack, PostgreSQL (PGlite) with RLS, and the job runner. Also: redaction of personal data in spoken turns.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, user, waitFor, PNG } from "./helpers.mjs";
import { setLiveFactory } from "../src/ai/gemini.mjs";
import { redactText } from "../src/platform/redact.mjs";

/** A fake `client.live.connect`: records what the relay sends and lets the test speak as the model. */
function fakeLive() {
  const sessions = [];
  const client = { live: { connect: async ({ config, callbacks }) => {
    const s = { config, callbacks, audio: 0, video: 0, texts: [], toolResponses: [], closed: false,
      sendRealtimeInput(x) { if (x.audio) s.audio++; if (x.video) s.video++; },
      sendClientContent(x) { s.texts.push(x.turns[0].parts[0].text); },
      sendToolResponse(x) { s.toolResponses.push(x); },
      close() { s.closed = true; },
      // The model's side: Moti says something (transcription + a turn end), or calls a tool.
      say(text) { callbacks.onmessage({ serverContent: { outputTranscription: { text }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } } }); callbacks.onmessage({ serverContent: { turnComplete: true } }); },
      hear(text) { callbacks.onmessage({ serverContent: { inputTranscription: { text } } }); },
      tool(name, args) { callbacks.onmessage({ toolCall: { functionCalls: [{ id: `c${s.toolResponses.length}`, name, args }] } }); } };
    sessions.push(s);
    await new Promise((r) => setTimeout(r, 120)); // a real connect takes time: the browser may already be talking
    setTimeout(() => callbacks.onopen(), 0);
    return s;
  } } };
  return { sessions, factory: () => client };
}

async function socket(h, u, query) {
  const got = []; let closed;
  // Listeners attach before the upgrade completes: the server may answer (or refuse) immediately.
  const ws = await h.app.injectWS(`/api/live?${query}`, { socket: { remoteAddress: "127.0.0.1" }, headers: { cookie: u.cookie(), origin: "http://localhost:3200" } },
    { onInit: (w) => { w.on("message", (d) => got.push(JSON.parse(String(d)))); closed = new Promise((r) => w.on("close", (code) => r(code))); } });
  return { ws, got, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

test("redaction masks personal data in spoken turns but keeps business numbers", () => {
  const r = redactText("Mail asha@example.com or call +91 98765 43210, card 4111 1111 1111 1111, Aadhaar 2345 6789 0123. Invoice INV-20431 for 52,000.");
  assert.doesNotMatch(r.text, /asha@example\.com|98765|4111 1111|2345 6789 0123/);
  assert.match(r.text, /INV-20431/); assert.match(r.text, /52,000/);
  assert.ok(r.found.email && r.found.card && r.found.phone);
  assert.equal(redactText("4111 1111 1111 1112 is not a valid card").found.card, undefined, "a number that fails the Luhn check is not a card");
  // Cases found by the public-data evaluation (docs/EVALUATION.md).
  const b = redactText("PO 4500012345, txn 20231015001, invoice INV-20431, 12.10.2026 at 10:30").text;
  assert.match(b, /4500012345/); assert.match(b, /20231015001/); assert.match(b, /12\.10\.2026/); // business numbers stay readable
  for (const pii of ["SSN132-65-3444", "+234 693-143.6710", "756.2808.9893", "NO3041901004431", "call 9876543210"]) assert.notEqual(redactText(pii).text, pii, pii);
});

test("live capture → Work Map → debrief → confirm → export → tutor", { timeout: 120000 }, async (t) => {
  const live = fakeLive();
  setLiveFactory(live.factory);
  const h = await harness({ env: { SIGNUP_RATE_MAX: "500" } });
  try {
    const u = user(h.app);
    await u.signup("ravi@t.test", "Ravi Traders");
    const start = await u.post("/api/live/start", { kind: "screen", name: "Month-end supplier invoices", language: "en" });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const sid = start.body.sessionId;

    await t.test("Moti will not start without microphone consent, nor for another person or a foreign origin", async () => {
      const c = await socket(h, u, `mode=capture&session=${sid}&language=en`);
      assert.equal(await c.closed, 1008);
      assert.match(c.got[0].message, /microphone/);
      const other = user(h.app); await other.signup("eve@t.test", "Eve Co");
      const o = await socket(h, other, `mode=capture&session=${sid}&language=en`);
      assert.equal(await o.closed, 1008);
      let code;
      await h.app.injectWS(`/api/live?mode=capture&session=${sid}`, { socket: { remoteAddress: "127.0.0.1" }, headers: { cookie: u.cookie(), origin: "https://evil.example" } }, { onInit: (w) => { code = new Promise((r) => w.on("close", r)); } });
      code = await code;
      assert.equal(code, 1008, "a cross-site page cannot open Moti with the person's cookie");
      assert.equal(live.sessions.length, 0, "no model session was opened for refused requests");
    });

    await u.post(`/api/sessions/${sid}/consent`, { modalities: ["SCREEN", "MICROPHONE"], clientTime: Date.now() });

    await t.test("capture: audio and changed frames reach the model, speech is stored redacted, off the record stops everything", async () => {
      const c = await socket(h, u, `mode=capture&session=${sid}&language=en`);
      await waitFor(() => c.got.some((m) => m.t === "ready"));
      const m = live.sessions.at(-1);
      assert.deepEqual(m.config.responseModalities, ["AUDIO"]);
      assert.ok(m.config.contextWindowCompression?.slidingWindow, "long sessions degrade gracefully instead of overflowing");
      assert.match(m.config.systemInstruction, /natural pause/i);
      c.send({ t: "audio", d: "AAAA" });
      c.send({ t: "frame", d: PNG(3).toString("base64"), mod: "SCREEN", at: Date.now() });
      await waitFor(() => m.audio === 1 && m.video === 1);
      m.say("Why did you stop at that invoice?");
      await waitFor(() => c.got.some((x) => x.t === "moti"));
      assert.ok(c.got.some((x) => x.t === "audio"), "Moti's voice is relayed");
      m.hear("anything over fifty thousand I hold, mail me at ravi@example.com");
      c.send({ t: "offrecord", on: true });
      await waitFor(() => c.got.some((x) => x.t === "status" && x.offRecord === true));
      c.send({ t: "audio", d: "AAAA" }); c.send({ t: "frame", d: PNG(4).toString("base64"), mod: "SCREEN", at: Date.now() });
      c.send({ t: "offrecord", on: false });
      await waitFor(() => c.got.some((x) => x.t === "status" && x.offRecord === false));
      assert.equal(m.audio, 1, "nothing is sent to the model off the record"); assert.equal(m.video, 1);
      c.send({ t: "done" });
      await waitFor(() => c.got.some((x) => x.t === "status" && x.phaseDone === "capture"));
      assert.ok(m.closed);
      const rows = await h.s.db.system((q) => q("SELECT text, security_flags FROM observations WHERE session_id = $1 AND modality = 'MICROPHONE'", [sid]));
      assert.equal(rows.length, 1);
      assert.doesNotMatch(rows[0].text, /ravi@example\.com/); assert.match(rows[0].text, /fifty thousand/); assert.ok(JSON.stringify(rows[0].security_flags).includes("redacted:email"));
      const [s] = await h.s.db.system((q) => q("SELECT off_record FROM expert_sessions WHERE id = $1", [sid]));
      assert.equal(s.off_record.length, 1); assert.ok(s.off_record[0].to);
    });

    let map;
    await t.test("the Work Map cites screen moments and the expert's own words; unverified quotes are marked AI-inferred", async () => {
      map = await waitFor(async () => { const r = await u.get(`/api/maps/${sid}`); return r.body.steps && !r.body.building ? r.body : null; });
      assert.equal(map.status, "draft");
      assert.equal(map.steps.length, 2);
      const [a, b] = map.steps;
      assert.ok(a.moments.length === 1 && a.moments[0].mediaId, "step 1 links the screen frame; the unknown event id was dropped");
      assert.equal(a.reason.status, "EXPERT_STATED"); assert.equal(a.guardrails[0].kind, "stop_and_ask");
      assert.equal(b.reason.status, "AI_INFERRED"); assert.equal(b.reason.quote, "");
      assert.equal(map.unclear.length, 1);
      const inbox = (await u.get("/api/inbox")).body;
      assert.ok(JSON.stringify(inbox).includes(`#/map/${sid}`), "the expert is told the map is ready, with a link to it");
    });

    await t.test("not confirmed: no practice, no export", async () => {
      assert.equal((await u.get(`/api/maps/${sid}/export`)).status, 409);
    });

    await t.test("debrief: Moti asks what is unclear, the answers rebuild the map, and the expert confirms it", async () => {
      const c = await socket(h, u, `mode=debrief&session=${sid}&language=mr`);
      c.send({ t: "text", text: "For a new supplier I always call them first." }); // before the model session is open
      await waitFor(() => c.got.some((m) => m.t === "ready"));
      const m = live.sessions.at(-1);
      assert.match(m.config.systemInstruction, /new/i, "the unclear question is in the debrief brief");
      await waitFor(() => c.got.some((x) => x.t === "you"));
      assert.ok(m.texts.some((x) => /call them first/.test(x)), "words sent while connecting reach the model, not lost");
      m.say("And when the supplier is known?");
      c.send({ t: "done" });
      await waitFor(() => c.got.some((x) => x.t === "status" && x.phaseDone === "debrief"));
      map = await waitFor(async () => { const r = await u.get(`/api/maps/${sid}`); return r.body.status === "debriefed" && !r.body.building ? r.body : null; });
      assert.equal(map.version, 2);
      assert.equal((await u.post(`/api/maps/${sid}/confirm`, {})).status, 200);
    });

    await t.test("confirmed: agent-ready export carries the stop points", async () => {
      const md = await u.get(`/api/maps/${sid}/export`);
      assert.equal(md.status, 200);
      assert.match(md.body, /STOP AND ASK A PERSON/);
      const js = await u.get(`/api/maps/${sid}/export?format=json`);
      assert.ok(Array.isArray(js.body.steps));
    });

    await t.test("tutor: Moti teaches from the confirmed map, replays the expert's moment, and records the result", async () => {
      const c = await socket(h, u, `mode=tutor&session=${sid}&language=hi`);
      await waitFor(() => c.got.some((m) => m.t === "ready"));
      const m = live.sessions.at(-1);
      assert.equal(m.config.tools, undefined, "Live only talks; decisions come from the structured judge");
      assert.match(m.config.systemInstruction, /would stop here/);
      c.send({ t: "text", text: "I'll post this 75,000 invoice now." });
      await waitFor(() => c.got.some((x) => x.t === "you"));
      m.say("Asha would stop here. Why do you think?");
      await waitFor(() => c.got.some((x) => x.t === "moment"));
      assert.ok(c.got.find((x) => x.t === "moment").mediaId, "the expert's screen moment is replayed");
      const iv = c.got.find((x) => x.t === "status" && x.intervention).intervention;
      assert.equal(iv.stepId, "s1");
      assert.match(iv.guardrail, /controller/i, "the guardrail comes from the confirmed map, not from the model");
      m.say("Good start. Practise the limit check.");
      await waitFor(() => c.got.some((x) => x.t === "status" && x.finished));
      const fin = c.got.find((x) => x.t === "status" && x.finished).finished;
      assert.deepEqual(fin.practise, ["s1"]); assert.deepEqual(fin.mastered, ["s2"], "unknown step ids are dropped");
      assert.match(fin.summary, /Practise the limit check/, "the summary is what Moti said aloud");
      const judged = h.fake.calls.filter((x) => x.op === "judgeTutorTurn");
      assert.ok(judged.length >= 2 && /75,000/.test(judged[0].prompt), "the judge sees what the learner said");
      c.ws.close();
    });

    await t.test("another space cannot read the map", async () => {
      const other = user(h.app); await other.signup("mal@t.test", "Mal Co");
      assert.equal((await other.get(`/api/maps/${sid}`)).status, 404);
    });
  } finally { setLiveFactory(null); await h.close(); }
});

test("judge accounts: shown on sign-in, one real space each, idempotent, cannot be locked out", { timeout: 60000 }, async () => {
  const { ensureJudgeAccounts } = await import("../src/domain/seed.mjs");
  const h = await harness({ env: { JUDGE_ACCOUNTS: "1", SIGNUP_RATE_MAX: "500" } });
  try {
    const anon = user(h.app);
    const cfg = (await anon.get("/api/auth/config")).body;
    assert.deepEqual(cfg.judges.map((j) => j.key), ["work", "culture"]);
    for (const j of cfg.judges) {
      const u = user(h.app);
      for (let i = 0; i < 7; i++) await u.post("/api/auth/login", { email: j.email, password: "wrong-password-123" });
      assert.equal((await u.post("/api/auth/login", { email: j.email, password: j.password })).status, 200, "wrong guesses by others never lock judges out");
      const me = await u.acceptPolicies();
      assert.equal(me.org.experience, j.key === "work" ? "work" : "living");
      assert.ok(me.roles.includes("EXPERT") && me.roles.includes("LEARNER"));
      assert.equal((await u.get("/api/maps")).body.length, 0, "the space starts empty: no pre-filled data");
    }
    await ensureJudgeAccounts({ db: h.s.db, identity: h.s.identity, cfg: h.cfg });
    const n = await h.s.db.system((q) => q("SELECT count(*)::int AS n FROM organizations WHERE slug LIKE 'judges-%'"));
    assert.equal(n[0].n, 2, "restarts do not duplicate the spaces");
    const off = await harness();
    try { assert.deepEqual((await user(off.app).get("/api/auth/config")).body.judges, [], "off unless JUDGE_ACCOUNTS=1"); } finally { await off.close(); }
  } finally { await h.close(); }
});
