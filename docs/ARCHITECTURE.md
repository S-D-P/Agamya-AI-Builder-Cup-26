# Architecture

Agamya captures how an expert actually makes a judgment during real work, asks *why* only when a decision depended on judgment, structures the answer into an evidence-linked judgment chain, has the expert approve it, and teaches it to the next person with cases they have not seen, including nearby cases where the expert's rule should **not** apply. It then measures whether the knowledge transferred.

One engine serves two experiences, selected by the type of space (`organizations.experience`):
- **Agamya for Work** (`work`): knowledge-transfer plans between employees, a knowledge library per workflow, learner progress, insights and AI cost. Approved knowledge defaults to the people who learn the workflow, which is disclosed before capture.
- **Agamya for Living Knowledge** (`living`): skills, a teacher and learners, private-by-default knowledge with contributor-controlled sharing, craft context and withdrawal. The featured sample is a mother teaching her daughter to make ghee.

Both use the same capture, evidence, judgment, boundary, compilation, retrieval and transfer code. What differs is the governance default, the words and the screens.

This document describes the code as it is. Companion documents: [SECURITY](SECURITY.md), [THREAT_MODEL](THREAT_MODEL.md), [DATA_MODEL](DATA_MODEL.md), [MEDIA_ARCHITECTURE](MEDIA_ARCHITECTURE.md), [AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md), [AI_COST_MODEL](AI_COST_MODEL.md), [DATA_LIFECYCLE](DATA_LIFECYCLE.md). The review that motivated this design is [ARCHITECTURE_REVIEW](ARCHITECTURE_REVIEW.md).

## Shape: a modular monolith plus async workers

```
 Browser (vanilla ES modules, no build step)
   │  HTTPS · cookie session + CSRF header · binary media uploads
   ▼
 ┌──────────────────────── one Node 24 codebase, one container image ────────────────────────┐
 │ PROCESS_ROLE=api     Fastify: auth hook → RBAC → domain modules → Postgres (RLS) / storage  │
 │ PROCESS_ROLE=worker  job loop (FOR UPDATE SKIP LOCKED) + hourly lifecycle scheduler        │
 │ PROCESS_ROLE=all     both, for local development                                           │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
   │                       │                          │
   ▼                       ▼                          ▼
 PostgreSQL              Object storage             Vertex AI
 (Cloud SQL / PGlite)    (GCS / local disk)         Gemini 2.5 Flash · TTS · text-embedding-005
 RLS · pgvector · jobs   org-namespaced keys
```

Deliberately **not** present: Kubernetes, Kafka, a separate vector DB, a graph DB, microservices. PostgreSQL is the system of record, the job queue (`jobs` table), and the vector index (`pgvector` HNSW). At the scale of one enterprise tenant per org, these are sufficient, and each removes an operational dependency. The API and worker split is a deployment knob, not a code fork. Both run the same modules.

## Code layout

