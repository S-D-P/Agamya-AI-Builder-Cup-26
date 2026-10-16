# Data model

PostgreSQL 16 (Cloud SQL in production; PGlite, Postgres compiled to WASM, locally and in tests, with the same SQL). Schema: `src/platform/migrations/001_init.sql` and `002_agamya.sql`, 42 tables. UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere, JSONB only for genuinely variable payloads (judgment chain content, model manifests, settings).

## Design rules

- **Every tenant row carries `org_id`**, enforced by RLS (`org_id = app_org()`, see [SECURITY](SECURITY.md)). Composite indexes lead with `org_id`.
- **Users are global; people are per organization.** A `user` signs in. A `person` is that user's identity *inside one organization* and is the unit that captures expertise, approves, learns and is credited. The same human in two organizations is two people, and their knowledge never crosses.
- **History is appended, not overwritten**: judgment versions, knowledge versions, validations, policy acceptances, audit events and inference logs are append-only for the application role.
- **Evidence is linked, not copied**: knowledge points at observations, which point at media assets, which point at storage keys.
- **Provenance is explicit**: every knowledge field has an epistemic status; every test and validation has a ground-truth source.

## Entities

### Identity and tenancy
| Table | Purpose |
|---|---|
| `users` | Global account: email (case-insensitive unique), scrypt hash, status, lockout counters, last login |
| `user_identities` | External identities (OIDC `provider` + `subject`) linked to a user |
| `organizations` | Tenant ("space"): name, slug, `experience` (`work` \| `living`), `is_demo`, `sample_kind` (per-visitor sample spaces), `settings` (retention per data class, AI monthly budget) |
| `auth_sessions` | Server-side sessions: token hash, CSRF hash, active org, expiry, last seen, hashed IP |
| `memberships` | User ↔ organization with `roles[]` (ORG_ADMIN, WORKFLOW_OWNER, EXPERT, LEARNER, REVIEWER) and status |
| `invitations` | Hashed single-use token, email, roles, expiry |
| `workspaces` | Optional grouping of workflows inside an organization |
| `people` | Per-org person (optionally linked to a user) |

### Policy and consent
| Table | Purpose |
|---|---|
| `policy_documents` | Versioned policy text (platform templates have `org_id` NULL; organizations publish their own) with content SHA-256 |
| `policy_acceptances` | Who accepted which version (hash), when |
| `consent_records` | Per capture session: expert person, modalities, consent-policy version, client clock offset, revocation |

### Workflows (configuration, not code)
| Table | Purpose |
|---|---|
| `workflows` | Name, kind, `key`, modalities, capture sources, status, owner |
| `workflow_participants` | People and their role in a workflow (expert, learner, reviewer) |
| `workflow_documents` | Uploaded SOPs: storage key, hash, extracted text, injection flags |
| `workflow_procedures` | DocumentedProcedure extracted from documents: applies-when, steps, default decision, resolution actions |

### Capture
| Table | Purpose |
|---|---|
| `transfers` | Knowledge-transfer plans: workflow, expert person, learner person, scheduled time, purpose, status (`scheduled` \| `cancelled` \| `closed`), creator |
| `expert_sessions` | One capture (optionally `transfer_id` when started from a transfer plan): status machine (`awaiting_consent → capturing → processing → analyzing → asking → extracting → validating → done / no_judgment / failed`), privacy (`paused`, `excluded`, `retainRaw`), budget counters, current question, gate log |
| `media_assets` | Raw objects: storage key, MIME (sniffed), bytes, SHA-256 (idempotency), captured time, duration, consent, `retention_class`, `expires_at`, status (`uploaded → processed → purged / deleted / failed`) |
| `observations` | L1 events, one per frame, audio chunk, app event or note: modality, text, readings, context plan, confidence, link to a visual moment, security flags, soft delete |
| `transcript_segments` | Time-ranged speech text with speaker person and expiry |
| `session_dialogue` | Questions asked and answers given, with intent and source (typed or voice) |

