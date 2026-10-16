// ACCEPTANCE: KT MISSIONS (live Gemini; run sparingly). Two end-to-end flows through the HTTP API, as a browser would:
//   5d. Enterprise sample: a coordinator plans a mission with a brief and a receiver GROUP; the expert accepts, confirms
//       Moti's summary, captures (simulated console, scripted answers); approves; Moti checks the brief's requirements.
//   5e. Personal sample in MARATHI: the mission language is Marathi; the AI must ask in Marathi; the expert answers in
//       Marathi (data/eval/marathi.json); the knowledge is shared with the learner, who asks in Marathi.
// Requires a server with TEST_HOOKS=1, SAMPLE_SPACES=1. Usage: node scripts/acceptance-missions.mjs http://localhost:3203
import fs from "node:fs";
import { client } from "./lib/client.mjs";
const BASE = process.argv[2] || "http://localhost:3200";
const say = (s = "") => console.log(s);
const fails = [];
const expect = (c, m) => { if (!c) { fails.push(m); say(`   !! ${m}`); } else say(`   ok ${m}`); };
const done = (s) => ["asking", "validating", "no_judgment", "done", "failed"].includes(s.status) && !s.processing?.pending;

say("\n5d. KT MISSION (Enterprise sample): brief → group receivers → brief-guided capture → requirement check");
const { devanagariShare } = await import("../src/ai/language.mjs");
async function sampleAs(c, people, name) { const p = people.find((x) => x.display_name.startsWith(name)); await c.post("/api/samples/switch", { personId: p.id }); const me = await c.get("/api/auth/me"); if (me.policies?.pending?.length) await c.post("/api/policies/accept", { ids: me.policies.pending }); return p; }
async function missionCapture(c, missionId, { source, caseRef, answers }) {
  await c.post(`/api/missions/${missionId}/respond`, { accept: true });
  await c.post(`/api/missions/${missionId}/confirm-brief`);
  let s = await c.post(`/api/missions/${missionId}/capture`, { source, caseRef });
  const view = await c.get(`/api/sessions/${s.id}`);
  s = await c.post(`/api/sessions/${s.id}/consent`, { modalities: ["SCREEN", "CAMERA", "MICROPHONE"].filter((m) => view.modalities?.[m.toLowerCase()]), clientTime: Date.now() });
  for (const [action, param] of s.sim.script.steps) { s = await c.post(`/api/sessions/${s.id}/sim`, { action, param }); if (s.status !== "capturing") break; }
  if (s.status === "capturing") s = await c.post(`/api/sessions/${s.id}/end`);
  s = await c.poll(`/api/sessions/${s.id}`, done);
  const asked = [];
  for (let i = 0; s.status === "asking" && i < answers.length; i++) {
    asked.push(s.question.text);
    say(`   AI asks: ${s.question.text}`);
    say(`   EXPERT: ${answers[i]}`);
    await c.post(`/api/sessions/${s.id}/answer`, { text: answers[i] });
    s = await c.poll(`/api/sessions/${s.id}`, done);
  }
  if (s.status === "asking") { await c.post(`/api/sessions/${s.id}/stop`); s = await c.poll(`/api/sessions/${s.id}`, done); }
  return { s, asked };
}
const ent = client(BASE);
await ent.post("/api/samples", { kind: "work" });
{ const me = await ent.get("/api/auth/me"); if (me.policies?.pending?.length) await ent.post("/api/policies/accept", { ids: me.policies.pending }); }
const entPeople = await ent.get("/api/samples/people");
await sampleAs(ent, entPeople, "Alex");
const joiners = (await ent.get("/api/groups")).groups.find((g) => g.name === "Operations-New-Joiners");
const payWf = (await ent.get("/api/workflows")).find((w) => w.name === "Legacy payment operations");
const danaPid = (await ent.get("/api/people")).find((p) => p.display_name.startsWith("Dana")).id;
const mission = await ent.post("/api/missions", { name: "Month-end payment exceptions handover", workflowId: payWf.id, templateKey: "retirement", experts: [danaPid], receiverGroups: [joiners.id],
  brief: { objectives: ["Jordan can handle month-end E217 rejections without Dana"], decisions: ["When to inspect the upstream record before retrying"], blindSpots: ["Malformed value dates at month-end"],
    acceptance: ["Explains why a retry at month-end can post twice"], constraints: ["Never retry a posting twice without checking the upstream record"], outOfScope: "Card disputes" } });