| Path | Responsibility |
|---|---|
| `server.mjs` | Entry point; `PROCESS_ROLE` selects api / worker / all; graceful SIGTERM shutdown |
| `src/config.mjs` | All environment configuration; production refuses to start without Postgres, GCS, an https origin and an IP-hash salt |
| `src/app.mjs` | Service wiring (`buildServices`), HTTP surface (`buildServer`), scheduler |
| `src/platform/` | Infrastructure adapters with no domain knowledge: `db` (system/tenant transactions, migrations), `storage` (GCS/local), `jobs` (queue + worker), `authz` (permission matrix), `audit`, `security` (passwords, tokens, MIME sniffing, PDF inspection, injection scan), `logger` (structured, redacted) |
| `src/domain/` | Business modules, each owning its tables and jobs: `identity`, `policy`, `workflows`, `capture`, `knowledge` (incl. governance: visibility, sharing, restriction, withdrawal), `apprentice`, `transfers` (plans, disclosure, learner progress), `analytics`, `seed` (shared demo org and per-visitor sample spaces) |
| `src/ai/` | Model boundary: `gemini` (single call path, budget guard, accounting), `voice` (text-to-speech provider interface; Google by default), `prompt` (trust-segmented prompts), `context` (context budget manager), `gate` (interruption decision), `validators` (deterministic checks on model output), `ops/` (perception, judgment, teaching operations) |
| `src/sim/` | Simulated capture sources (payments console, revenue sheet, loom camera, kitchen camera). These are *sources*, rendered to real PNG frames and fed through the same upload → storage → job path as live capture |
| `public/` | UI (no build step): `app.js` (two shells: work sidebar, living top navigation), `core.js` (state, API client), `components.js`, `persona.js` (Moti, the companion), `capture.js` (camera/mic/screen), `views/*` (landing, journey, skills, sharing, transfers, progress, session, knowledge, lessons, insights, admin) |
| `tests/` | `node --test`: unit, security (incl. cross-tenant IDOR), AI contract, media pipeline, governance and transfers. `TEST_DATABASE_URL` runs the same suites through the `pg` driver |
| `scripts/` | Live evaluations against Gemini: `acceptance`, `adversarial`, `benchmark`, `detect-stability`; `deploy/cloudrun.sh` |

## The core loop (unchanged concept, hardened implementation)