### Judgments and knowledge
| Table | Purpose |
|---|---|
| `judgments` | A captured judgment (status `observed / approved / rejected`), expert person, procedure, evidence time range |
| `judgment_versions` | Chain content per version (`{value, status, quote, eventIds}` per field: context, observation, decision, reason, condition, exception, boundary, risk, expected outcome; plus the boundary test, default behavior, ObservedExpertBehavior / ExpertExplanation) and what the validators changed |
| `judgment_evidence` | Judgment ↔ observation with role (`trigger`, `moment_frame`, `expert_answer`, `context`) |
| `knowledge_artifacts` | Approved knowledge (one per judgment): status (`active` \| `retired`), last validated, and governance: `contributor_person_id`, `visibility` (`private` \| `named` \| `organization`), `shared_with[]`, `restricted` (+ note; constraint: restricted ⇒ not `organization`), `attribution`, `craft_context` (materials, tools, conditions, sensory cues, timing, terms), `withdrawn_at` |
| `knowledge_versions` | L4 rule text, L5 compact payload, `embedding vector(768)` with an HNSW cosine index |
| `knowledge_validations` | Append-only evidence of validity: EXPERT_CONFIRMED, PEER_CONFIRMED, LEARNER_TRANSFER, LEARNER_BOUNDARY_PASS, LEARNER_OVERGENERALIZED, REVALIDATED, RETIRED, each with a ground-truth source |
| `documentation_conflicts` | Where observed behavior and explanation differ from the documented procedure; decided by an owner (undocumented exception / outdated doc / expert error) |
| `expert_conflicts`, `expert_conflict_answers` | Two experts' approved practices that disagree, the hidden variable, and the reconciliation from the experts' own words |

### Apprentice and evaluation
| Table | Purpose |
|---|---|
| `scenarios` | Tests: `apply` or `counterfactual`, facts, options, answer key, the rule action (to detect overgeneralization), flipped condition, `source` (curated / generated / expert_authored) and `ground_truth_source` |
| `experiments`, `experiment_arms`, `experiment_assignments` | SOP-only vs SOP + captured judgment, with deterministic arm assignment and immediate / delayed-retest phases |
| `learner_attempts`, `learner_steps`, `learner_evaluations` | Each decision, reasoning, hint level and evaluation; the result (initial / final correct, transfer, boundary understood, overgeneralized) |

### AI accounting, jobs, audit
| Table | Purpose |
|---|---|
| `ai_inferences` | One row per model call: operation, model, input types, media count and resolution, context manifest, tokens by modality, cost estimate, latency, status, error category, pipeline (live / benchmark) |
| `ai_usage_daily` | Per-org daily roll-up used by the budget guard |
| `benchmark_runs` | Imported benchmark and adversarial results shown on the Insights screen |
| `jobs` | Queue: kind, payload, idempotency key, status, attempts, max attempts, run-after, lock owner and time, last error |
| `audit_events` | Append-only: actor, action, target, outcome, request id, hashed IP, metadata |

## Epistemic status

Two layers, both computed from evidence and human validation, **never** from model confidence:

