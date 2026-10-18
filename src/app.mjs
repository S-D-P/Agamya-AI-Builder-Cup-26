// Composition root: wires platform → domain → HTTP. One image, PROCESS_ROLE decides api | worker | all.
import path from "node:path";
import Fastify, { LogController } from "fastify";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fstatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { ROOT } from "./config.mjs";
import { createDb } from "./platform/db.mjs";
import { createStorage } from "./platform/storage.mjs";
import { createLogger, errorCategory } from "./platform/logger.mjs";
import { createWorker, enqueue } from "./platform/jobs.mjs";
import { requirePermission, can } from "./platform/authz.mjs";
import { hashIp, sha256, safeEqual, httpError, newToken } from "./platform/security.mjs";
import { audit } from "./platform/audit.mjs";
import { setModelAdapter, setInferenceSink, setBudgetGuard, vertexAdapter, withAiContext, aiAvailable, MODEL, PRICING } from "./ai/gemini.mjs";
import { voiceProvider } from "./ai/voice.mjs";
import { OPERATION_PROFILES, POLICIES } from "./ai/context.mjs";
import { createIdentity } from "./domain/identity.mjs";
import { createPolicy } from "./domain/policy.mjs";
import { createWorkflows } from "./domain/workflows.mjs";
import { createKnowledge } from "./domain/knowledge.mjs";
import { createCapture } from "./domain/capture.mjs";
import { createApprentice } from "./domain/apprentice.mjs";
import { createAnalytics, inferenceSink, budgetGuard, invalidateBudget } from "./domain/analytics.mjs";
import { createTransfers } from "./domain/transfers.mjs";
import { createGaps } from "./domain/gaps.mjs";
import { createAsk } from "./domain/ask.mjs";
import { LANGUAGES, LANGUAGE_CODES } from "./ai/language.mjs";
import { transcribe } from "./ai/ops/perception.mjs";
import { seedDemo, seedBenchmark, createSampleSpace, ensureJudgeAccounts } from "./domain/seed.mjs";
import { createGroups } from "./domain/groups.mjs";
import { createMissions } from "./domain/missions.mjs";
import { createNotifications } from "./domain/notifications.mjs";
import { createStorageReport } from "./domain/storage-report.mjs";
import { createWorkMaps } from "./domain/workmaps.mjs";
import { createAccess } from "./domain/access.mjs";
import { createAgents } from "./domain/agents.mjs";
import { createImpact } from "./domain/impact.mjs";
import { createLive } from "./domain/live.mjs";

export async function buildServices(cfg, { log = createLogger(cfg), modelAdapter } = {}) {
  const db = await createDb(cfg.db);
  await db.migrate((m) => log.info(m));
  const storage = await createStorage(cfg.storage);
  setModelAdapter(modelAdapter !== undefined ? modelAdapter : cfg.ai.offline ? null : await vertexAdapter());
  setInferenceSink(inferenceSink(db));
  setBudgetGuard(budgetGuard(db));
  const handlers = {};
  const jobs = createWorker({ db, log, handlers, cfg: cfg.jobs });
  const identity = createIdentity({ db, cfg });
  const policy = createPolicy({ db });
  const workflows = createWorkflows({ db, storage, cfg });
  const knowledge = createKnowledge({ db, storage, cfg });
  const capture = createCapture({ db, storage, jobs, knowledge, policy, cfg, log });
  const apprentice = createApprentice({ db, cfg });
  const analytics = createAnalytics({ db });
  const transfers = createTransfers({ db, capture });
  const gaps = createGaps({ db });
  const askService = createAsk({ db, maps: () => workmaps }); // Work Maps are created below; looked up at call time
  const groups = createGroups({ db });
  const missions = createMissions({ db, storage, cfg, workflows, capture, transfers });
  const notifications = createNotifications({ db });
  const storageReport = createStorageReport({ db });
  const workmaps = createWorkMaps({ db, capture, storage });
  const access = createAccess({ db });
  const agents = createAgents({ db, cfg });
  const impact = createImpact({ db });
  const live = createLive({ db, capture, workmaps, log, cfg });
  Object.assign(handlers, capture.handlers, knowledge.handlers, apprentice.handlers, workflows.handlers, gaps.handlers, missions.handlers, workmaps.handlers);
  await policy.seedTemplates();
  if (cfg.demo.seed) await seedDemo({ db, identity, cfg, log });
  await ensureJudgeAccounts({ db, identity, cfg, log });
  await seedBenchmark(db); // measured evidence shown on Insights; platform-level, read-only
  return { cfg, log, db, storage, jobs, identity, policy, workflows, knowledge, capture, apprentice, analytics, transfers, gaps, ask: askService, groups, missions, notifications, storageReport, workmaps, live, access, agents, impact };
}

/** Hourly lifecycle sweep per organization (enqueued idempotently, executed by whichever worker claims it). */
export function startScheduler(s) {
  const tick = async () => {
    try {
      const orgs = await s.db.system((q) => q("SELECT id FROM organizations WHERE deleted_at IS NULL"));
      const hour = new Date().toISOString().slice(0, 13);
      for (const o of orgs) await s.db.tenant({ orgId: o.id }, async (q) => {
        await enqueue(q, { orgId: o.id, kind: "lifecycle_sweep", key: hour, payload: {} });
        await enqueue(q, { orgId: o.id, kind: "mission_sweep", key: hour, payload: {}, maxAttempts: 2 });
      });
    } catch (e) { s.log.error({ err: e.message }, "scheduler tick failed"); }
  };
  tick();
  return setInterval(tick, 3600_000);
}

/** Origins of a configured demo video (and its captions) so the CSP allows exactly those, nothing broader. */
function videoOrigins(v) {
  if (!v) return [];
  return [...new Set([v.url, v.captionsUrl, v.poster].filter(Boolean).map((u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.origin : null; } catch { return null; } }).filter(Boolean))];
}

