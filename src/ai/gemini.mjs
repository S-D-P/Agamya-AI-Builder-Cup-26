// Gemini client. Every model operation goes through callJson():
//   - multimodal parts, JSON-schema constrained output, local re-validation (never trust the model's JSON)
//   - per-org budget guard BEFORE the call (cost control)
//   - real token accounting per modality from usageMetadata, latency, context manifest, persisted via a sink
//   - never throws: callers get { ok:false } and must use a deterministic fallback
// The transport is an adapter: Vertex AI / Gemini API in production, a scripted fake in tests.
import { AsyncLocalStorage } from "node:async_hooks";

export const MODEL = () => process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TTS_MODEL = () => process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-tts";
const EMBED_MODEL = () => process.env.EMBED_MODEL || "text-embedding-005";
const TIMEOUT_MS = () => Number(process.env.GEMINI_TIMEOUT_MS || 40000); // per attempt; one retry on timeout (see callJson)

// USD per 1M tokens: list-price ASSUMPTIONS for estimates; override via env. Shown as estimates in the UI.
export const PRICING = {
  input: Number(process.env.PRICE_INPUT_PER_M || 0.3),
  inputAudio: Number(process.env.PRICE_INPUT_AUDIO_PER_M || 1.0),
  output: Number(process.env.PRICE_OUTPUT_PER_M || 2.5),
  ttsInput: Number(process.env.PRICE_TTS_INPUT_PER_M || 0.5),
  ttsOutput: Number(process.env.PRICE_TTS_OUTPUT_PER_M || 10),
  embedPerMChars: Number(process.env.PRICE_EMBED_PER_M_CHARS || 0.025),
  // Gemini Live native audio (estimates; set from the current Vertex AI price list)
  liveInputText: Number(process.env.PRICE_LIVE_INPUT_TEXT_PER_M || 0.5),
  liveInputAudioVideo: Number(process.env.PRICE_LIVE_INPUT_AV_PER_M || 3.0),
  liveOutputText: Number(process.env.PRICE_LIVE_OUTPUT_TEXT_PER_M || 2.0),
  liveOutputAudio: Number(process.env.PRICE_LIVE_OUTPUT_AUDIO_PER_M || 12.0),
};

// ---------------------------------------------------------------- request-scoped tags
const als = new AsyncLocalStorage();
export function withAiContext(tags, fn) { return als.run({ ...(als.getStore() ?? {}), ...tags }, fn); }
export const aiContext = () => als.getStore() ?? {};

// ---------------------------------------------------------------- pluggable transport, sink, budget guard
let adapter = null;
let sink = async () => {};
let budgetGuard = async () => true;
export function setModelAdapter(a) { adapter = a; }
export function setInferenceSink(fn) { sink = fn; }
export function setBudgetGuard(fn) { budgetGuard = fn; }
export function aiAvailable() { return Boolean(adapter); }

/** Vertex AI (ADC / service account) or Gemini API key. Returns null when offline. */
export async function vertexAdapter() {
  if (process.env.AGAMYA_OFFLINE === "1" || process.env.KINDRED_OFFLINE === "1") return null;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_CLOUD_PROJECT) return null;
  const { GoogleGenAI } = await import("@google/genai");
  const client = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1" });
  return {
    name: process.env.GEMINI_API_KEY ? "gemini-api" : "vertex-ai",
    generate: (req) => client.models.generateContent(req),
    embed: (req) => client.models.embedContent(req),
  };
}

// ---------------------------------------------------------------- Gemini Live (real-time voice + vision)
export const LIVE_MODEL = () => process.env.GEMINI_LIVE_MODEL || "gemini-live-2.5-flash-native-audio";
let liveFactory = null; // tests inject a fake
export function setLiveFactory(fn) { liveFactory = fn; }
/** A client with `.live.connect(...)`, or null when AI is offline. Credentials stay on the server (the browser never sees them). */
export async function liveClient() {
  if (liveFactory) return liveFactory();
  if (process.env.AGAMYA_OFFLINE === "1" || process.env.KINDRED_OFFLINE === "1") return null;
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_CLOUD_PROJECT) return null;
  const { GoogleGenAI } = await import("@google/genai");
  return process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1" });
}
/** Record Live usage (cost accounting). Live native-audio list prices differ from text; configurable, labelled as estimates. */
export async function recordLiveUsage({ mode, usage, latencyMs = 0 }) {
  const u = usage ?? {};
  const by = {};
  for (const d of u.promptTokensDetails ?? []) by[d.modality] = (by[d.modality] ?? 0) + (d.tokenCount ?? 0);
  const outBy = {};
  for (const d of u.responseTokensDetails ?? []) outBy[d.modality] = (outBy[d.modality] ?? 0) + (d.tokenCount ?? 0);
  const entry = { op: `live:${mode}`, model: LIVE_MODEL(), status: "ok", inputTypes: Object.keys(by), mediaItems: 0, contextChars: 0,
    promptTokens: u.promptTokenCount ?? 0, outputTokens: u.responseTokenCount ?? u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0, byModality: by, latencyMs, outputByModality: outBy };
  return record(entry);
}

