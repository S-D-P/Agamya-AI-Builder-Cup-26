// Test harness: real PostgreSQL engine (PGlite, in memory), in-memory object storage, a scripted fake model, and the
// real Fastify stack exercised through inject(). No network, deterministic.
import { getConfig } from "../src/config.mjs";
import { buildServices, buildServer } from "../src/app.mjs";
import { createLogger } from "../src/platform/logger.mjs";

/** Fake Gemini transport. Routes by the response schema's shape; tests can override any route. */
export function fakeModel() {
  const overrides = {};
  const calls = [];
  const route = (schema) => {
    const p = schema?.properties ?? {};
    if (p.steps && p.unclear) return "buildWorkMap";
    if (p.intervened && p.finished) return "judgeTutorTurn";
    if (p.verdict && p.guardrailIndex) return "checkAction";
    if (p.script && Object.keys(p).length === 1) return "narrateWorkMap";
    if (p.candidates && p.actionDiffersFromProcedure) return "detectJudgment";
    if (p.results) return "assessRequirements";
    if (p.gaps) return "detectGaps";
    if (p.resolves && p.field) return "integrateGapAnswer";
    if (p.citations && p.insufficient) return "answerFromKnowledge";
    if (p.contradicts) return "contradictsKnowledge";
    if (p.question && p.intent) return "generateQuestion";
    if (p.fields && p.defaultBehavior) return "extractKnowledge";
    if (p.boundaryQuote) return "findBoundary";
    if (p.gapType) return "detectConflict";
    if (p.relation && p.hiddenVariableHypothesis) return "reconcileExperts";
    if (p.domainSummary) return "understandWorkflow";
    if (p.stateReadings) return "interpretObservation";
    if (p.transcript) return "transcribe";
    if (p.ruleOption) return "generateScenarios";
    if (p.message) return "tutor";
    if (p.errorType) return "evaluateLearner";
    return "unknown";
  };
  const field = (value, status = "EXPERT_STATED", quote = "") => ({ value, status, quote, eventIds: [] });
  // Content of a fenced data block by its label (the prompt fences each block as <data-xxxx …>…</data-xxxx>).
  const block = (prompt, label) => { const i = prompt.indexOf(`## ${label}`); if (i < 0) return ""; const start = prompt.indexOf("\n", prompt.indexOf("\n", i) + 1) + 1; const end = prompt.indexOf("</data-", start); return prompt.slice(start, end < 0 ? undefined : end).trim(); };
  const defaults = {
    understandWorkflow: () => ({ domainSummary: "Test domain.", procedures: [{ title: "Main", appliesWhen: "always", steps: ["Do the documented thing."], defaultDecision: "Do the documented thing" }], decisionPoints: [], likelyTacitAreas: [], riskAreas: [], vocabulary: [], suspiciousInstructions: [] }),
    interpretObservation: () => ({ observed: "screen shows a value", actionDetected: "", stateReadings: [{ name: "value", value: "1" }], changeType: "workflow", confidence: 0.9, containsInstructionsToAI: false }),
    transcribe: () => ({ transcript: "Because the value was odd, only when it is odd.", confidence: 0.9, speechPresent: true, incomplete: false }),
    detectJudgment: ({ prompt }) => {
      const ids = [...prompt.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]);
      const last = ids.at(-1) ?? "e1";
      return { events: ids.map((id) => ({ eventId: id, label: "DEVIATION", note: "" })), actionDiffersFromProcedure: true,
        candidates: [{ eventIds: [last], type: "deviation", action: "did something else", outcome: "done", alternatives: ["the documented thing"], choiceEvidence: [last], isJudgment: true, judgmentBasis: "deviation_from_procedure", summary: "Expert did something else.", salience: 0.9, changesWhatIsDone: true, reasonInferableFromObservation: false, matchesKnowledgeId: "", contradictsKnowledgeId: "", whyAsk: "differs" }] };
    },
    contradictsKnowledge: () => ({ contradicts: false, knowledgeId: "", explanation: "", eventIds: [] }),
    generateQuestion: () => ({ question: "What made you choose that?", intent: "why", alternates: [] }),
    extractKnowledge: () => ({ title: "Test judgment", observedBehavior: "did something else", defaultBehavior: { text: "Do the documented thing", source: "DOCUMENTED_PROCEDURE" }, ruleOrJudgment: "judgment_call", confidence: 0.9,
      fields: { context: field("ctx", "AI_INFERRED"), observation: field("odd value", "AI_INFERRED"), decision: field("did something else", "AI_INFERRED"), reason: field("the value was odd", "EXPERT_STATED", "the value was odd"), condition: field("value is odd", "AI_INFERRED"), exception: field("only when it is odd", "EXPERT_STATED", "only when it is odd"), boundary: field("odd vs even", "AI_INFERRED"), risk: field("", "INSUFFICIENT_EVIDENCE"), expectedOutcome: field("", "INSUFFICIENT_EVIDENCE") } }),
    findBoundary: () => ({ default: { when: "value even", decision: "Do the documented thing", source: "DOCUMENTED_PROCEDURE" }, exception: { when: "value odd", decision: "do something else" }, boundaryCondition: "parity", counterfactual: "even → documented", statedByExpert: true, boundaryQuote: "only when it is odd", status: "confirmed", hypothesis: "", nextQuestionIntent: "none" }),
    detectConflict: () => ({ gapType: "undocumented_exception", analysis: "Expert behaviour differs from the documented procedure. The explanation suggests an exception.", severity: "medium" }),
    reconcileExperts: () => ({ relation: "unrelated", sharedSituation: "", hiddenVariableHypothesis: "", distinguishingFacts: [], questionForExperts: "", resolvedByExpertsOwnWords: false, resolution: "", confidence: 0.5 }),
    generateScenarios: () => ({ options: ["A", "B", "C"], ruleOption: "A", defaultOption: "B", flippedCondition: "parity", criteria: ["Checks whether the value is odd", "Knows the documented step applies when it is even"],
      apply: { title: "t1", facts: [{ name: "value", value: "3" }], narrative: "n", keyOption: "A" }, counterfactual: { title: "t2", facts: [{ name: "value", value: "4" }], narrative: "n", keyOption: "B" },
      boundary: { title: "t3", facts: [{ name: "value", value: "5" }], narrative: "n", keyOption: "A" }, insufficient: { title: "t4", facts: [{ name: "value", value: "unreadable" }], narrative: "n", missingInformation: "the value cannot be read" } }),
    detectGaps: ({ prompt }) => {
      const id = [...prompt.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]).at(-1) ?? "e1";
      return { gaps: [{ kind: "prerequisite", field: "context", missing: "What must be checked before starting.", whyItMatters: "A newcomer would skip it.", evidenceEventIds: [id], question: "Before you started, what did you check first on the screen?" },
        { kind: "signal", field: "none", missing: "Uncited claim", whyItMatters: "x", evidenceEventIds: ["e999"], question: "This has no real evidence and must be dropped?" }] };
    },
    integrateGapAnswer: ({ prompt }) => {
      const answer = block(prompt, "THE EXPERT'S ANSWER (verbatim)");
      return { field: "context", value: "Check the value first", valueEn: "", quote: answer.split(/[.!?]/)[0], resolves: true, explanation: "Adds the prerequisite." };
    },
    answerFromKnowledge: ({ prompt }) => {
      const q = block(prompt, "LEARNER'S QUESTION");
      if (/weather|हवामान/i.test(q)) return { language: /[ऀ-ॿ]/.test(q) ? "mr" : "en", answer: "Not covered.", grounded: false, insufficient: true, needsClarification: false, clarifyingQuestion: "", citations: [] };
      if (/invent/i.test(q)) return { language: "en", answer: "Confident but made up.", grounded: true, insufficient: false, needsClarification: false, clarifyingQuestion: "", citations: [{ itemId: "k1", quote: "words that appear nowhere" }] };
      return { language: /[ऀ-ॿ]/.test(q) ? "mr" : "en", answer: /[ऀ-ॿ]/.test(q) ? "मूल्य विषम असेल तेव्हाच." : "Only when the value is odd.", grounded: true, insufficient: false, needsClarification: false, clarifyingQuestion: "", citations: [{ itemId: "k1", quote: "only when it is odd" }] };
    },
    // r1: honest citation of an expert-stated field → satisfied. r2: claims satisfied with a quote that is not in the
    // knowledge → must be downgraded. Everything else unresolved.
    assessRequirements: ({ prompt }) => ({ results: [...prompt.matchAll(/\[(r\d+)\]/g)].map((m) => m[1]).map((id) =>
      id === "r1" ? { requirementId: id, status: "satisfied", itemId: "k1", field: "reason", quote: "the value was odd", explanation: "The expert explains why." }
      : id === "r2" ? { requirementId: id, status: "satisfied", itemId: "k1", field: "reason", quote: "a sentence nobody said", explanation: "Claimed." }
      : { requirementId: id, status: "unresolved", explanation: "Not covered yet." }) }),
    tutor: () => ({ message: "What do you notice about the value here?" }),
    narrateWorkMap: ({ prompt }) => ({ script: `First, check the amount. Asha says: "anything over fifty thousand I hold". ${/Hindi/.test(prompt) ? "(hi)" : ""}` }),
    // Over the limit → STOP at s1's guardrail; "invent" → a STOP with no real guardrail (must be downgraded); weather → not covered.
    checkAction: ({ prompt }) => {
      const a = block(prompt, "PROPOSED ACTION");
      if (/weather/i.test(a)) return { verdict: "NOT_COVERED", stepId: "", guardrailIndex: -1, explanation: "The map does not cover this." };
      if (/invent/i.test(a)) return { verdict: "STOP", stepId: "s2", guardrailIndex: 5, explanation: "Made up." };
      if (/75,000|over the limit/i.test(a)) return { verdict: "STOP", stepId: "s1", guardrailIndex: 0, explanation: "Above the limit the controller decides." };
      return { verdict: "PROCEED", stepId: "s2", guardrailIndex: -1, explanation: "Routine posting." };
    },
    // The tutor's words decide: "would stop here" is a stop at s1 (with the replay); "Practise" ends the session.
    judgeTutorTurn: ({ prompt }) => {
      const moti = block(prompt, "THE TUTOR (MOTI) JUST SAID");
      const stop = /would stop here/i.test(moti), done = /practise/i.test(moti);
      return { intervened: stop, stepId: stop ? "s1" : "", showMoment: stop, finished: done, mastered: done ? ["s2", "s99"] : [], practise: done ? ["s1"] : [] };
    },
    // Step 1 cites the latest screen event and a verbatim phrase; step 2 claims a quote nobody said (must become AI-inferred).
    buildWorkMap: ({ prompt }) => {
      const ev = [...prompt.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]).at(-1) ?? "e1";
      return { title: "Supplier invoices", steps: [
        { title: "Check the amount", eventIds: [ev, "e999"], action: "Opened the invoice", decision: "Hold invoices over the limit", isJudgment: true,
          reason: { text: "Large amounts need a second look", quote: "anything over fifty thousand I hold" }, guardrails: [{ kind: "stop_and_ask", text: "Ask the controller above the limit", quote: "anything over fifty thousand I hold" }] },
        { title: "Post the rest", eventIds: [], action: "Posted", decision: "Post", isJudgment: false, reason: { text: "Routine", quote: "words never spoken" }, guardrails: [] }],
        unclear: [{ question: "What do you do when the supplier is new?", stepIndex: 0, why: "Not seen" }] };
    },
    evaluateLearner: () => ({ namedCondition: true, namedReason: true, errorType: "none", boundaryUnderstood: true, feedback: "ok" }),
  };
  const adapter = {
    name: "fake",
    async generate(req) {
      if (req.config?.responseModalities?.includes("AUDIO")) return { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 50 } };
      const prompt = req.contents[0].parts.at(-1).text;
      const op = route(req.config.responseJsonSchema);
      calls.push({ op, prompt, system: req.config.systemInstruction, media: req.contents[0].parts.length - 1 });
      const fn = overrides[op] ?? defaults[op];
      const out = fn ? fn({ prompt, req }) : {};
      const text = typeof out === "string" ? out : JSON.stringify(out);
      return { text, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }] } };
    },
    async embed(req) { return { embeddings: req.contents.map((t) => ({ values: Array.from({ length: 768 }, (_, i) => ((t.length * (i + 1)) % 7) / 7) })) }; },
  };
  return { adapter, overrides, calls, route };
}

