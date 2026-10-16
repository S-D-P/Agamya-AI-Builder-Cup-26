// AI retry: bounded (one retry), cost-accounted (every attempt recorded), and never a success when the model failed.
import test from "node:test";
import assert from "node:assert/strict";
import { callJson, setModelAdapter, setInferenceSink, setBudgetGuard } from "../src/ai/gemini.mjs";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const ask = () => callJson({ op: "probe", system: "s", prompt: "p", schema: SCHEMA });
function scripted(steps) {
  let i = 0;
  return { name: "scripted", async generate() { const s = steps[Math.min(i++, steps.length - 1)]; if (s instanceof Error) throw s; return { text: JSON.stringify(s), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }; }, get calls() { return i; } };
}

test("HTTP 429 then success: one retry after a pause, both attempts recorded, the retry labelled", { timeout: 20000 }, async () => {
  const entries = [];
  setInferenceSink(async (e) => entries.push(e));
  setBudgetGuard(async () => true);
  const a = scripted([new Error("429 RESOURCE_EXHAUSTED"), { ok: true }]);
  setModelAdapter(a);
  const started = Date.now();
  const r = await ask();
  assert.equal(r.ok, true);
  assert.equal(a.calls, 2);
  assert.ok(Date.now() - started >= 1400, "a rate-limited call pauses before retrying");
  assert.deepEqual(entries.map((e) => e.status), ["error", "ok"]);
  assert.equal(entries[0].errorCategory, "rate_limited");
  assert.match(entries[1].result, /^attempt 2:/);
});

test("two timeouts: the call FAILS (no third attempt), and the failure is not reported as success", async () => {
  const entries = [];
  setInferenceSink(async (e) => entries.push(e));
  const a = scripted([new Error("request timeout"), new Error("request timeout"), { ok: true }]);
  setModelAdapter(a);
  const r = await ask();
  assert.equal(r.ok, false);
  assert.equal(a.calls, 2, "bounded: exactly one retry");
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === "error"));
});

test("schema-invalid output is not retried (retrying would only spend money on the same mistake)", async () => {
  const entries = [];
  setInferenceSink(async (e) => entries.push(e));
  const a = scripted([{ wrong: 1 }, { ok: true }]);
  setModelAdapter(a);
  const r = await ask();
  assert.equal(r.ok, false);
  assert.equal(a.calls, 1);
});

test("over budget: no call and no retry", async () => {
  const entries = [];
  setInferenceSink(async (e) => entries.push(e));
  setBudgetGuard(async () => false);
  const a = scripted([{ ok: true }]);
  setModelAdapter(a);
  const { withAiContext } = await import("../src/ai/gemini.mjs");
  const r = await withAiContext({ orgId: "00000000-0000-0000-0000-000000000001" }, ask);
  assert.equal(r.ok, false);
  assert.equal(a.calls, 0);
  setBudgetGuard(async () => true);
});

test("a rejected request (HTTP 400, e.g. an invalid schema) is not retried and is not a success", async () => {
  const entries = [];
  setInferenceSink(async (e) => entries.push(e));
  setBudgetGuard(async () => true);
  const a = scripted([new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}'), { ok: true }]);
  setModelAdapter(a);
  const r = await ask();
  assert.equal(r.ok, false);
  assert.equal(a.calls, 1, "permanent errors are not retried");
  assert.equal(entries[0].errorCategory, "ai_rejected");
});