export async function buildServer(s) {
  const { cfg, log } = s;
  const app = Fastify({
    loggerInstance: log, trustProxy: true, bodyLimit: 2 * 1024 * 1024, logController: new LogController({ disableRequestLogging: true }), // we log one structured line per request ourselves
    genReqId: (req) => String(req.headers["x-cloud-trace-context"] ?? "").split("/")[0] || newToken().slice(0, 16),
  });
  for (const t of ["application/octet-stream", "image/png", "image/jpeg", "image/webp", "audio/wav", "video/webm", "video/mp4"]) {
    app.addContentTypeParser(t, { parseAs: "buffer", bodyLimit: cfg.media.maxVideoBytes }, (_req, body, done) => done(null, body));
  }
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"], imgSrc: ["'self'", "data:", "blob:", "https://storage.googleapis.com"], mediaSrc: ["'self'", "blob:", "https://storage.googleapis.com", ...videoOrigins(cfg.demoVideo)],
        connectSrc: ["'self'"], frameSrc: ["https://drive.google.com"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        ...(cfg.auth.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    hsts: cfg.auth.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "same-origin" },
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
    return payload;
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute", keyGenerator: (req) => req.ctx?.userId ?? req.ip });

  // ---------------------------------------------------------------- authentication, CSRF, policy gate, request context
  const PUBLIC = new Set(["/api/auth/config", "/api/auth/login", "/api/auth/demo-login", "/api/samples", "/api/auth/signup", "/api/auth/accept-invite", "/api/auth/invite-info", "/api/auth/oidc/start", "/api/auth/oidc/callback"]);
  // Spaces, the inbox and invitations work before a space's policies are accepted: they are how a person moves between spaces.
  const POLICY_EXEMPT = (url) => url === "/api/space/unlock" || url.startsWith("/api/auth/") || url.startsWith("/api/policies") || url.startsWith("/api/spaces") || url.startsWith("/api/inbox") || url.startsWith("/api/invitations/");
  const policyCache = new Map();
  const SPACE_LOCK_EXEMPT = (url) => url.startsWith("/api/auth/") || url.startsWith("/api/spaces") || url.startsWith("/api/inbox") || url.startsWith("/api/invitations/") || url === "/api/space/unlock";

  // Cloud Run answers on more than one hostname; cookies and Origin checks are bound to PUBLIC_ORIGIN, so send
  // page loads on any other host to the canonical one.
  const canonicalHost = new URL(cfg.publicOrigin).host;
  app.addHook("onRequest", async (req, reply) => {
    if (cfg.prod && ["GET", "HEAD"].includes(req.method) && req.headers.host && req.headers.host !== canonicalHost && !req.url.startsWith("/readyz") && !req.url.startsWith("/healthz")) {
      return reply.redirect(`${cfg.publicOrigin}${req.url}`, 301);
    }
  });

  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0];
    req.startedAt = Date.now();
    if (!url.startsWith("/api/")) return;
    const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (stateChanging) {
      const origin = req.headers.origin;
      if (origin && origin !== cfg.publicOrigin) throw httpError(403, "cross-origin request rejected");
    }
    const token = req.cookies?.[cfg.auth.cookieName];
    const ctx = token ? await s.identity.resolve(token) : null;
    if (ctx) req.ctx = { ...ctx, requestId: req.id, ip: hashIp(req.ip), ua: req.headers["user-agent"] };
    if (PUBLIC.has(url)) return;
    if (url === "/api/test/scenarios" || url.startsWith("/api/test/")) { if (!cfg.testHooks) throw httpError(404, "not found"); return; }
    if (!req.ctx) throw httpError(401, "sign in required");
    if (stateChanging && !safeEqual(sha256(String(req.headers["x-csrf-token"] ?? "")), req.ctx.csrfHash)) throw httpError(403, "invalid or missing CSRF token");
    // A space with a passcode stays closed until the passcode is entered in this sign-in session (switching spaces,
    // the space list and invitations stay available so nobody is stuck).
    if (req.ctx.spaceLocked && !SPACE_LOCK_EXEMPT(url)) throw httpError(423, "this space is locked: enter its passcode");
    if (req.ctx.orgId && !POLICY_EXEMPT(url)) {
      const key = `${req.ctx.sessionId}:${req.ctx.orgId}`;
      let pending = policyCache.get(key);
      if (!pending || Date.now() - pending.at > 60000) { pending = { at: Date.now(), n: (await s.policy.status(req.ctx)).pending.length }; policyCache.set(key, pending); }
      if (pending.n) throw httpError(428, "accept the current policies to continue", { code: "POLICIES_PENDING" });
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const lvl = reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info";
    log[lvl]({ requestId: req.id, tenantId: req.ctx?.orgId ?? null, userId: req.ctx?.userId ?? null, operation: `${req.method} ${req.routeOptions?.url ?? req.url.split("?")[0]}`,
      latency: Date.now() - (req.startedAt ?? Date.now()), status: reply.statusCode, errorCategory: reply.statusCode >= 400 ? errorCategory({ status: reply.statusCode }) : null }, "request");
  });

  app.setErrorHandler((err, req, reply) => {
    // Known Postgres conditions are client errors, not outages: unique violation → 409, malformed id/value → 400.
    const PG = { "23505": [409, "that already exists"], "22P02": [400, "invalid identifier or value"] };
    const pg = PG[err.code];
    const status = pg ? pg[0] : err.statusCode && err.statusCode < 500 ? err.statusCode : err.status ?? 500;
    if (pg) err = Object.assign(new Error(pg[1]), { code: undefined });
    if (status >= 500) log.error({ requestId: req.id, tenantId: req.ctx?.orgId, errorCategory: errorCategory(err), err: String(err.message).slice(0, 300), stack: cfg.prod ? undefined : err.stack }, "unhandled error");
    if (status === 403 && req.ctx?.orgId) s.db.tenant(req.ctx, (q) => audit(q, { orgId: req.ctx.orgId, userId: req.ctx.userId, action: "authz.denied", outcome: "denied", requestId: req.id, metadata: { route: req.routeOptions?.url ?? null, reason: String(err.message).slice(0, 120) } })).catch(() => {});
    reply.status(status).send({ error: status >= 500 ? "something went wrong; reference " + req.id : err.message, code: status < 500 ? err.code ?? undefined : undefined, requestId: req.id });
  });

  const setSessionCookie = (reply, token, expiresAt) => reply.setCookie(cfg.auth.cookieName, token, { path: "/", httpOnly: true, secure: cfg.auth.cookieSecure, sameSite: "lax", expires: new Date(expiresAt) });
  const meta = (req) => ({ ip: hashIp(req.ip), ua: req.headers["user-agent"], requestId: req.id });
  const ctxOf = (req) => req.ctx;
  const S = (schema) => ({ schema: { body: { type: "object", additionalProperties: false, ...schema } } });
  const id = { type: "string", format: "uuid" };

  // ---------------------------------------------------------------- health
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try { await s.db.ping(); await s.storage.ping(); return { ok: true, db: s.db.kind, storage: s.storage.kind, ai: Boolean(MODEL()) }; }
    catch (e) { log.warn({ err: String(e.message).slice(0, 200) }, "readiness check failed"); reply.status(503); return { ok: false, error: "dependency unavailable" }; }
  });

  // ---------------------------------------------------------------- auth
  app.get("/api/auth/config", async () => ({
    allowSignup: cfg.auth.allowSignup, oidc: cfg.auth.oidc ? { label: cfg.auth.oidc.label } : null,
    samples: cfg.demo.samples, ai: aiAvailable() ? "vertex" : "offline", demoVideo: cfg.demoVideo,
    // Public by design (hackathon judging): shown on the sign-in page. Only when JUDGE_ACCOUNTS=1.
    judges: cfg.judges.enabled ? cfg.judges.accounts.map((a) => ({ key: a.key, label: a.orgName, email: a.email, password: cfg.judges.password })) : [],
  }));
  app.post("/api/auth/signup", { ...S({ required: ["email", "password", "displayName", "orgName"], properties: { email: { type: "string", maxLength: 320 }, password: { type: "string", maxLength: 256 }, displayName: { type: "string", maxLength: 80 }, orgName: { type: "string", maxLength: 80 }, experience: { type: "string", enum: ["work", "living"] } } }), config: { rateLimit: { max: cfg.auth.signupRateMax, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const r = await s.identity.signup({ ...req.body, ...meta(req) });
    setSessionCookie(reply, r.token, r.expiresAt);
    return { ok: true, csrfToken: r.csrfToken };
  });
  app.post("/api/auth/login", { ...S({ required: ["email", "password"], properties: { email: { type: "string", maxLength: 320 }, password: { type: "string", maxLength: 256 } } }), config: { rateLimit: { max: 10, timeWindow: "5 minutes", hook: "preHandler", keyGenerator: (req) => `login:${req.ip}:${String(req.body?.email ?? "").toLowerCase()}` } } }, async (req, reply) => {
    const r = await s.identity.login({ ...req.body, ...meta(req) });
    setSessionCookie(reply, r.token, r.expiresAt);
    return { ok: true, csrfToken: r.csrfToken };
  });
  if (cfg.demo.passwordLogin) {
    app.post("/api/auth/demo-login", { ...S({ required: ["email"], properties: { email: { type: "string", maxLength: 320 } } }), config: { rateLimit: { max: 30, timeWindow: "5 minutes" } } }, async (req, reply) => {
      const r = await s.identity.demoLogin({ ...req.body, ...meta(req) });
      setSessionCookie(reply, r.token, r.expiresAt);
      return { ok: true, csrfToken: r.csrfToken };
    });
  }
  app.post("/api/auth/invite-info", { ...S({ required: ["token"], properties: { token: { type: "string", maxLength: 100 } } }), config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req) => s.identity.inviteInfo(req.body.token));
  app.post("/api/auth/accept-invite", { ...S({ required: ["token"], properties: { token: { type: "string", maxLength: 100 }, email: { type: "string", maxLength: 320 }, displayName: { type: "string", maxLength: 80 }, password: { type: "string", maxLength: 256 } } }), config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const r = await s.identity.acceptInvite({ ...req.body, ...meta(req) });
    setSessionCookie(reply, r.token, r.expiresAt);
    return { ok: true, csrfToken: r.csrfToken };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    await s.identity.logout(req.ctx, req.id);
    reply.clearCookie(cfg.auth.cookieName, { path: "/" });
    return { ok: true };
  });
  app.get("/api/auth/me", async (req) => {
    const c = ctxOf(req);
    const csrfToken = await s.identity.rotateCsrf(c);
    return { user: { id: c.userId, email: c.email, displayName: c.displayName, language: c.language ?? null }, org: c.orgId ? { id: c.orgId, name: c.orgName, isDemo: c.isDemoOrg, experience: c.experience, sampleKind: c.sampleKind, hasPasscode: c.spaceHasPasscode, locked: c.spaceLocked } : null, roles: c.roles, personId: c.personId,
      organizations: await s.identity.organizationsOf(c.userId), csrfToken, policies: c.orgId ? await s.policy.status(c) : null };
  });
  app.post("/api/space/unlock", { ...S({ required: ["passcode"], properties: { passcode: { type: "string", maxLength: 128 } } }), config: { rateLimit: { max: 8, timeWindow: "15 minutes", keyGenerator: (req) => `unlock:${req.ctx?.userId ?? req.ip}` } } },
    async (req) => s.identity.unlockSpace(req.ctx, req.body, req.id));
  app.post("/api/spaces/passcode", S({ properties: { passcode: { type: ["string", "null"], maxLength: 128 } } }), async (req) => s.identity.setSpacePasscode(req.ctx, req.body, req.id));
  app.post("/api/auth/switch-org", S({ required: ["orgId"], properties: { orgId: id } }), async (req) => { await s.identity.switchOrg(req.ctx, req.body.orgId); policyCache.clear(); return { ok: true }; });

  // ---------------------------------------------------------------- sample spaces (one isolated space per visitor)
  if (cfg.demo.samples) {
    app.post("/api/samples", { ...S({ required: ["kind"], properties: { kind: { type: "string", enum: ["living", "work"] } } }), config: { rateLimit: { max: 6, timeWindow: "10 minutes" } } }, async (req, reply) => {
      const [{ n }] = await s.db.system((q) => q("SELECT count(*)::int AS n FROM organizations WHERE sample_kind IS NOT NULL AND created_at > now() - interval '1 day'"));
      if (n >= cfg.demo.sampleDailyCap) throw httpError(429, "the sample is busy today; please try again later");
      const sp = await createSampleSpace({ db: s.db, identity: s.identity, cfg, kind: req.body.kind });
      const r = await s.identity.sampleLogin({ userId: sp.leadUserId, orgId: sp.orgId, ...meta(req) });
      setSessionCookie(reply, r.token, r.expiresAt);
      return { ok: true, csrfToken: r.csrfToken };
    });
  }
  const requireSample = (req) => { if (!req.ctx?.sampleKind) throw httpError(404, "not a sample space"); };
  app.get("/api/samples/people", async (req) => {
    requireSample(req);
    return s.db.tenant(req.ctx, (q) => q(`SELECT p.id, p.display_name, p.title, m.roles FROM people p JOIN memberships m ON m.user_id = p.user_id AND m.org_id = p.org_id AND m.status = 'active' ORDER BY p.display_name`));
  });
  app.post("/api/samples/switch", S({ required: ["personId"], properties: { personId: id } }), async (req, reply) => {
    requireSample(req);
    const [p] = await s.db.tenant(req.ctx, (q) => q("SELECT user_id FROM people WHERE id = $1", [req.body.personId]));
    if (!p?.user_id) throw httpError(404, "person not found");
    const r = await s.identity.sampleLogin({ userId: p.user_id, orgId: req.ctx.orgId, ...meta(req), carryPoliciesFrom: req.ctx.userId });
    await s.identity.logout(req.ctx, req.id);
    setSessionCookie(reply, r.token, r.expiresAt);
    return { ok: true, csrfToken: r.csrfToken };
  });

  if (cfg.auth.oidc) {
    const oidc = await import("openid-client");
    const oc = await oidc.discovery(new URL(cfg.auth.oidc.issuer), cfg.auth.oidc.clientId, cfg.auth.oidc.clientSecret);
    const redirect = `${cfg.publicOrigin}/api/auth/oidc/callback`;
    app.get("/api/auth/oidc/start", async (_req, reply) => {
      const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
      reply.setCookie("kd_oidc", JSON.stringify({ verifier, state, nonce }), { path: "/api/auth/oidc", httpOnly: true, secure: cfg.auth.cookieSecure, sameSite: "lax", maxAge: 600 });
      return reply.redirect(oidc.buildAuthorizationUrl(oc, { redirect_uri: redirect, scope: "openid email profile", code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256", state, nonce }).href);
    });
    app.get("/api/auth/oidc/callback", async (req, reply) => {
      const st = JSON.parse(req.cookies.kd_oidc ?? "{}");
      const tokens = await oidc.authorizationCodeGrant(oc, new URL(`${cfg.publicOrigin}${req.url}`), { pkceCodeVerifier: st.verifier, expectedState: st.state, expectedNonce: st.nonce });
      const c = tokens.claims();
      const r = await s.identity.loginWithOidc({ provider: `oidc:${new URL(cfg.auth.oidc.issuer).host}`, subject: c.sub, email: c.email, emailVerified: c.email_verified, name: c.name, ...meta(req) });
      reply.clearCookie("kd_oidc", { path: "/api/auth/oidc" });
      setSessionCookie(reply, r.token, r.expiresAt);
      return reply.redirect("/#/");
    });
  }

  // ---------------------------------------------------------------- policies + admin
  app.get("/api/policies", async (req) => s.policy.status(req.ctx));
  app.get("/api/policies/:id", async (req) => s.policy.document(req.ctx, req.params.id));
  app.post("/api/policies/accept", S({ required: ["ids"], properties: { ids: { type: "array", maxItems: 10, items: id } } }), async (req) => { await s.policy.accept(req.ctx, req.body.ids, meta(req)); policyCache.delete(`${req.ctx.sessionId}:${req.ctx.orgId}`); return s.policy.status(req.ctx); });
  app.post("/api/admin/policies", S({ required: ["type", "version", "content"], properties: { type: { type: "string" }, version: { type: "string", maxLength: 40 }, content: { type: "string", maxLength: 100000 } } }), async (req) => { requirePermission(req.ctx, "policy.manage"); return s.policy.publish(req.ctx, req.body, req.id); });
  app.get("/api/admin/members", async (req) => { requirePermission(req.ctx, "members.manage"); return s.identity.listMembers(req.ctx); });
  app.post("/api/admin/members/:userId/remove", S({ required: ["confirm"], properties: { confirm: { type: "boolean", const: true } } }),
    async (req) => { requirePermission(req.ctx, "members.manage"); return s.identity.removeMember(req.ctx, req.params.userId, req.id); });
  app.post("/api/admin/members/:userId/roles", S({ required: ["roles"], properties: { roles: { type: "array", maxItems: 5, items: { type: "string" } } } }), async (req) => { requirePermission(req.ctx, "members.manage"); await s.identity.setRoles(req.ctx, req.params.userId, req.body.roles, req.id); return { ok: true }; });
  app.post("/api/admin/invitations", S({ required: ["email", "roles"], properties: { email: { type: "string", maxLength: 320 }, roles: { type: "array", maxItems: 5, items: { type: "string" } } } }), async (req) => { requirePermission(req.ctx, "members.invite"); return s.identity.invite(req.ctx, req.body, req.id); });
  app.get("/api/admin/audit", async (req) => s.analytics.audit(req.ctx, { before: req.query.before ?? null, limit: Number(req.query.limit) || 50 }));
  app.post("/api/admin/settings", S({ properties: { aiMonthlyBudgetUsd: { type: "number", minimum: 0, maximum: 100000 }, retention: { type: "object", additionalProperties: false, properties: { raw_media: { type: "integer", minimum: 1, maximum: 3650 }, transcript: { type: "integer", minimum: 1, maximum: 3650 }, semantic: { type: "integer", minimum: 1, maximum: 3650 } } } } }), async (req) => {
    requirePermission(req.ctx, "retention.manage");
    await s.db.system(async (q) => {
      const [o] = await q("SELECT settings FROM organizations WHERE id = $1", [req.ctx.orgId]);
      const settings = { ...o.settings, ...(req.body.aiMonthlyBudgetUsd !== undefined ? { aiMonthlyBudgetUsd: req.body.aiMonthlyBudgetUsd } : {}), retention: { ...o.settings.retention, ...(req.body.retention ?? {}) } };
      await q("UPDATE organizations SET settings = $2 WHERE id = $1", [req.ctx.orgId, JSON.stringify(settings)]);
      await audit(q, { orgId: req.ctx.orgId, userId: req.ctx.userId, action: "org.settings", requestId: req.id, metadata: req.body });
    });
    invalidateBudget(req.ctx.orgId);
    return { ok: true };
  });
  app.get("/api/org/settings", async (req) => { requirePermission(req.ctx, "workflow.read"); const [o] = await s.db.tenant(req.ctx, (q) => q("SELECT name, settings FROM organizations WHERE id = app_org()")); return o; });

  // ---------------------------------------------------------------- workflows
  app.get("/api/people", async (req) => s.workflows.people(req.ctx));
  app.get("/api/workflows", async (req) => s.workflows.list(req.ctx));
  app.post("/api/workflows", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } }, bodyLimit: 16 * 1024 * 1024 }, async (req) => s.workflows.create(req.ctx, req.body ?? {}, req.id));
  app.get("/api/workflows/:id", async (req) => s.workflows.get(req.ctx, req.params.id));
  app.post("/api/workflows/:id/participants", S({ required: ["personId", "participation"], properties: { personId: id, participation: { type: "string" }, remove: { type: "boolean" } } }), async (req) => { await s.workflows.setParticipants(req.ctx, req.params.id, req.body, req.id); return { ok: true }; });
  app.get("/api/workflows/:id/knowledge", async (req) => s.knowledge.listForWorkflow(req.ctx, req.params.id, { limit: Number(req.query.limit) || 50 }));
  app.get("/api/workflows/:id/lessons", async (req) => s.apprentice.lessons(req.ctx, req.params.id));
  app.get("/api/workflows/:id/insights", async (req) => s.analytics.workflowInsights(req.ctx, req.params.id));
  app.get("/api/workflows/:id/experiments", async (req) => s.analytics.experiments(req.ctx, req.params.id));
  app.post("/api/workflows/:id/experiments", S({ properties: { name: { type: "string", maxLength: 120 }, hypothesis: { type: "string", maxLength: 500 }, retestAfterDays: { type: "integer", minimum: 1, maximum: 365 } } }), async (req) => s.apprentice.createExperiment(req.ctx, { workflowId: req.params.id, ...req.body }));

  // ---------------------------------------------------------------- capture sessions
  const aiLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  app.post("/api/sessions", S({ required: ["workflowId"], properties: { workflowId: id, source: { type: "string", maxLength: 60 }, caseRef: { type: "string", maxLength: 20 }, expertPersonId: id, language: { type: "string", enum: LANGUAGE_CODES } } }), async (req) => { const r = await s.capture.startSession(req.ctx, req.body); return s.capture.getSession(req.ctx, r.id); });
  app.get("/api/sessions/:id", async (req) => s.capture.getSession(req.ctx, req.params.id));
  app.post("/api/sessions/:id/consent", S({ required: ["modalities"], properties: { modalities: { type: "array", maxItems: 3, items: { type: "string" } }, clientTime: { type: "number" } } }), async (req) => { await s.capture.grantConsent(req.ctx, req.params.id, req.body); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/privacy", S({ properties: { paused: { type: "boolean" }, retainRaw: { type: "string" }, excluded: { type: "object", additionalProperties: false, properties: { SCREEN: { type: "boolean" }, CAMERA: { type: "boolean" }, MICROPHONE: { type: "boolean" } } } } }), async (req) => { await s.capture.setPrivacy(req.ctx, req.params.id, req.body); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/sim", { ...aiLimit, ...S({ required: ["action"], properties: { action: { type: "string", maxLength: 40 }, param: { type: "string", maxLength: 40 } } }) }, async (req) => { await withAiContext({ requestId: req.id }, () => s.capture.simAction(req.ctx, req.params.id, req.body.action, req.body.param)); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/media", { config: { rateLimit: { max: 900, timeWindow: "1 minute" } } }, async (req, reply) => {
    const h = req.headers;
    reply.status(202);
    return s.capture.uploadMedia(req.ctx, req.params.id, { buf: req.body, modality: String(h["x-modality"] ?? ""), kind: String(h["x-kind"] ?? ""), capturedAt: Number(h["x-captured-at"]), durationMs: Number(h["x-duration-ms"]) || null, diffScore: h["x-diff-score"] !== undefined ? Number(h["x-diff-score"]) : undefined, cycleDiff: h["x-cycle-diff"] !== undefined ? Number(h["x-cycle-diff"]) : undefined, purpose: String(h["x-purpose"] ?? "narration") });
  });
  app.post("/api/sessions/:id/notes", S({ required: ["text"], properties: { text: { type: "string", maxLength: 2000 } } }), async (req) => { await s.capture.addNote(req.ctx, req.params.id, req.body.text); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/end", aiLimit, async (req) => { await s.capture.endTask(req.ctx, req.params.id); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/answer", { ...aiLimit, ...S({ required: ["text"], properties: { text: { type: "string", maxLength: 4000 }, language: { type: "string", enum: LANGUAGE_CODES }, fromDraft: { type: "boolean" } } }) }, async (req) => { await s.capture.answer(req.ctx, req.params.id, { text: req.body.text, language: req.body.language, fromDraft: req.body.fromDraft }); return s.capture.getSession(req.ctx, req.params.id); });
  app.post("/api/sessions/:id/stop", aiLimit, async (req) => { await s.capture.stopQuestions(req.ctx, req.params.id); return s.capture.getSession(req.ctx, req.params.id); });
  app.get("/api/sessions/:id/window", async (req) => s.capture.evidenceWindow(req.ctx, req.params.id, req.query.at, Number(req.query.span) || 6000));
  app.delete("/api/observations/:id", async (req) => s.capture.deleteObservation(req.ctx, req.params.id));

  // ---------------------------------------------------------------- media (authorized, never public)
  app.get("/api/media/:id", async (req, reply) => {
    const c = req.ctx;
    const [a] = await s.db.tenant(c, (q) => q(`SELECT m.*, s.expert_person_id FROM media_assets m LEFT JOIN expert_sessions s ON s.id = m.session_id WHERE m.id = $1`, [req.params.id]));
    if (!a || a.deleted_at || ["purged", "deleted"].includes(a.status)) throw httpError(404, "media not available (deleted or past its retention period)");
    if (a.session_id) { if (!(can(c, "session.read.any") || (can(c, "evidence.read") && c.personId === a.expert_person_id))) throw httpError(403, "not allowed to view this evidence"); }
    else requirePermission(c, "workflow.read");
    // Short-lived signed URL when available; otherwise stream through this authorized endpoint.
    const url = await s.storage.signedUrl(a.storage_key).catch((e) => { log.warn({ err: e.message }, "signed URL unavailable; streaming"); return null; });
    reply.header("Cache-Control", "private, no-store");
    if (url) return reply.redirect(url);
    const buf = await s.storage.get(a.storage_key);
    if (!buf) throw httpError(404, "media not available");
    reply.type(a.mime_type);
    return buf;
  });

  // ---------------------------------------------------------------- knowledge
  app.get("/api/judgments/:id", async (req) => s.knowledge.detail(req.ctx, req.params.id));
  app.post("/api/judgments/:id/validate", S({ required: ["decision"], properties: { decision: { type: "string" }, confirmBoundary: { type: "boolean" }, expectedVersion: { type: "integer" }, edits: { type: "object", additionalProperties: { type: "string", maxLength: 2000 } }, visibility: { type: "string", enum: ["private", "named", "organization"] }, sharedWith: { type: "array", maxItems: 50, items: id } } }), async (req) => { await s.knowledge.validate(req.ctx, req.params.id, req.body); return s.knowledge.detail(req.ctx, req.params.id); });
  app.get("/api/knowledge/mine", async (req) => s.knowledge.mine(req.ctx));
  app.post("/api/knowledge/:id/sharing", S({ properties: { visibility: { type: "string", enum: ["private", "named", "organization"] }, sharedWith: { type: "array", maxItems: 50, items: id },
    sharedGroups: { type: "array", maxItems: 20, items: id },
    restricted: { type: "boolean" }, restrictionNote: { type: "string", maxLength: 500 }, attribution: { type: "string", maxLength: 300 },
    craftContext: { type: "object", additionalProperties: false, properties: Object.fromEntries(["materials", "tools", "conditions", "terms", "sensoryCues", "timing"].map((k) => [k, { type: "string", maxLength: 1000 }])) } } }),
    async (req) => s.knowledge.updateSharing(req.ctx, req.params.id, req.body));
  app.post("/api/knowledge/:id/access-preview", S({ properties: { visibility: { type: "string", enum: ["private", "named", "organization"] }, sharedWith: { type: "array", maxItems: 50, items: id }, sharedGroups: { type: "array", maxItems: 20, items: id } } }),
    async (req) => s.knowledge.accessPreview(req.ctx, req.params.id, req.body));
  app.post("/api/knowledge/:id/withdraw", async (req) => s.knowledge.withdraw(req.ctx, req.params.id));
  app.post("/api/knowledge/:id/peer-confirm", async (req) => s.knowledge.peerConfirm(req.ctx, req.params.id));
  app.post("/api/doc-conflicts/:id", S({ required: ["decision"], properties: { decision: { type: "string" } } }), async (req) => s.knowledge.decideDocConflict(req.ctx, req.params.id, req.body.decision));
  app.post("/api/expert-conflicts/:id/answer", { ...aiLimit, ...S({ required: ["answer"], properties: { answer: { type: "string", maxLength: 2000 } } }) }, async (req) => s.knowledge.answerConflict(req.ctx, req.params.id, req.body.answer));

  // ---------------------------------------------------------------- apprentice
  app.post("/api/attempts", S({ required: ["scenarioId"], properties: { scenarioId: id } }), async (req) => s.apprentice.startAttempt(req.ctx, req.body.scenarioId));
  app.get("/api/attempts/:id", async (req) => s.apprentice.getAttempt(req.ctx, req.params.id));
  app.post("/api/attempts/:id/decide", { ...aiLimit, ...S({ required: ["choice"], properties: { choice: { type: "string", maxLength: 300 }, reasoning: { type: "string", maxLength: 1000 }, expectedVersion: { type: "integer" } } }) }, async (req) => s.apprentice.decide(req.ctx, req.params.id, req.body));
  app.get("/api/scenarios/:id/visual", async (req) => s.apprentice.scenarioVisual(req.ctx, req.params.id));
  app.post("/api/scenarios/:id/review", S({ required: ["approve"], properties: { approve: { type: "boolean" }, answerKey: { type: "string", maxLength: 300 }, criteria: { type: "array", maxItems: 6, items: { type: "string", maxLength: 300 } } } }), async (req) => s.apprentice.reviewScenario(req.ctx, req.params.id, req.body));
  app.get("/api/judgments/:id/scenarios", async (req) => s.apprentice.scenariosForReview(req.ctx, req.params.id));

  // ---------------------------------------------------------------- Missing Knowledge Detective
  app.get("/api/judgments/:id/gaps", async (req) => s.gaps.list(req.ctx, req.params.id));
  app.post("/api/judgments/:id/gaps/reanalyze", aiLimit, async (req) => { await s.gaps.reanalyze(req.ctx, req.params.id); return s.gaps.list(req.ctx, req.params.id); });
  app.post("/api/gaps/:id/answer", { ...aiLimit, ...S({ required: ["text"], properties: { text: { type: "string", maxLength: 3000 }, language: { type: "string", enum: LANGUAGE_CODES }, source: { type: "string", enum: ["typed", "voice", "voice_corrected"] }, original: { type: "string", maxLength: 3000 } } }) },
    async (req) => s.gaps.answer(req.ctx, req.params.id, req.body));
  app.post("/api/gaps/:id/decide", S({ required: ["action"], properties: { action: { type: "string", enum: ["approve", "reject_proposal", "accept_unresolved", "defer", "not_applicable", "reopen"] }, note: { type: "string", maxLength: 500 }, value: { type: "string", maxLength: 2000 } } }),
    async (req) => s.gaps.decide(req.ctx, req.params.id, req.body));

  // ---------------------------------------------------------------- Ask (grounded answers in the learner's language)
  app.post("/api/ask", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, ...S({ required: ["question"], properties: { question: { type: "string", maxLength: 1000 }, workflowId: id, language: { type: "string", enum: LANGUAGE_CODES } } }) },
    async (req) => s.ask.ask(req.ctx, req.body));

  // ---------------------------------------------------------------- language preference
  app.get("/api/languages", async () => Object.entries(LANGUAGES).map(([code, l]) => ({ code, ...l })));
  app.post("/api/me/language", S({ required: ["language"], properties: { language: { type: "string", enum: LANGUAGE_CODES } } }), async (req) => { await s.identity.setLanguage(req.ctx, req.body.language); return { ok: true }; });

  // ---------------------------------------------------------------- analytics
  // ---------------------------------------------------------------- spaces, inbox, invitations
  app.get("/api/spaces", async (req) => ({ spaces: await s.identity.organizationsOf(req.ctx.userId), active: req.ctx.orgId }));
  app.post("/api/spaces", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } }, ...S({ required: ["name", "kind"], properties: { name: { type: "string", maxLength: 80 }, kind: { type: "string", enum: ["personal", "enterprise"] } } }) },
    async (req) => { const r = await s.identity.createSpace(req.ctx, req.body, req.id); policyCache.clear(); return r; });
  app.get("/api/inbox", async (req) => s.notifications.inbox(req.ctx));
  app.post("/api/inbox/read", S({ properties: { ids: { type: "array", maxItems: 100, items: id }, all: { type: "boolean" } } }), async (req) => s.notifications.markRead(req.ctx, req.body));
  app.post("/api/invitations/:id/respond", S({ required: ["accept"], properties: { accept: { type: "boolean" } } }),
    async (req) => { const r = await s.notifications.respondToInvitation({ ...req.ctx, requestId: req.id }, req.params.id, req.body, s.identity.ensurePerson); policyCache.clear(); return r; });
  app.get("/api/admin/invitations", async (req) => { requirePermission(req.ctx, "members.invite"); return s.identity.listInvitations(req.ctx); });
  app.post("/api/admin/invitations/:id/revoke", async (req) => { requirePermission(req.ctx, "members.invite"); return s.identity.revokeInvitation(req.ctx, req.params.id, req.id); });

  // ---------------------------------------------------------------- groups
  app.get("/api/groups", async (req) => s.groups.list(req.ctx));
  app.post("/api/groups", S({ required: ["name"], properties: { name: { type: "string", maxLength: 80 }, description: { type: "string", maxLength: 300 } } }), async (req) => s.groups.create(req.ctx, req.body, req.id));
  app.get("/api/groups/:id", async (req) => s.groups.get(req.ctx, req.params.id));
  app.post("/api/groups/:id", S({ properties: { name: { type: "string", maxLength: 80 }, description: { type: "string", maxLength: 300 }, archive: { type: "boolean" } } }), async (req) => s.groups.update(req.ctx, req.params.id, req.body, req.id));
  app.post("/api/groups/:id/members", S({ required: ["personIds"], properties: { personIds: { type: "array", maxItems: 200, items: id } } }), async (req) => s.groups.addMembers(req.ctx, req.params.id, req.body.personIds, req.id));
  app.delete("/api/groups/:id/members/:personId", async (req) => s.groups.removeMember(req.ctx, req.params.id, req.params.personId, req.id));

  // ---------------------------------------------------------------- KT missions
  const briefSchema = { type: "object", additionalProperties: false, properties: {
    ...Object.fromEntries(["objectives", "outcomes", "decisions", "blindSpots", "questions", "acceptance", "constraints"].map((k) => [k, { type: "array", maxItems: 20, items: { type: "string", maxLength: 400 } }])),
    ...Object.fromEntries(["scope", "outOfScope", "sops", "captureNotes", "languageNotes", "retentionNotes"].map((k) => [k, { type: "string", maxLength: 4000 }])) } };
  const missionProps = { name: { type: "string", maxLength: 140 }, description: { type: "string", maxLength: 2000 }, businessContext: { type: "string", maxLength: 2000 }, domain: { type: "string", maxLength: 80 },
    templateKey: { type: "string", maxLength: 40 }, templateId: id, coordinatorPersonId: id, workflowId: id, targetDate: { type: ["string", "null"], maxLength: 10 }, language: { type: "string", enum: LANGUAGE_CODES },
    experts: { type: "array", maxItems: 20, items: id }, receivers: { type: "array", maxItems: 200, items: id }, receiverGroups: { type: "array", maxItems: 20, items: id },
    captureMethods: { type: "array", maxItems: 4, items: { type: "string", enum: ["audio", "audio_video", "screen", "text"] } }, brief: briefSchema };
  app.get("/api/templates", async (req) => s.missions.templates(req.ctx));
  app.post("/api/templates", S({ required: ["baseKey", "config"], properties: { baseKey: { type: "string", maxLength: 40 }, config: { type: "object" } } }), async (req) => s.missions.saveTemplate(req.ctx, req.body, req.id));
  app.get("/api/missions", async (req) => s.missions.list(req.ctx));
  app.post("/api/missions", S({ required: ["name"], properties: missionProps }), async (req) => s.missions.create(req.ctx, req.body, req.id));
  app.get("/api/missions/:id", async (req) => s.missions.get(req.ctx, req.params.id));
  app.post("/api/missions/:id", S({ properties: missionProps }), async (req) => s.missions.update(req.ctx, req.params.id, req.body, req.id));
  app.get("/api/missions/:id/review", async (req) => s.missions.review(req.ctx, req.params.id));
  app.post("/api/missions/:id/brief-document", { bodyLimit: 4 * 1024 * 1024, ...S({ properties: { title: { type: "string", maxLength: 120 }, text: { type: "string", maxLength: 200000 }, dataBase64: { type: "string", maxLength: 4 * 1024 * 1024 } } }) },
    async (req) => s.missions.uploadBrief(req.ctx, req.params.id, req.body, req.id));
  app.post("/api/missions/:id/send", async (req) => s.missions.send(req.ctx, req.params.id, req.id));
  app.post("/api/missions/:id/respond", S({ required: ["accept"], properties: { accept: { type: "boolean" } } }), async (req) => s.missions.respond(req.ctx, req.params.id, req.body, req.id));
  app.post("/api/missions/:id/confirm-brief", async (req) => s.missions.confirmBrief(req.ctx, req.params.id, req.id));
  app.post("/api/missions/:id/capture", { ...aiLimit, ...S({ properties: { method: { type: "string", enum: ["audio", "audio_video", "screen", "text"] }, source: { type: "string", maxLength: 60 }, caseRef: { type: "string", maxLength: 20 }, language: { type: "string", enum: LANGUAGE_CODES } } }) },
    async (req) => s.missions.startCapture(req.ctx, req.params.id, req.body));
  app.post("/api/missions/:id/status", S({ required: ["status"], properties: { status: { type: "string", enum: ["active", "paused", "blocked", "cancelled"] }, note: { type: "string", maxLength: 500 } } }), async (req) => s.missions.setStatus(req.ctx, req.params.id, req.body, req.id));
  app.post("/api/missions/:id/complete", S({ properties: { exceptionNote: { type: "string", maxLength: 1000 } } }), async (req) => s.missions.complete(req.ctx, req.params.id, req.body, req.id));
  app.post("/api/requirements/:id/decide", S({ required: ["status"], properties: { status: { type: "string", enum: ["satisfied", "partial", "unresolved", "not_applicable"] }, note: { type: "string", maxLength: 500 } } }),
    async (req) => s.missions.decideRequirement(req.ctx, req.params.id, req.body, req.id));
  app.get("/api/storage/report", async (req) => s.storageReport.report(req.ctx));

  // ---------------------------------------------------------------- live Moti, Work Maps, tutoring
  app.post("/api/live/start", S({ properties: { kind: { type: "string", enum: ["screen", "camera"] }, name: { type: "string", maxLength: 120 }, language: { type: "string", enum: LANGUAGE_CODES }, workflowId: id } }), async (req) => {
    const { kind = "screen", name, language, workflowId } = req.body;
    const wf = workflowId ? { workflowId, source: kind === "camera" ? "live:camera" : "live:screen" } : await s.workflows.quickStart(req.ctx, { name, kind }, req.id);
    const session = await s.capture.startSession(req.ctx, { workflowId: wf.workflowId, source: wf.source, language });
    await s.workmaps.markLive(req.ctx, session.id);
    return { sessionId: session.id, workflowId: wf.workflowId, source: wf.source };
  });
  // WebSocket relay to Gemini Live. Authenticated by the session cookie (onRequest hook); same-origin only (no cross-site use).
  app.get("/api/live", { websocket: true }, async (socket, req) => {
    const origin = String(req.headers.origin ?? "");
    const allowed = [cfg.publicOrigin, `http://${req.headers.host}`, `https://${req.headers.host}`];
    if (!req.ctx?.orgId || !allowed.includes(origin)) { socket.send(JSON.stringify({ t: "error", message: "not allowed" })); socket.close(1008, "not allowed"); return; }
    // Buffer from the first moment: the browser may speak before the model session is open (messages would be lost).
    const early = []; const hold = (m) => { if (early.length < 400) early.push(m); };
    socket.on("message", hold);
    socket.early = { messages: early, stop: () => socket.off("message", hold) };
    try {
      const spec = await s.live.prepare({ ...req.ctx, requestId: req.id }, { mode: String(req.query.mode ?? ""), sessionId: String(req.query.session ?? ""), language: req.query.language ? String(req.query.language) : undefined, view: req.query.view === "camera" ? "camera" : "screen" });
      await s.live.attach(socket, { ...req.ctx, requestId: req.id }, spec);
    } catch (e) { socket.send(JSON.stringify({ t: "error", message: e.expose || e.status < 500 ? e.message : "Moti could not start" })); socket.close(1008, "refused"); }
  });
  app.post("/api/live/:id/text", S({ required: ["text"], properties: { text: { type: "string", maxLength: 4000 }, role: { type: "string", enum: ["expert"] } } }),
    async (req) => s.workmaps.liveTurn(req.ctx, req.params.id, { role: "expert", text: req.body.text }));
  app.post("/api/live/:id/finish", S({ required: ["phase"], properties: { phase: { type: "string", enum: ["capture", "debrief"] } } }), async (req) => s.workmaps.finishPhase(req.ctx, req.params.id, req.body.phase));
  app.get("/api/maps", async (req) => s.workmaps.list(req.ctx));
  app.get("/api/maps/catalog", async (req) => s.workmaps.catalog(req.ctx));
  app.post("/api/maps/:id/sharing", S({ required: ["visibility"], properties: { visibility: { type: "string", enum: ["private", "named", "organization"] },
    people: { type: "array", maxItems: 200, items: { type: "string", maxLength: 40 } }, groups: { type: "array", maxItems: 100, items: { type: "string", maxLength: 40 } } } }),
    async (req) => s.workmaps.setSharing({ ...req.ctx, requestId: req.id }, req.params.id, req.body));
  // Guardrail agents. In the app (cookie session): connect, list, revoke, try. For agents (bearer key, no cookies):
  // /agent/v1/check, /agent/v1/map and the MCP endpoint /agent/v1/mcp. Rate-limited per key.
  app.post("/api/maps/:id/agent-keys", S({ properties: { label: { type: "string", maxLength: 80 } } }), async (req) => s.agents.createKey({ ...req.ctx, requestId: req.id }, req.params.id, req.body));
  app.get("/api/maps/:id/agents", async (req) => s.agents.listKeys(req.ctx, req.params.id));
  app.post("/api/maps/:id/agent-keys/:keyId/revoke", async (req) => s.agents.revokeKey({ ...req.ctx, requestId: req.id }, req.params.id, req.params.keyId));
  app.post("/api/maps/:id/check", { ...aiLimit, ...S({ required: ["action"], properties: { action: { type: "string", maxLength: 2000 }, context: { type: "string", maxLength: 4000 } } }) },
    async (req) => s.agents.checkInApp(req.ctx, req.params.id, req.body));
  const agentLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: (req) => `agent:${sha256(String(req.headers.authorization ?? req.ip))}` } } };
  app.post("/agent/v1/check", { ...agentLimit, ...S({ required: ["action"], properties: { action: { type: "string", maxLength: 2000 }, context: {} } }) },
    async (req) => s.agents.check(await s.agents.authenticate(req.headers.authorization), req.body, "rest"));
  app.get("/agent/v1/map", agentLimit, async (req) => s.agents.mapForAgent((await s.agents.authenticate(req.headers.authorization)).map));
  app.post("/agent/v1/mcp", agentLimit, async (req, reply) => {
    const auth = await s.agents.authenticate(req.headers.authorization);
    const body = req.body;
    if (Array.isArray(body)) { const out = (await Promise.all(body.map((m) => s.agents.mcp(auth, m)))).filter(Boolean); return out.length ? out : reply.code(202).send(); }
    const out = await s.agents.mcp(auth, body);
    return out ?? reply.code(202).send();
  });
  app.get("/agent/v1/mcp", async (req, reply) => reply.code(405).header("Allow", "POST").send({ error: "this MCP server answers POST requests (JSON responses, no SSE stream)" }));
  app.get("/api/maps/:id/listen", aiLimit, async (req) => s.workmaps.listen(req.ctx, req.params.id, String(req.query.language ?? "en")));
  app.get("/api/maps/:id/listen/audio", async (req, reply) => {
    const wav = await s.workmaps.listen(req.ctx, req.params.id, String(req.query.language ?? "en"), { audio: true });
    reply.type("audio/wav").header("Cache-Control", "private, max-age=3600");
    return wav;
  });
  app.get("/api/impact", async (req) => s.impact.report(req.ctx));
  app.get("/api/my/sessions", async (req) => s.capture.mySessions(req.ctx));
  app.post("/api/sessions/:id/terminate", S({ required: ["confirm"], properties: { confirm: { type: "boolean", const: true } } }), async (req) => s.capture.terminate({ ...req.ctx, requestId: req.id }, req.params.id));
  app.post("/api/workflows/:id/delete", S({ required: ["confirm"], properties: { confirm: { type: "boolean", const: true } } }), async (req) => s.workflows.remove(req.ctx, req.params.id, req.id));
  app.get("/api/access-requests", async (req) => s.access.list(req.ctx));
  app.post("/api/access-requests", S({ properties: { artifactId: { type: "string", maxLength: 40 }, workMapId: { type: "string", maxLength: 40 }, note: { type: "string", maxLength: 500 } } }), async (req) => s.access.request({ ...req.ctx, requestId: req.id }, req.body));
  app.post("/api/access-requests/:id/decide", S({ required: ["grant"], properties: { grant: { type: "boolean" }, artifactIds: { type: "array", maxItems: 50, items: { type: "string", maxLength: 43 } } } }), async (req) => s.access.decide({ ...req.ctx, requestId: req.id }, req.params.id, req.body));
  app.get("/api/maps/:id", async (req) => s.workmaps.get(req.ctx, req.params.id));
  app.post("/api/maps/:id/confirm", S({ properties: { correction: { type: "string", maxLength: 2000 } } }), async (req) => s.workmaps.confirm(req.ctx, req.params.id, req.body));
  app.get("/api/maps/:id/export", async (req, reply) => {
    const out = await s.workmaps.exportForAgents(req.ctx, req.params.id);
    if (req.query.format === "json") return out.json;
    reply.type("text/markdown; charset=utf-8").header("Content-Disposition", `attachment; filename="work-map-${req.params.id.slice(0, 8)}.md"`);
    return out.markdown;
  });
  app.get("/api/tutor/:id", async (req) => s.workmaps.getRun(req.ctx, req.params.id));

  // ---------------------------------------------------------------- knowledge transfers (Agamya for Work)
  app.get("/api/transfers", async (req) => s.transfers.list(req.ctx));
  app.post("/api/transfers", S({ required: ["workflowId", "expertPersonId", "learnerPersonId", "purpose"], properties: { workflowId: id, expertPersonId: id, learnerPersonId: id,
    scheduledFor: { type: ["string", "null"], maxLength: 40 }, purpose: { type: "string", maxLength: 500 } } }), async (req) => s.transfers.create(req.ctx, req.body));
  app.get("/api/transfers/:id", async (req) => s.transfers.get(req.ctx, req.params.id));
  app.post("/api/transfers/:id/start", S({ properties: { source: { type: "string", maxLength: 60 }, caseRef: { type: "string", maxLength: 20 } } }), async (req) => s.transfers.start(req.ctx, req.params.id, req.body));
  app.post("/api/transfers/:id/status", S({ required: ["status"], properties: { status: { type: "string", enum: ["scheduled", "cancelled", "closed"] } } }), async (req) => s.transfers.setStatus(req.ctx, req.params.id, req.body.status));
  app.get("/api/progress", async (req) => s.transfers.progress(req.ctx, String(req.query.workflow ?? "")));
  app.get("/api/radar", async (req) => s.transfers.radar(req.ctx));

  // ---------------------------------------------------------------- featured Living Knowledge journey (state of the real objects)
  app.get("/api/journey", async (req) => {
    requirePermission(req.ctx, "workflow.read");
    return s.db.tenant(req.ctx, async (q) => {
      const [wf] = await q("SELECT id, name FROM workflows WHERE key = 'kitchen' AND deleted_at IS NULL");
      if (!wf) throw httpError(404, "this space has no featured journey");
      const people = await q("SELECT p.id, p.display_name, wp.participation FROM workflow_participants wp JOIN people p ON p.id = wp.person_id WHERE wp.workflow_id = $1", [wf.id]);
      const teacher = people.find((p) => p.participation === "EXPERT"), learner = people.find((p) => p.participation === "LEARNER");
      const [session] = await q("SELECT id, status FROM expert_sessions WHERE workflow_id = $1 AND expert_person_id = $2 ORDER BY started_at DESC LIMIT 1", [wf.id, teacher?.id ?? null]);
      const [j] = await q("SELECT id, status FROM judgments WHERE workflow_id = $1 AND status <> 'rejected' ORDER BY created_at DESC LIMIT 1", [wf.id]);
      const [a] = j ? await q("SELECT id, visibility, shared_with, status FROM knowledge_artifacts WHERE judgment_id = $1", [j.id]) : [];
      const attempts = learner ? await q("SELECT id, kind, status, result FROM learner_attempts WHERE workflow_id = $1 AND learner_person_id = $2 ORDER BY created_at", [wf.id, learner.id]) : [];
      const sharedWithLearner = Boolean(a && a.status === "active" && (a.visibility === "organization" || (a.visibility === "named" && a.shared_with.includes(learner?.id))));
      const me = req.ctx.personId;
      return {
        workflow: wf, teacher: teacher && { id: teacher.id, name: teacher.display_name }, learner: learner && { id: learner.id, name: learner.display_name },
        viewer: me === teacher?.id ? "teacher" : me === learner?.id ? "learner" : "other",
        session: session ?? null, judgment: j ?? null, artifact: a ? { id: a.id, visibility: a.visibility, status: a.status, sharedWithLearner } : null,
        attempts: attempts.map((x) => ({ id: x.id, kind: x.kind, status: x.status, result: x.result })),
      };
    });
  });

  app.get("/api/analytics/summary", async (req) => s.analytics.summary(req.ctx, req.query.workflow || null));
  app.get("/api/analytics/metrics", async (req) => s.analytics.metrics(req.ctx, req.query.workflow || null));
  app.get("/api/analytics/cost", async (req) => ({ ...(await s.analytics.cost(req.ctx, req.query.workflow || null)), pricing: PRICING, model: MODEL(), operationProfiles: OPERATION_PROFILES, policy: POLICIES.compressed }));
  app.get("/api/analytics/inferences", async (req) => s.analytics.inferences(req.ctx, { sessionId: req.query.session || null, limit: Number(req.query.limit) || 50 }));

  // ---------------------------------------------------------------- voice
  app.post("/api/voice/tts", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, ...S({ required: ["text"], properties: { text: { type: "string", maxLength: 600 } } }) }, async (req, reply) => {
    requirePermission(req.ctx, "workflow.read");
    const wav = await withAiContext({ orgId: req.ctx.orgId, requestId: req.id }, () => voiceProvider(cfg.voice.provider).synthesize(req.body.text));
    if (!wav) throw httpError(503, "speech unavailable");
    reply.type("audio/wav").header("Cache-Control", "no-store");
    return wav;
  });

  // Speech → editable draft text for answers given outside a capture session (gap answers, learner reasoning, Ask).
  // Nothing is stored: the audio is transcribed once and returned; the person edits it and submits text, marked as voice.
  app.post("/api/voice/transcribe", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    requirePermission(req.ctx, "workflow.read");
    if (!Buffer.isBuffer(req.body) || req.headers["content-type"] !== "audio/wav") throw httpError(415, "send audio/wav");
    const expected = LANGUAGE_CODES.includes(req.headers["x-language"]) ? req.headers["x-language"] : null;
    const t = await withAiContext({ orgId: req.ctx.orgId, requestId: req.id }, () => transcribe({ media: { mimeType: "audio/wav", data: req.body.toString("base64") }, expectedLanguage: expected }));
    if (t.source === "fallback") throw httpError(503, "transcription is unavailable right now; please type your answer");
    return { text: t.speechPresent === false ? "" : t.transcript, language: t.language ?? expected, confidence: t.confidence, speechPresent: t.speechPresent !== false };
  });

  // ---------------------------------------------------------------- test hooks (never in production)
  if (cfg.testHooks) {
    app.get("/api/test/scenarios/:id/key", async (req) => { if (!req.ctx) throw httpError(401, "sign in required"); const [x] = await s.db.tenant(req.ctx, (q) => q("SELECT answer_key, rule_action FROM scenarios WHERE id = $1", [req.params.id])); if (!x) throw httpError(404, "not found"); return { answerKey: x.answer_key, ruleAction: x.rule_action }; });
  }

  // ---------------------------------------------------------------- static UI
  await app.register(fstatic, { root: path.join(ROOT, "public"), prefix: "/", index: ["index.html"], cacheControl: false,
    // Unhashed asset names: always revalidate (cheap 304 via ETag) so a deploy never leaves clients on stale modules.
    setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.status(404).send({ error: "not found" }) : reply.sendFile("index.html")));
  return app;
}