export function costOf(e) {
  if (String(e.op).startsWith("live:")) {
    const inMedia = (e.byModality?.AUDIO ?? 0) + (e.byModality?.VIDEO ?? 0) + (e.byModality?.IMAGE ?? 0);
    const inText = (e.promptTokens || 0) - inMedia;
    const outAudio = e.outputByModality?.AUDIO ?? 0;
    const outText = (e.outputTokens || 0) - outAudio;
    return (inText * PRICING.liveInputText + inMedia * PRICING.liveInputAudioVideo + outAudio * PRICING.liveOutputAudio + Math.max(0, outText) * PRICING.liveOutputText) / 1e6;
  }
  if (e.op === "tts") return ((e.promptTokens || 0) * PRICING.ttsInput + (e.outputTokens || 0) * PRICING.ttsOutput) / 1e6;
  if (e.op === "embed") return ((e.contextChars || 0) * PRICING.embedPerMChars) / 1e6;
  const audio = e.byModality?.AUDIO ?? 0;
  const other = (e.promptTokens || 0) - audio;
  return (other * PRICING.input + audio * PRICING.inputAudio + ((e.outputTokens || 0) + (e.thoughtTokens || 0)) * PRICING.output) / 1e6;
}

function usageOf(response) {
  const u = response?.usageMetadata ?? {};
  const byModality = {};
  for (const d of u.promptTokensDetails ?? []) byModality[d.modality] = (byModality[d.modality] ?? 0) + (d.tokenCount ?? 0);
  return { promptTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0, byModality };
}

async function record(entry) {
  const tags = aiContext();
  Object.assign(entry, { orgId: tags.orgId ?? null, sessionId: tags.sessionId ?? null, workflowId: tags.workflowId ?? null, requestId: tags.requestId ?? null, pipeline: tags.pipeline ?? "live" });
  entry.costUsd = costOf(entry);
  try { await sink(entry); } catch { /* accounting must never break the product path */ }
  return entry;
}

/**
 * One structured model operation.
 * @param {{op:string, system:string, prompt:string, media?:Array<{mimeType:string,data:string}>, schema:object,
 *          thinkingBudget?:number, maxTokens?:number, temperature?:number, mediaResolution?:string,
 *          manifest?:object, summarize?:(d:any)=>{result?:string,confidence?:number}}} o
 */
export async function callJson(o) {
  // One retry for transient failures (timeouts, service errors), never for malformed or schema-invalid output and never
  // past the budget guard. Each attempt is recorded, so cost accounting stays exact. Observed on Cloud Run: occasional
  // 60 s Vertex AI timeouts among calls that normally take 2–5 s.
  const first = await callOnce(o, 1);
  if (first.ok || first.budget || !["timeout", "rate_limited", "ai_error"].includes(first.category)) return first;
  // Quota pressure (HTTP 429) needs a pause, not an immediate hammer; jitter avoids synchronized retries across jobs.
  if (first.category === "rate_limited") await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 2500)));
  const second = await callOnce(o, 2);
  return second.ok ? second : { ...first, error: second.error, category: second.category };
}

