// Guardrail agents: a confirmed Work Map, made usable by AI agents and automations.
//   An owner connects an agent to ONE confirmed map and gets a key (shown once, stored as a hash, revocable).
//   The agent asks "would the expert stop here?" over REST (/agent/v1/check) or MCP (/agent/v1/mcp), or through the
//   Google ADK agent in agents/guardrail_agent (deployable to Vertex AI Agent Engine).
//   Answers cite the confirmed map: the guardrail and the expert's own words come from the map, never from the model.
//   Every check is recorded (verdict, step, redacted action) so the owner sees what agents asked.
import { requirePermission } from "../platform/authz.mjs";
import { httpError, newToken, sha256 } from "../platform/security.mjs";
import { audit } from "../platform/audit.mjs";
import { redactText } from "../platform/redact.mjs";
import { withAiContext } from "../ai/gemini.mjs";
import { checkAction } from "../ai/ops/workmap.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MCP_VERSION = "2025-06-18";

export function createAgents({ db, cfg }) {
  const T = (ctx, fn) => db.tenant(ctx, fn);

  async function ownedConfirmedMap(q, ctx, sessionId) {
    if (!UUID.test(String(sessionId))) throw httpError(404, "work map not found");
    const [m] = await q("SELECT w.*, s.expert_person_id AS session_expert FROM work_maps w JOIN expert_sessions s ON s.id = w.session_id WHERE w.session_id = $1", [sessionId]);
    if (!m) throw httpError(404, "work map not found");
    if (m.expert_person_id !== ctx.personId && !ctx.roles?.some((r) => ["ORG_OWNER", "ORG_ADMIN"].includes(r))) throw httpError(403, "only the expert who confirmed this map (or an administrator) can connect agents to it");
    if (m.status !== "confirmed") throw httpError(409, "confirm the Work Map first: agents only use confirmed knowledge");
    return m;
  }

  async function createKey(ctx, sessionId, { label = "" } = {}) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const m = await ownedConfirmedMap(q, ctx, sessionId);
      const key = `agk_${newToken()}`;
      const [k] = await q("INSERT INTO agent_keys (org_id, work_map_id, label, key_hash, key_hint, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at",
        [ctx.orgId, m.id, String(label).trim().slice(0, 80) || "Agent", sha256(key), key.slice(-4), ctx.userId]);
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "agent.key_create", targetType: "work_map", targetId: m.id, requestId: ctx.requestId });
      return { id: k.id, key, hint: key.slice(-4), endpoints: endpoints() };
    });
  }

  async function listKeys(ctx, sessionId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const m = await ownedConfirmedMap(q, ctx, sessionId);
      const keys = await q("SELECT id, label, key_hint, created_at, last_used_at, revoked_at FROM agent_keys WHERE work_map_id = $1 ORDER BY created_at DESC", [m.id]);
      const checks = await q("SELECT via, action, verdict, step_id, latency_ms, created_at FROM agent_checks WHERE work_map_id = $1 ORDER BY created_at DESC LIMIT 20", [m.id]);
      return { keys: keys.map((k) => ({ id: k.id, label: k.label, hint: k.key_hint, createdAt: k.created_at, lastUsedAt: k.last_used_at, revoked: Boolean(k.revoked_at) })),
        checks: checks.map((c) => ({ via: c.via, action: c.action, verdict: c.verdict, stepId: c.step_id, latencyMs: c.latency_ms, at: c.created_at })), endpoints: endpoints() };
    });
  }

  async function revokeKey(ctx, sessionId, keyId) {
    requirePermission(ctx, "workflow.read");
    return T(ctx, async (q) => {
      const m = await ownedConfirmedMap(q, ctx, sessionId);
      const [k] = await q("UPDATE agent_keys SET revoked_at = now() WHERE id = $1 AND work_map_id = $2 AND revoked_at IS NULL RETURNING id", [keyId, m.id]);
      if (!k) throw httpError(404, "key not found");
      await audit(q, { orgId: ctx.orgId, userId: ctx.userId, action: "agent.key_revoke", targetType: "agent_key", targetId: k.id, requestId: ctx.requestId });
      return { revoked: true };
    });
  }

  const endpoints = () => ({ check: `${cfg.publicOrigin}/agent/v1/check`, map: `${cfg.publicOrigin}/agent/v1/map`, mcp: `${cfg.publicOrigin}/agent/v1/mcp` });

  /** Bearer key → the one confirmed map it may read. */
  async function authenticate(header) {
    const key = String(header ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!/^agk_[A-Za-z0-9_-]{20,}$/.test(key)) throw httpError(401, "missing or invalid agent key");
    const [k] = await db.system((q) => q("SELECT id, org_id, work_map_id FROM agent_keys WHERE key_hash = $1 AND revoked_at IS NULL", [sha256(key)]));
    if (!k) throw httpError(401, "missing or invalid agent key");
    const ctx = { orgId: k.org_id, userId: null };
    const map = await T(ctx, async (q) => {
      await q("UPDATE agent_keys SET last_used_at = now() WHERE id = $1", [k.id]);
      const [m] = await q("SELECT w.*, p.display_name AS expert_name FROM work_maps w JOIN people p ON p.id = w.expert_person_id WHERE w.id = $1", [k.work_map_id]);
      return m;
    });
    if (!map || map.status !== "confirmed") throw httpError(409, "this Work Map is no longer confirmed");
    return { keyId: k.id, ctx, map };
  }

  const mapInfo = (m) => ({ title: m.title, expert: m.expert_name, version: m.version, confirmedAt: m.confirmed_at, steps: m.map.steps.length });

  /** The map as an agent should load it: steps, decisions, reasons and guardrails with the expert's words. */
  function mapForAgent(m) {
    const lines = [`# ${m.title} (confirmed by ${m.expert_name}, version ${m.version})`, ""];
    for (const s of m.map.steps) {
      lines.push(`## ${s.id}. ${s.title}`, `Do: ${s.action}`, `Decision: ${s.decision}`);
      if (s.reason?.text) lines.push(`Why: ${s.reason.text}${s.reason.quote ? ` (in ${m.expert_name}'s words: "${s.reason.quote}")` : " (inferred, not said by the expert)"}`);
      for (const g of s.guardrails) lines.push(`${g.kind === "never" ? "NEVER" : g.kind === "stop_and_ask" ? "STOP AND ASK A PERSON" : g.kind.toUpperCase()}: ${g.text}${g.quote ? ` ("${g.quote}")` : ""}`);
      lines.push("");
    }
    lines.push("If a situation is not covered here, stop and ask a person.");
    return { ...mapInfo(m), markdown: lines.join("\n"), json: m.map.steps };
  }

  async function check(auth, { action, context = "" }, via = "rest") {
    const text = String(action ?? "").trim();
    if (!text) throw httpError(400, "describe the action to check");
    const started = Date.now();
    const r = await withAiContext({ orgId: auth.ctx.orgId, requestId: `agent:${auth.keyId ?? "app"}` }, () =>
      checkAction({ map: auth.map.map, action: redactText(text).text, context: redactText(typeof context === "string" ? context : JSON.stringify(context ?? "")).text }));
    const latency = Date.now() - started;
    await T(auth.ctx, (q) => q("INSERT INTO agent_checks (org_id, work_map_id, agent_key_id, via, action, verdict, step_id, latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [auth.ctx.orgId, auth.map.id, auth.keyId ?? null, via, redactText(text).text.slice(0, 300), r.verdict, r.stepId, latency]));
    return { ...r, expert: auth.map.expert_name, workMap: mapInfo(auth.map), latencyMs: latency };
  }

  /** The owner tries the check from the map page (no key needed). */
  async function checkInApp(ctx, sessionId, body) {
    requirePermission(ctx, "workflow.read");
    const m = await T(ctx, async (q) => {
      const map = await ownedConfirmedMap(q, ctx, sessionId);
      const [p] = await q("SELECT display_name FROM people WHERE id = $1", [map.expert_person_id]);
      return { ...map, expert_name: p?.display_name ?? "the expert" };
    });
    return check({ keyId: null, ctx: { orgId: ctx.orgId, userId: ctx.userId }, map: m }, body, "app");
  }

  /** Model Context Protocol over HTTP (JSON-RPC 2.0, JSON responses). Tools: get_work_map, check_action. */
  async function mcp(auth, msg) {
    const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "invalid request");
    if (msg.id === undefined) return null; // a notification (e.g. notifications/initialized): no response
    const name = `${auth.map.expert_name}'s guardrails: ${auth.map.title}`;
    switch (msg.method) {
      case "initialize":
        return reply({ protocolVersion: MCP_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "agamya-work-map", title: name, version: String(auth.map.version) },
          instructions: `Before acting in "${auth.map.title}", call check_action. If the verdict is STOP or ASK, do not act: hand over to a person. If NOT_COVERED, ask a person.` });
      case "ping": return reply({});
      case "tools/list":
        return reply({ tools: [
          { name: "get_work_map", title: "Read the Work Map", description: `The confirmed process for "${auth.map.title}": steps, decisions, reasons and guardrails in ${auth.map.expert_name}'s words.`, inputSchema: { type: "object", properties: {} } },
          { name: "check_action", title: "Would the expert stop here?", description: `Check a proposed action against ${auth.map.expert_name}'s confirmed guardrails. Returns STOP, ASK, PROCEED or NOT_COVERED with the expert's own words.`,
            inputSchema: { type: "object", properties: { action: { type: "string", description: "What you are about to do, in one sentence" }, context: { type: "string", description: "Relevant facts (amounts, supplier, dates)" } }, required: ["action"] } },
        ] });
      case "tools/call": {
        const tool = msg.params?.name, args = msg.params?.arguments ?? {};
        if (tool === "get_work_map") { const m = mapForAgent(auth.map); return reply({ content: [{ type: "text", text: m.markdown }], structuredContent: { title: m.title, expert: m.expert, version: m.version, steps: m.json } }); }
        if (tool === "check_action") {
          if (!String(args.action ?? "").trim()) return reply({ content: [{ type: "text", text: "Describe the action to check." }], isError: true });
          const r = await check(auth, args, "mcp");
          const said = r.guardrail?.expertQuote ? ` ${r.expert} said: "${r.guardrail.expertQuote}".` : "";
          return reply({ content: [{ type: "text", text: `${r.verdict}${r.stepTitle ? ` (step: ${r.stepTitle})` : ""}. ${r.explanation}${said}` }], structuredContent: r });
        }
        return fail(-32602, `unknown tool: ${tool}`);
      }
      default: return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  return { createKey, listKeys, revokeKey, authenticate, mapForAgent, check, checkInApp, mcp };
}