1. **Workflow** (configuration, not code): modalities, capture sources, documented procedure, participants. `understand_workflow` extracts procedures from the uploaded SOP, treated as *external document content* (lowest trust).
2. **Consent → capture**: only the expert being captured can consent; consent records the exact policy version and modalities. Frames, audio chunks and video chunks upload as binary to `/api/sessions/:id/media` and return `202` with a job id.
3. **Perception jobs** (`process_frame`, `process_audio`): each observation gets a context plan (use text / vision at a chosen resolution / drop as stable / evidence only / transcribe). Raw bytes are always stored. What is *sent* to the model is minimized (see [AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md)).
4. **Natural break → `analyze_session`**: waits (RetryLater) until pending media is processed, runs `detectJudgment` over a bounded event window plus the documented procedure plus the top-k approved knowledge, then the deterministic `gate()` decides whether the moment deserves the expert's time.
5. **Question → answer → `process_answer`**: answers (typed or spoken) are verified. Quotes must appear verbatim in the expert's words, and boundaries are confirmed only from what the expert said. At most two follow-ups.
6. **Finalize**: a versioned judgment with per-field epistemic status, evidence links, documentation conflicts, and a cross-expert consistency check.
7. **Expert approval → knowledge**: only the captured expert (person) can approve, correct or reject. Approval creates a knowledge artifact with its **sharing policy** (living spaces: private; workplaces: the workflow's learners unless the expert keeps it private) and enqueues `compile_knowledge` (rule plus embedding), `generate_scenarios` (MODEL_DERIVED tests) and `retention_session` (purge non-evidence raw media).
7b. **Governance**: one SQL visibility predicate (`visibleSql`) is applied on every read path (lists, detail, lessons, attempts, scenario visuals) and a stricter one on AI retrieval, so private knowledge never reaches other people or other people's AI context. Contributors change sharing, restriction, attribution and craft context, or withdraw. See [GOVERNANCE](GOVERNANCE.md).
8. **Lessons**: a new case, then a counterfactual nearby case. Correctness is decided deterministically against the answer key. Gemini only coaches, with a leak guard so hints never reveal the answer. Transfer, boundary understanding and overgeneralization are recorded by ground-truth source.
9. **Knowledge transfers (Work)**: a manager plans expert → learner for a workflow with a purpose and date. The expert sees a disclosure (what is captured, why, who sees the result, retention, controls) and starts capture from the plan (`expert_sessions.transfer_id`). Progress per learner and per piece of knowledge: not started, in progress, **demonstrated in simulation**, **needs supervision**, with gaps from the evaluations and open questions from the knowledge itself.
10. **Sample spaces**: the landing page creates an isolated, per-visitor space (`organizations.sample_kind`) with password-less sample people, a small AI budget and a daily cap. A visitor can switch between people only inside their own space.

## Additions in the expansion round
| Module | Role |
|---|---|
| `src/ai/ops/detective.mjs` | Rule gaps (deterministic, en/mr templates); AI gap detection (drops uncited or generic gaps); gap answer → proposed change (quote-verified); grounded answers for Ask (citations verified, ungrounded answers withheld) |
| `src/domain/gaps.mjs` | Jobs `detect_gaps` and `propose_gap_change` (idempotent, bounded); answer and decide (contributor only, audited, versioned); re-analysis capped at 6 runs per judgment |
| `src/domain/ask.mjs` | `POST /api/ask` over visible approved knowledge, replying in the question's language |
| `src/ai/language.mjs` | Language registry (en and mr tested; hi present but untested and not offered); script share; the content-language instruction added to prompts |
| `src/domain/transfers.mjs` → `radar()` | Knowledge Loss Radar from rules over records ([RADAR](RADAR.md)) |
| `POST /api/voice/transcribe` | Speech → editable draft text for gap answers, learner reasoning and Ask. Nothing is stored; 10/min; budget-guarded |
| `public/js/views/detective.js`, `radar.js`, `ask.js`, `public/js/i18n.js`, `public/js/a11y.js` | Gap cards, stress-test review, Radar, Ask, language selects, live announcer, dialog focus return |

No new infrastructure: the same Cloud Run services, Cloud SQL, Cloud Storage and Vertex AI.

## Additions in round 2 (spaces, groups, missions)
| Module | Role |
|---|---|
| `src/platform/authz.mjs` | Roles widened (owner, coordinator, auditor); new permissions for missions, groups, invites |
| `src/domain/groups.mjs` | Groups, members, resolution (`resolveGroupMembers`), audit, notifications |
| `src/domain/missions.mjs`, `templates.mjs`, `src/ai/ops/missions.mjs` | Missions: templates, brief parsing, Moti's summary, requirement checking with verified quotes, lifecycle derived from records, jobs `assess_mission`, `mission_sweep` |
| `src/domain/notifications.mjs` | Inbox, read state, invitation accept/decline (identity proven by sign-in) |
| `src/platform/blobs.mjs` | Content-addressed reuse inside a space; reference-counted deletion |
| `src/domain/storage-report.mjs` | Storage and AI report by layer |
| `public/js/views/spaces.js`, `groups.js`, `missions.js`, `storage.js` | Spaces and inbox, groups, mission wizard and overview, storage report |

Still no new infrastructure: the same Cloud Run, Cloud SQL, Cloud Storage and Vertex AI.

## Request path

`onRequest` auth hook: Origin check on state-changing requests → session cookie resolve (absolute + idle expiry) → CSRF header check → policy gate (`428` until current policies are accepted) → `req.ctx = { userId, orgId, roles, personId }`, derived **only** from the server-side session. Handlers call domain functions with `ctx`. Domain functions call `requirePermission(ctx, …)` and run their SQL inside `db.tenant(ctx, …)`, which `SET LOCAL ROLE app_rw` and sets `app.org_id`, so PostgreSQL RLS enforces isolation even if a query forgets its `WHERE org_id`.

## Asynchronous work

`jobs` table with idempotency keys, `FOR UPDATE SKIP LOCKED` claiming, exponential backoff, dead-lettering after `max_attempts` (default 4), stale-lock recovery, `RetryLater` (re-queue without consuming an attempt), and per-session serialization so one session's jobs never race. Model calls never run inside a database transaction.

| Job | Trigger | Does |
|---|---|---|
| `understand_workflow` | workflow created | procedures + suspicious-instruction flags from the SOP |
| `process_frame` / `process_audio` | media upload | plan → interpret or transcribe → observation (+ transcript segment) |
| `analyze_session` | expert signals a natural break | detection + gate → question or "no judgment" |
| `process_answer` | expert answers | verify, extract, boundary, follow-up or finalize |
| `compile_knowledge` | approval | IF/THEN/BUT IF rule + embedding (L5) |
| `generate_scenarios` | approval | new + counterfactual tests, validated deterministically |
| `retention_session` | approval | purge non-evidence raw media; promote evidence to knowledge retention |
| `lifecycle_sweep` | hourly per org | expire raw media and transcripts past their class's retention |

## Deployment (Google Cloud)

`scripts/deploy/cloudrun.sh` (idempotent; creates billable resources) has two profiles:
- **demo** (default): one Cloud Run service `agamya` with `PROCESS_ROLE=all`, CPU always allocated while an instance runs, **scales to zero** when idle, sample spaces on with a $1 monthly AI budget each and a cap of 60 new sample spaces per day.
- **production**: `agamya-api` (`PROCESS_ROLE=api`, scale 0–10, concurrency 40) and `agamya-worker` (`PROCESS_ROLE=worker`, internal ingress, min 1 instance, CPU always on; additional workers are safe thanks to SKIP LOCKED). Sample spaces off.

Both use:
- **Cloud SQL for PostgreSQL 16** (Enterprise edition, `db-f1-micro` by default) with `vector`, automated backups, reached through the Cloud SQL connector (unix socket).
- **Cloud Storage**: private bucket, uniform access, public access prevention; V4 signed URLs minted via IAM signBlob (no key files), with a fallback to streaming through the authorized endpoint.
- **Secret Manager**: `DATABASE_URL`, `IP_HASH_SALT`, optional OIDC client secret.
- **Vertex AI** via the runtime service account (`roles/aiplatform.user`); least-privilege roles only.
- Health: `/readyz` (database + storage; used by the deploy script). `/healthz` (liveness) answers inside the container, but Cloud Run's front end intercepts that path from outside. Logs: JSON on stdout with Cloud Logging `severity`, request id, tenant id, latency, error category; secrets and content redacted.
- Migrations run at boot under a Postgres advisory lock, so concurrent instances are safe.

Lessons from the first deployment, now handled in code and the script:
- **Fonts in the container.** Simulated frames carry text the model must read (timers, dials, console lines). In the slim Linux image resvg found no fonts through system discovery, so text was silently dropped and the model saw "an orange screen" instead of "12:00". The renderer now points resvg at the font directories explicitly, and the server logs a self-check at boot (`simulated frames: text rendering ok`).
- **Public access.** Early deploys kept coming up private. The cause was the script's `PUBLIC` variable: Windows already defines `PUBLIC` (the shared user folder), so the default never applied and each deploy reset the service to private. The variable is now `PUBLIC_ACCESS`, and public access uses Cloud Run's `--no-invoker-iam-check`, applied as the last step. The app still requires sign-in or a private sample space.
- **One canonical origin.** Cloud Run answers on two hostnames; the origin is set to the deterministic URL at deploy time and other hosts are redirected, because cookies and Origin checks are bound to it.
- **Cloud Build identity.** Builds run as a dedicated `agamya-build` service account with its own staging bucket rather than widening the project's default compute account.

Deployment status and the verified URL are recorded in [SUBMISSION](SUBMISSION.md).

## Local development

```bash
npm install
cp .env.example .env    # set GOOGLE_CLOUD_PROJECT; gcloud auth application-default login
npm start               # http://localhost:3200: landing page; sample spaces on; shared demo org seeded for scripts
npm test                # 66 offline tests (fake model)
```

## Known limits (honest)

- Detection is probabilistic: 34/35 agreement with designer labels across 7 scripted cases × 5 runs, with one miss on the pixel-only spreadsheet case. All ground truth in these runs is SYNTHETIC (designer-authored).
- Benchmarks are single runs on scripted cases; they show direction and magnitude, not statistical significance.
- Email delivery is not implemented; invitations are links shared out of band, and transfer participants see their transfers when they sign in.
- Policy texts are templates, explicitly marked "not legal advice".
- Live screen capture uses the browser's `getDisplayMedia`; there is no desktop agent for application events. App-event capture exists only in simulated sources.
