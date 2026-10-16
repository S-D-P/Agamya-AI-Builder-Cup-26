# Architecture review: v2 (POC → product slice), before enterprise hardening

Baseline at review time: live acceptance suite green (new workflow → camera + voice capture → judgment → boundary →
approval → learner transfer → counterfactual → multi-expert hidden variable), 11/11 deterministic tests,
benchmark 71–77% token reduction at equal judgment recall (4/4) and false alarms (0/3).

## Current architecture (as built)

| Area | What exists | Classification |
|---|---|---|
| Frontend | Vanilla ES modules, hash router, full `innerHTML` re-render per state change, event delegation, no build step | **Prototype-grade.** Simple and CSP-friendly, but re-rendering loses keyboard focus, no auth screens, no a11y pass |
| Backend | `node:http` with a regex route table in `server.mjs`; no middleware chain; errors returned as `{error}` | **Prototype-grade.** No request ids, auth, rate limits, schema validation, security headers, graceful shutdown |
| Gemini / Vertex AI | `lib/gemini.mjs`: JSON-schema output, local validation, timeouts, never throws, real per-modality token ledger, TTS, embeddings | **Production-worthy core.** Missing: a model adapter for tests, prompt trust boundaries, budget enforcement |
| AI operations | `lib/ops/*`: one structured operation per job (detect, question, extract, boundary, conflict, reconcile, scenarios, tutor, evaluate) with fallbacks | **Production-worthy shape.** Fragile semantics: "outcome" ambiguity; extraction can relabel another expert's practice as "documented"; per-field provenance only partially verified |
| Deterministic guards | verbatim quotes, verbatim boundary quote, stated-exception cross-check, interruption gate, generated-test validation, hint leak guard | **Production-worthy and novel.** Needs extending to every knowledge field |
| Embeddings / retrieval | `text-embedding-005`, cosine in process over all approved judgments | **Prototype-grade.** O(n) in memory; fine for hundreds, not millions |
| Storage | `lib/repo.mjs`: one JSON file (all collections) + raw files on disk; debounced full-file rewrite | **Fragile / missing for production.** Single-process, no transactions, whole DB in memory, no tenancy, no concurrency control |
| Media | Browser frame sampler + WAV recorder exist but untested; simulated feeds render SVG→PNG; raw stored as files | **Prototype-grade.** Synchronous ingestion inside the request; no chunking, no async jobs, no idempotency, no temporal model beyond `ts` |
| Authentication | none | **Missing** |
| Authorization / RBAC | none (any caller can do anything) | **Missing** |
| Tenancy | none | **Missing** |
| Consent / policies | per-session pause/exclude screen/camera; no consent record, no policy versions, no microphone exclusion | **Partially missing** |
| Workflow engine | workflow-as-data; three demo workflows + user-created; capture sources | **Production-worthy concept.** Demo data and sim sources live in code (fine as seeds) |
| Knowledge engine | judgments with chain fields, boundary, provenance, levels computed deterministically | **Production-worthy concept, prototype persistence.** No versioning, no artifact/version split |
| Evaluation engine | transfer, boundary understanding, overgeneralization, knowledge risk, benchmark | **Production-worthy metrics.** Ground truth not labelled by source; demo keys are designer-authored and generated keys model-derived |
| Observability | `console.log` of Gemini calls | **Missing** (no structured logs, request correlation, health endpoints) |
| Deployment | Dockerfile, never built or deployed | **Missing** |
| Unnecessarily complex | three benchmark pipelines live in the request-path engine (`policy`); acceptable because it is one switch; the `TEST_HOOKS` endpoint must never ship enabled | — |

## Decisions for the target architecture

1. **Modular monolith, two process roles from one image**: `api` (Cloud Run service) and `worker` (Cloud Run
   service with always-on CPU). No microservices: every module shares one transactional database, and the boundaries
   are code modules with explicit interfaces.
2. **PostgreSQL is the system of record** (Cloud SQL in production, PGlite, a real PostgreSQL engine, locally and in tests).
   Same migrations everywhere. **pgvector** inside Postgres for retrieval, not a separate vector database.
3. **Tenant isolation enforced by the database**: every tenant row carries `org_id`; Row-Level Security policies keyed on
   a per-transaction `app.org_id` setting, with the application connecting as a non-owner role (`FORCE ROW LEVEL SECURITY`).
   The data-access layer sets the tenant from the authenticated session, never from client input.
4. **Object storage for all media** (Cloud Storage in production, local filesystem in development), keys namespaced by
   organization, objects referenced from `media_assets`. No blobs in SQL.
5. **Postgres-backed durable job queue** (`jobs` table, `FOR UPDATE SKIP LOCKED`, idempotency keys, retries with
   backoff). No Pub/Sub or Kafka: the job volume fits in Postgres, it stays transactional with the data it changes, and Cloud Tasks
   can be added later as a dispatcher without changing job semantics.
6. **Fastify** for the HTTP layer: schema validation, hooks for auth/tenancy/CSRF, `pino` structured logs, helmet CSP,
   rate limiting.
7. **Identity separate from authorization**: opaque server-side sessions (random 256-bit token, SHA-256 hash stored,
   HttpOnly/Secure/SameSite cookie), scrypt password hashing from Node's crypto, OIDC (authorization code + PKCE) adapter for
   Google Workspace / enterprise SSO. Roles and permissions live in `memberships`, checked server-side per request.
8. **AI trust boundaries**: prompts assembled from labelled segments (system policy → platform policy → workflow config →
   expert knowledge → user input → observed content → external documents); untrusted segments are fenced, neutralised
   and never allowed to carry instructions; every output schema-validated and evidence-verified before persistence.