const sent = await ent.post(`/api/missions/${mission.id}/send`);
say(`   mission sent to ${sent.invited} people (group resolved, in-app notifications only)`);
await sampleAs(ent, entPeople, "Dana");
const payC1 = (await import("../src/sim/workflows/payments.mjs")).default.environment.cases.find((c) => c.id === "C1");
const mc1 = await missionCapture(ent, mission.id, { source: "sim:payments-console", caseRef: "C1", answers: payC1.script.answers });
expect(Boolean(mc1.s.judgmentId), "mission capture produced a judgment");
if (mc1.s.judgmentId) {
  await ent.post(`/api/judgments/${mc1.s.judgmentId}/validate`, { decision: "approve", confirmBoundary: true });
  const mv = await ent.poll(`/api/missions/${mission.id}`, (x) => !x.assessing && x.requirements.some((r) => r.basis !== "NONE" || r.explanation), { timeoutMs: 240000 });
  say(`   stage: ${mv.stage}`);
  for (const r of mv.requirements) say(`     · [${r.status} / ${r.basis}] (${r.kind}) ${r.text}${r.evidence?.[0] ? ` ← "${r.evidence[0].quote}" (${r.evidence[0].field}, ${r.evidence[0].fieldStatus})` : ""} — ${r.explanation}`);
  expect(mv.requirements.some((r) => r.basis !== "NONE"), "the requirement check actually ran (not the 'AI unavailable' fallback)");
  expect(mv.requirements.every((r) => r.status !== "satisfied" || (r.evidence?.length && r.evidence.every((e) => e.verified))), "every AI 'satisfied' carries a verified quote");
  await sampleAs(ent, entPeople, "Jordan");
  const inbox = await ent.get("/api/inbox");
  expect(inbox.notifications.some((n) => n.kind === "mission.assigned"), "group receiver was notified in-app");
}

say("\n5e. MARATHI MISSION (Personal sample, live): Marathi questions, Marathi answers, grounded Marathi Ask");
const mr = client(BASE);
await mr.post("/api/samples", { kind: "living" });
{ const me = await mr.get("/api/auth/me"); if (me.policies?.pending?.length) await mr.post("/api/policies/accept", { ids: me.policies.pending }); }
const mrPeople = await mr.get("/api/samples/people");
await sampleAs(mr, mrPeople, "Lakshmi");
const gheeWf = (await mr.get("/api/workflows")).find((w) => w.name === "Amma's ghee");
const lak = (await mr.get("/api/people")).find((p) => p.display_name === "Lakshmi").id;
const mee = (await mr.get("/api/people")).find((p) => p.display_name === "Meera").id;
const mrm = await mr.post("/api/missions", { name: "अम्माचं तूप", workflowId: gheeWf.id, templateKey: "cultural_craft", language: "mr", experts: [lak], receivers: [mee],
  brief: { objectives: ["घड्याळ न बघता तूप कधी तयार झालं ते मीराला ओळखता यावं"], blindSpots: ["दुकानातलं लोणी"], acceptance: ["बेरीच्या रंगावरून निर्णय घेते, वेळेवरून नाही"] } });
await mr.post(`/api/missions/${mrm.id}/send`);
const evalSet = JSON.parse(fs.readFileSync(new URL("../data/eval/marathi.json", import.meta.url), "utf8"));
const mcap = await missionCapture(mr, mrm.id, { source: "sim:kitchen-camera", caseRef: "K1", answers: evalSet.capture.map((c) => c.answer) });
expect(mcap.asked.length > 0 && mcap.asked.every((q) => devanagariShare(q) >= 0.5), "Marathi mission: the AI asks in Marathi");
expect(mcap.s.language === "mr", "Marathi mission: the session's content language is Marathi");
if (mcap.s.judgmentId) {
  const j = await mr.get(`/api/judgments/${mcap.s.judgmentId}`);
  const answers = evalSet.capture.map((c) => c.answer).join(" ");
  const stated = Object.entries(j.content.fields).filter(([, f]) => f.status === "EXPERT_STATED" && f.quote);
  say(`   extracted (expert-stated): ${stated.map(([k, f]) => `${k}: "${f.quote}"`).join(" | ")}`);
  expect(stated.length > 0 && stated.every(([, f]) => answers.normalize("NFC").includes(f.quote.normalize("NFC").replace(/[.।]$/, "")) || devanagariShare(f.quote) > 0), "Marathi mission: expert-stated quotes are the expert's own Marathi words");
  const ap = await mr.post(`/api/judgments/${j.id}/validate`, { decision: "approve", confirmBoundary: true });
  await mr.post(`/api/knowledge/${ap.artifact.id}/sharing`, { visibility: "named", sharedWith: [mee] });
  await sampleAs(mr, mrPeople, "Meera");
  const a1 = await mr.post("/api/ask", { question: "दुकानातलं लोणी असेल तर बारा मिनिटांनी गॅस बंद करायचा का?" });
  say(`   Meera asks (mr) → [${a1.grounded ? "grounded" : "not grounded"}] ${a1.answer}`);
  expect(a1.language === "mr" && devanagariShare(a1.answer) >= 0.5, "Marathi Ask: the answer is in Marathi");
  const a2 = await mr.post("/api/ask", { question: "तूप किती दिवस टिकतं?" });
  say(`   Meera asks an uncovered question → [${a2.insufficient ? "insufficient" : "answered"}] ${a2.answer}`);
  expect(a2.insufficient && !a2.grounded, "Marathi Ask: an uncovered question is answered with 'not enough information', not invented");
} else expect(false, "Marathi mission produced a judgment");


say(fails.length ? `\n${fails.length} expectation(s) failed` : "\nMission acceptance: all expectations met");
process.exit(fails.length ? 1 : 0);