export async function harness({ demo = false, env = {} } = {}) {
  // TEST_DATABASE_URL runs the same suite through the `pg` driver (the Cloud SQL code path) instead of in-process PGlite.
  const viaPg = process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL, DB_POOL_MAX: process.env.TEST_DB_POOL_MAX ?? "1" } : {};
  const cfg = getConfig({ NODE_ENV: "test", PGLITE_DIR: "memory", STORAGE_DIR: "memory", SAMPLE_SPACES: "1", DEMO_SEED: demo ? "1" : "0", DEMO_LOGIN: demo ? "1" : "0", PUBLIC_ORIGIN: "http://localhost:3200", ALLOW_SIGNUP: "1", JOB_POLL_MS: "50", ...viaPg, ...env });
  const log = createLogger({ ...cfg, logLevel: process.env.TEST_LOG_LEVEL || "silent" });
  const fake = fakeModel();
  const s = await buildServices(cfg, { log, modelAdapter: fake.adapter });
  const app = await buildServer(s);
  s.jobs.start();
  return { s, app, fake, cfg, close: async () => { await s.jobs.stop(); await app.close(); await s.db.close(); } };
}

/** A browser-like user against app.inject: cookie session + CSRF token. */
export function user(app) {
  let cookie = "", csrf = "";
  async function call(method, url, payload, headers = {}) {
    const isBuf = Buffer.isBuffer(payload);
    const res = await app.inject({ method, url, payload: isBuf ? payload : payload === undefined ? undefined : payload, headers: { ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}), ...(isBuf ? { "content-type": headers["content-type"] ?? "application/octet-stream" } : {}), ...headers } });
    const set = res.headers["set-cookie"];
    for (const c of [].concat(set ?? [])) { const kv = c.split(";")[0]; if (kv.startsWith("kd_session=")) cookie = kv; }
    let body; try { body = res.json(); } catch { body = res.body; }
    if (body?.csrfToken) csrf = body.csrfToken;
    return { status: res.statusCode, body, headers: res.headers };
  }
  return {
    call, get: (u) => call("GET", u), post: (u, b = {}) => call("POST", u, b), del: (u) => call("DELETE", u),
    setCsrf: (t) => { csrf = t; }, cookie: () => cookie, clearCsrf: () => { csrf = ""; },
    async signup(email, orgName) {
      const r = await call("POST", "/api/auth/signup", { email, password: "correct-horse-battery", displayName: email.split("@")[0], orgName });
      if (r.status !== 200) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
      return this.acceptPolicies();
    },
    async login(email, password = "correct-horse-battery") {
      const r = await call("POST", "/api/auth/login", { email, password });
      if (r.status !== 200) throw new Error(`login ${r.status}`);
      return this.acceptPolicies();
    },
    async acceptPolicies() {
      const me = (await call("GET", "/api/auth/me")).body;
      if (me.policies?.pending?.length) await call("POST", "/api/policies/accept", { ids: me.policies.pending });
      return (await call("GET", "/api/auth/me")).body;
    },
  };
}

export async function waitFor(fn, { timeoutMs = 10000, everyMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export const PNG = (seed = 1) => {
  // minimal valid PNG header + unique payload (magic bytes are what the server checks)
  const b = Buffer.alloc(64, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  return b;
};
export const WAV = (seed = 1) => {
  const b = Buffer.alloc(4044, seed);
  b.write("RIFF", 0); b.writeUInt32LE(4036, 4); b.write("WAVE", 8);
  return b;
};