async function callOnce({ op, system, prompt, media = [], schema, thinkingBudget = 0, maxTokens = 2048, temperature = 0.3, mediaResolution, manifest = null, summarize }, attempt = 1) {
  const started = Date.now();
  const entry = {
    op, model: MODEL(), status: "error", latencyMs: 0, errorCategory: null, result: null, confidence: null,
    inputTypes: [...new Set(["TEXT", ...media.map((m) => m.mimeType.split("/")[0].toUpperCase())])],
    mediaItems: media.length, mediaResolution: media.length ? mediaResolution ?? "DEFAULT" : null,
    contextChars: (system?.length ?? 0) + prompt.length, manifest,
    promptTokens: 0, outputTokens: 0, thoughtTokens: 0, byModality: {},
  };
  if (!adapter) { entry.errorCategory = "ai_unavailable"; await record(entry); return { ok: false, error: "AI unavailable" }; }
  const orgId = aiContext().orgId;
  if (orgId && !(await budgetGuard(orgId))) {
    entry.status = "skipped_budget"; entry.errorCategory = "budget_exceeded";
    await record(entry);
    return { ok: false, error: "organization AI budget exceeded", budget: true };
  }
  try {
    const response = await withTimeout(adapter.generate({
      model: MODEL(),
      contents: [{ role: "user", parts: [...media.map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.data } })), { text: prompt }] }],
      config: {
        systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema, temperature,
        maxOutputTokens: maxTokens + thinkingBudget, thinkingConfig: { thinkingBudget }, ...(mediaResolution ? { mediaResolution } : {}),
      },
    }), TIMEOUT_MS());
    Object.assign(entry, usageOf(response));
    const text = response.text;
    if (!text) throw Object.assign(new Error("empty response"), { category: "ai_empty" });
    let data;
    try { data = JSON.parse(stripFences(text)); } catch { throw Object.assign(new Error("malformed JSON"), { category: "ai_malformed" }); }
    const errors = validate(schema, data);
    if (errors.length) throw Object.assign(new Error("schema: " + errors.slice(0, 3).join("; ")), { category: "ai_schema" });
    entry.status = "ok";
    entry.latencyMs = Date.now() - started;
    if (summarize) { try { Object.assign(entry, summarize(data)); } catch { /* summary is best effort */ } }
    if (attempt > 1) entry.result = `attempt ${attempt}: ${entry.result ?? ""}`.slice(0, 200); // retries are countable in the cost report
    await record(entry);
    return { ok: true, data, usage: entry };
  } catch (err) {
    // A rejected request (400/403/404: bad schema, permission, model name) fails the same way again: never retried.
    entry.errorCategory = err.category ?? (/timeout/i.test(err.message) ? "timeout" : /429|RESOURCE_EXHAUSTED/i.test(err.message) ? "rate_limited"
      : /"code":\s*(400|403|404)|INVALID_ARGUMENT|PERMISSION_DENIED|NOT_FOUND/.test(err.message) ? "ai_rejected" : "ai_error");
    if (attempt > 1) entry.result = `attempt ${attempt}: `;
    entry.result = `${entry.result ?? ""}${String(err.message)}`.slice(0, 200);
    entry.latencyMs = Date.now() - started;
    await record(entry);
    return { ok: false, error: err.message, category: entry.errorCategory };
  }
}

export async function embed(texts) {
  const entry = { op: "embed", model: EMBED_MODEL(), status: "error", inputTypes: ["TEXT"], mediaItems: 0, contextChars: texts.join("").length, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, byModality: {}, latencyMs: 0 };
  if (!adapter?.embed) { entry.errorCategory = "ai_unavailable"; await record(entry); return null; }
  const started = Date.now();
  try {
    const r = await withTimeout(adapter.embed({ model: EMBED_MODEL(), contents: texts }), TIMEOUT_MS());
    entry.status = "ok"; entry.latencyMs = Date.now() - started;
    await record(entry);
    return r.embeddings.map((e) => e.values);
  } catch (err) {
    entry.errorCategory = "ai_error"; entry.result = String(err.message).slice(0, 200); entry.latencyMs = Date.now() - started;
    await record(entry);
    return null;
  }
}

export async function tts(text, voiceName = process.env.TTS_VOICE || "Puck", { timeoutMs = TIMEOUT_MS(), style = "Say in a warm, curious, gentle voice:" } = {}) {
  const entry = { op: "tts", model: TTS_MODEL(), status: "error", inputTypes: ["TEXT"], mediaItems: 0, contextChars: text.length, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, byModality: {}, latencyMs: 0 };
  if (!adapter) { entry.errorCategory = "ai_unavailable"; await record(entry); return null; }
  const orgId = aiContext().orgId;
  if (orgId && !(await budgetGuard(orgId))) { entry.status = "skipped_budget"; await record(entry); return null; }
  const started = Date.now();
  try {
    const r = await withTimeout(adapter.generate({
      model: TTS_MODEL(), contents: `${style} ${text}`,
      config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
    }), timeoutMs);
    Object.assign(entry, usageOf(r));
    const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw new Error("no audio returned");
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000);
    entry.status = "ok"; entry.latencyMs = Date.now() - started;
    await record(entry);
    return pcmToWav(Buffer.from(part.inlineData.data, "base64"), rate);
  } catch (err) {
    entry.errorCategory = "ai_error"; entry.result = String(err.message).slice(0, 200); entry.latencyMs = Date.now() - started;
    await record(entry);
    return null;
  }
}

export function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))]);
}
function stripFences(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Minimal JSON-schema validator (type, properties, required, items, enum, minimum/maximum, minLength, maxItems). */
export function validate(schema, value, path = "$") {
  const errs = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((t) => typeMatches(t, value))) return [`${path}: expected ${types.join("|")}`];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (typeof value === "string" && schema.minLength && value.trim().length < schema.minLength) errs.push(`${path}: too short`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: < minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: > maximum`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errs.push(`${path}.${key}: missing`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) errs.push(...validate(sub, value[key], `${path}.${key}`));
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  return errs;
}
function typeMatches(t, v) {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}