- **Per field** of the judgment chain (`EPISTEMIC` in `src/ai/validators.mjs`): `OBSERVED` (must cite real event ids), `EXPERT_STATED` (quote must appear verbatim in the expert's words), `AI_INFERRED`, `INSUFFICIENT_EVIDENCE`. The deterministic validators downgrade any claim that fails its check and record why in `judgment_versions.verification`.
- **Per knowledge artifact** (`levelsOf` in `src/domain/knowledge.mjs`): `OBSERVED` → `EXPERT_CONFIRMED` (the authoring expert approved) → `MULTI_EXPERT_CONFIRMED` (≥2 different experts) → `LEARNER_VALIDATED` (≥1 successful transfer and ≥1 counterfactual boundary pass), plus the warning states `CONFLICTED` (open expert disagreement), `STALE` (not validated for 180 days, configurable) and `INSUFFICIENT_EVIDENCE` (decision, reason or condition lacks evidence, so it is not safe to apply).

Model confidence is stored, shown as "self-reported, not used as evidence", and nothing else.

## Ground-truth source (per test and validation)

`EXPERT` · `REVIEWER` · `MODEL_DERIVED` · `SYNTHETIC`. Transfer metrics are reported per source; "human-validated" means EXPERT or REVIEWER only.

## Scalability notes

- Hot paths are indexed by `(org_id, …)`: sessions by workflow, observations by `(session_id, captured_at)`, judgments by workflow, validations by artifact, audit by `(org_id, created_at)`; ready jobs by a partial index on `run_after WHERE status = 'queued'`, and per-session job lookups by `(payload->>'sessionId', status)`.
- Raw bytes never live in Postgres; rows hold keys. Database growth is dominated by observations (bounded text) and inference logs. Both are good partitioning candidates by month if a tenant reaches tens of millions of rows. Partitioning is not implemented.
- pgvector HNSW serves top-k retrieval per workflow. At expected volumes (thousands of rules per organization), a dedicated vector database is unnecessary.

## Migration 003: Detective, Stress Test, language (`src/platform/migrations/003_detective_stress_language.sql`)

All additions have safe defaults; existing rows keep working.
- **`knowledge_gaps`** (RLS, tenant-scoped):
  - columns: `kind` (8 kinds), `field`, `missing`, `why_it_matters`, `evidence_observation_ids`, `basis` (`AI_INFERRED` | `RULE`), `question` and its language;
  - `status`: open, answered, resolved, accepted_unresolved, deferred or not_applicable;
  - the answer with its original transcript, language and source (`typed` | `voice` | `voice_corrected`);
  - the AI `proposal` with `proposal_source`, the `applied_version`, and the decision with who made it.
  - `UNIQUE (judgment_id, dedupe_key)` makes re-analysis idempotent.
- **`scenarios`:**
  - `kind` adds `boundary` and `insufficient`;
  - `review_status` (generated cases are `draft` until approved; curated and older rows are `approved`);
  - `criteria` (jsonb) and `language`.
- **`users.preferred_language`.**
- **`expert_sessions`:** `language` and `answer_draft` (a spoken answer awaiting the speaker's confirmation).
- **`session_dialogue`:** `question_language`, `answer_language`, `answer_original`, `answer_source`.
- **`learner_evaluations`:** `criteria_met`, `understood`, `missing`, `language`.

## Migration 004: spaces, groups, missions, notifications, storage reuse (`004_spaces_missions_groups.sql`)

Additive only: no column or table is dropped.
- **Roles.** The roles CHECK constraint is replaced by a wider one (ORG_OWNER, KT_COORDINATOR and AUDITOR added). Existing spaces: the earliest administrator becomes owner.
- **Invitations:** `status` (pending, accepted, declined, revoked, expired), `declined_at`, `revoked_at`, `revoked_by`. Existing accepted rows are back-filled.
- **`groups` / `group_members`:** soft removal (`removed_at`), unique name per space, RLS.
- **`knowledge_artifacts.shared_groups`:** groups an artifact is shared with, resolved at read time.
- **`kt_templates`:** organization templates (built-in templates are code).
- **`kt_missions`:**
  - the brief as structured JSON;
  - `brief_version`, plus confirmation by the expert and the version confirmed;
  - capture methods and retention;
  - explicit status only;
  - `exception_note`.
- **`mission_participants`:** expert or receiver, `via_group_id`, and a status (pending, invited, accepted, declined, removed).
- **`mission_groups`** and **`mission_requirements`:**
  - requirement kind and status;
  - `basis` (NONE, AI_VERIFIED, AI_INFERRED, PERSON);
  - evidence quotes;
  - who decided;
  - `retired_at` when the brief changes.
- **`expert_sessions.mission_id`.**
- **`notifications`:** per user, `UNIQUE (user_id, dedupe_key)`. RLS lets only the recipient read or update a notification. Inserts go through `app_notify()` (SECURITY DEFINER), which accepts only an active member of the current space.
- **`media_assets.dedup_of`**, plus an index on (org, sha256), for content-addressed reuse inside a space.
- **`derived_cache`:** cached derived answers keyed by a hash of the input, language, model and source versions.

Verified on PGlite (in-memory PostgreSQL, the test engine) by the full test suite. **Not yet applied to Cloud SQL**: no PostgreSQL server is available on the development machine, and nothing was deployed.
