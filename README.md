# Agamya

**Make hidden knowledge accessible, without losing the context that makes it valuable.**

Most knowledge systems preserve information. Agamya preserves the *reasoning behind action*: why an experienced person made a choice, which signal they noticed, when their rule stops applying, and what a beginner would get wrong. Then it checks that someone else can apply it.

> *agamya* (Sanskrit): beyond reach, hard to approach. The knowledge people carry in their heads and hands.

One knowledge engine, two experiences:

| | **Agamya for Work** | **Agamya for Living Knowledge** |
|---|---|---|
| For | Organizations handing over expertise between employees | Families, crafts and communities preserving skills |
| Journey | A manager plans a **knowledge transfer** (expert → learner); the expert captures from the plan; the manager sees what transferred | A **teacher** shows a skill; Agamya asks about the choices that matter; the teacher decides who may learn from it |
| Sharing default | Shared with people who learn the workflow (disclosed before capture) | **Private**; shared only by the teacher's explicit choice |
| Sample | Northwind Operations: mainframe payments, hand-loom weaving, revenue reporting | **Featured journey:** Lakshmi teaches her daughter Meera to make ghee |

**Category:** Future of Work & Enterprise Productivity (Google Cloud AI Builder Cup 2026).

## The pipeline

```
Observe → Notice judgment → Ask why → Expert approves → Find the boundary → Compile → Test transfer → Measure
```

1. **Observe** only authorized inputs (camera, screen, microphone, documents; app events where integrated). Each observation is timestamped and planned for the cheapest sufficient AI context; raw media is stored, not resent.
2. **Notice judgment.** Gemini proposes candidates with a strict contract (action, outcome, alternatives, evidence of a choice). A deterministic gate decides whether the moment is worth interrupting the expert.
3. **Ask** one short, context-aware question at a natural pause; follow up only to confirm the boundary.
4. **Validate.** The expert approves, corrects (a new version; history kept) or rejects. Every field is labeled *observed*, *expert stated* (verbatim quote checked), *AI inferred*, or *insufficient evidence*. Open questions are listed.
5. **Boundary.** When the rule applies, when it doesn't, and what the normal way is, confirmed only from the expert's own words.
6. **Compile** a versioned artifact: decision, rationale, signals, conditions, exceptions, risk, evidence, provenance, sharing policy and, for crafts, materials, tools, conditions, sensory cues, timing and local terms written by the teacher.
7. **Test transfer** with a new case *and* a counterexample where the rule must not be applied. Correctness is checked against the approved answer key; Gemini only coaches, with a guard that stops hints from revealing the answer.
8. **Measure** demonstrated transfer per learner: *demonstrated in simulation*, *needs supervision*, gaps (missed condition, overgeneralization, wrong reason). This is evidence of understanding, **not** verified on-the-job proficiency.

### Round 3: Live Moti (Agamya for Work and Agamya for Culture)
- **Choose, consent, work.** On the landing page you pick **Work** (share your screen) or **Culture** (camera). After one consent card you are in the work. There are no sample spaces or demo data in the product (samples now exist only for tests).
- **Moti, live.** Gemini Live on Vertex AI sees changed frames and hears you. It stays quiet while you work and asks one short question at a natural pause, with at least one about a guardrail. It speaks your language. Off the record at any time; personal data is redacted before anything is stored.
- **Work Map.** Steps a newcomer can follow. Each has its screen moment, the decision, the reason **in the expert's own words** (verified verbatim, otherwise labelled AI-inferred), guardrails, and what is still unclear.
- **Debrief and teach-back.** Moti asks what is unclear, explains the process back, and the expert confirms. Only confirmed maps can be practised or exported for AI agents.
- **Tutor.** A new hire shares their screen. Moti teaches in their language (verified live in Hindi and Kannada), stops a wrong decision ("Asha would stop here. Why do you think?") and replays the expert's moment.
- **Guardrail agents** ([AGENTS](docs/AGENTS.md)):
  - A confirmed Work Map answers AI agents asking "would the expert stop here?", over REST and **MCP**, with per-map revocable keys.
  - The answer is STOP, ASK, PROCEED or NOT_COVERED, with the expert's own words taken from the map.
  - A **Google ADK** agent (`agents/guardrail_agent`), deployed on **Vertex AI Agent Engine**, uses it before every action.
- **Impact:** what Agamya did in a space, counted from its records, never estimated. It covers:
  - expert minutes and questions per 10 minutes;
  - maps confirmed and the share in the expert's own words;
  - wrong decisions stopped in practice, and whether learners need fewer stops on repeat;
  - agent checks handed back to a person;
  - languages used, and AI cost per confirmed map.
- **Listen:** a confirmed Work Map as a short spoken lesson in 15 languages (Gemini narration + Gemini TTS), with a transcript. Quotes are kept word for word. Languages not yet reviewed by a native speaker are labelled.
- Monochrome app; colour only in the landing animation (an original, code-drawn painted stage: Kathak in Jaipur, weaving in Phulia, a swordsmith in Seki, a vocal coach in Seoul, debugging in Bengaluru, an investment call in Singapore, each melting into the next).
- Details, measured results and limits: [LIVE_MOTI](docs/LIVE_MOTI.md).
- **Evaluated on public data** ([EVALUATION](docs/EVALUATION.md)):
  - personal-data masking on ai4privacy (43k sentences);
  - Work Map grounding on YouCook2 (real annotated procedures): coverage, invented evidence, step order, quote verification.

### Round 1 additions
- **Missing Knowledge Detective.** After a capture, Agamya lists what a newcomer would still need: missing prerequisites, undefined signals, unexplained actions, missing reasons, unrecorded exceptions, contradictions, unsupported assumptions, when to escalate.
  - Each gap has its evidence, why it matters, its status and one precise question.
  - The expert answers (typed or spoken, in their language). The AI drafts the change with a verified quote, and nothing changes until the expert approves. The approved change becomes a new version and the gaps are re-checked.
- **Judgment Stress Test.** Four case types: ordinary, boundary, counterexample, missing information.
  - The expert approves each case, its expected answer and its criteria before any learner sees it.
  - Learners get credit for stopping to ask when the deciding signal is missing.
  - Outcomes are labelled only as "demonstrated in simulation", "needs further practice" or "requires supervision".
- **Knowledge Loss Radar.** Per workflow: what is at risk, which records say so, and the next action. Rules over real records, with no scores ([RADAR](docs/RADAR.md)).
- **Marathi.** Capture, follow-up questions, gaps, cases, coaching and Ask work in Marathi, with code-switching. Original words are kept, and translations are labelled. Spoken input is always a reviewable draft ([MULTILINGUAL](docs/MULTILINGUAL.md)).
- **Accessibility.** Targets WCAG 2.2 AA, with automated axe checks on every route and manual checks ([ACCESSIBILITY](docs/ACCESSIBILITY.md)); this is not a conformance claim.

### Round 2: Personal and Enterprise spaces, KT missions
- **Two modes, one engine.** *Agamya Personal* (families, crafts, communities; private by default) and *Agamya Enterprise* (organizations). One person can belong to both. Roles are per space: owner, administrator, KT coordinator, subject matter expert, receiver, auditor.
- **KT missions.**
  - A guided wizard: identity, template (or General/Custom), the KT Mission Brief, then review of the resolved recipients.
  - Moti summarises the brief for the expert to confirm, and the brief guides questions, gaps and practice cases.
  - Requirements are tracked with verified evidence.
  - The lifecycle is derived from records, and completion needs real criteria or an explicit recorded exception.
- **Groups.** Application-level groups (not synced with any directory). Share knowledge with a group (revoked on removal), or assign a group to a mission (resolved once).
- **In-app invitations and notifications.** Accept, decline, revoke. No email is sent.
- **Multimodal capture choice.** Audio, audio + video, screen + narration, or text, with a consent screen stating purpose, access, AI processing and retention.
- **Storage and AI report** by layer; content-addressed reuse; Ask answer cache; measured, not claimed ([STORAGE](docs/STORAGE.md)).
- Details: [SPACES_AND_MISSIONS](docs/SPACES_AND_MISSIONS.md).

## Try it

**Deployed prototype:** see [docs/SUBMISSION.md](docs/SUBMISSION.md) for the verified URL. (The deployed version is replaced with this round only after local verification.) Sign up, choose **Start with your screen** or **Start with your camera**, and work with Moti.

**For judges:** the sign-in page has two shared accounts, one per experience. One click fills them in:

| Space | Email | Password |
|---|---|---|
| Agamya for Work | `judge.work@agamya.example` | `agamya-judges-2026` |
| Agamya for Culture | `judge.culture@agamya.example` | `agamya-judges-2026` |

The spaces are real and start empty: press **Start with your screen** (Work) or **Start with your camera** (Culture) and work with Moti. Use Chrome or Edge on a desktop, allow microphone and screen or camera access, and wear headphones. Judges share these spaces, so use test data only.

**Locally:**

```bash
npm install
cp .env.example .env          # set GOOGLE_CLOUD_PROJECT, then: gcloud auth application-default login
npm start                     # http://localhost:3200
```

Without Google Cloud credentials the app runs with deterministic fallbacks and says "AI offline" in the interface.

## What is real, simulated, and planned

| | Status |
|---|---|
| Live Moti (Gemini Live relay), Work Map, debrief, tutor, agent export | **Implemented, tested offline** (scripted fake Live session through the real relay). **Verified live** with typed turns: English and Marathi capture, Hindi and Kannada tutoring ([LIVE_MOTI](docs/LIVE_MOTI.md)). A full spoken browser session is still to be verified locally |
| Capture → judgment detection → questions → structured knowledge → approval → boundary → lessons → transfer measurement | **Implemented, tested**, live on Gemini 2.5 Flash (Vertex AI) |
| Browser capture of camera, screen and microphone (change-driven frames, voice-activity segments) | **Implemented**; exercised manually in the browser, not in automated tests |
| Kitchen camera, loom camera, mainframe console, spreadsheet | **Simulated sources**: rendered frames that travel the same upload → storage → analysis path as real capture. Labeled in the UI |
| Suggested expert answers in the samples | **Scripted** and labeled; editable or replaceable |
| Sample tests (new case + counterexample) for the three work workflows and the ghee journey | **Designer-authored**, labeled *synthetic* ground truth. Tests for new knowledge are generated by Gemini and labeled *model-derived* until a person validates them |
| Tenant isolation (PostgreSQL RLS), RBAC, consent, sharing controls, withdrawal, retention | **Implemented, tested** |
| Knowledge transfers, learner progress | **Implemented, tested** (no email notifications: people see transfers when they sign in) |
| Voice | Gemini transcription; Gemini text-to-speech behind a provider interface (`src/ai/voice.mjs`). Text is always a full alternative |
| Public publication of knowledge, use for model training | **Not offered.** No code path exists |
| Application-event capture from real desktop apps, email notifications, data export, SCIM | **Planned**, not built |

## Architecture (short)

A modular monolith on **Node 24 / Fastify**, deployed as **Cloud Run** service(s): one image, `PROCESS_ROLE` = `api` | `worker` | `all`.
**Cloud SQL for PostgreSQL 16** is the system of record, the job queue (`FOR UPDATE SKIP LOCKED`), the vector index (pgvector, HNSW) and the audit log. Row-level security isolates tenants.
**Cloud Storage** holds media (private bucket; org-namespaced keys; short-lived signed URLs).
**Vertex AI**: Gemini 2.5 Flash (perception, judgment, questions, extraction, boundaries, scenarios, coaching, evaluation), text-embedding-005 (retrieval), Gemini TTS.
**Secret Manager** holds credentials. Locally, PGlite (Postgres compiled to WASM) and disk storage replace Cloud SQL and GCS with the same SQL.
Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tests

```bash
npm test                   # 146 offline tests (112 before round 2): unit, security (incl. cross-tenant IDOR), AI contract, media, governance, transfers,
                           #   Detective / Stress Test / Radar / Ask / language, accessibility (axe on every route, contrast, reflow)
node scripts/eval-marathi.mjs   # live, ~12 calls (~$0.02): Marathi evaluation set → data/eval/marathi-results.json
npm run acceptance -- http://localhost:3203   # live Gemini end to end; needs a server started with TEST_HOOKS=1
npm run adversarial        # live: injection, invented boundaries, accidental changes, truncated speech
npm run benchmark          # live: context-compression benchmark
npm run stability          # live: detection agreement over repeated runs
```

`npm test` uses a scripted fake model (no network). Acceptance, adversarial, benchmark and stability call Gemini on Vertex AI. Measured results and their limits: [docs/RESULTS.md](docs/RESULTS.md).

## Deploy

```bash
PROJECT=your-gcp-project bash scripts/deploy/cloudrun.sh                      # demo profile: one service, scales to zero
PROJECT=your-gcp-project PROFILE=production bash scripts/deploy/cloudrun.sh   # API + always-on worker
```

It creates billable resources (Cloud SQL instance, bucket, secrets, image repository, Cloud Run). Production refuses to start without Cloud SQL, Cloud Storage, an https origin and an IP-hash salt.

## Configuration

See [.env.example](.env.example). Key variables: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `DATABASE_URL`, `STORAGE_DRIVER`/`GCS_BUCKET`, `PUBLIC_ORIGIN`, `IP_HASH_SALT`, `SAMPLE_SPACES`, `SAMPLE_AI_BUDGET_USD`, `OIDC_*`, `VOICE_PROVIDER`, `AGAMYA_OFFLINE`.

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, request path, jobs, deployment |
| [DIFFERENTIATION](docs/DIFFERENTIATION.md) | Why this is not RAG, a meeting summarizer or a tutor |
| [SECURITY](docs/SECURITY.md) · [THREAT_MODEL](docs/THREAT_MODEL.md) | Controls as implemented; threats and residual risk |
| [GOVERNANCE](docs/GOVERNANCE.md) | Consent, sharing, restriction, withdrawal, attribution |
| [DATA_MODEL](docs/DATA_MODEL.md) · [DATA_LIFECYCLE](docs/DATA_LIFECYCLE.md) | Schema; retention and deletion |
| [MEDIA_ARCHITECTURE](docs/MEDIA_ARCHITECTURE.md) · [AI_CONTEXT_ARCHITECTURE](docs/AI_CONTEXT_ARCHITECTURE.md) · [AI_COST_MODEL](docs/AI_COST_MODEL.md) | Capture, context budget, cost |
| [RADAR](docs/RADAR.md) · [MULTILINGUAL](docs/MULTILINGUAL.md) · [ACCESSIBILITY](docs/ACCESSIBILITY.md) | Knowledge Loss Radar rules; Marathi design and evaluation; WCAG work and its limits |
| [SPACES_AND_MISSIONS](docs/SPACES_AND_MISSIONS.md) · [STORAGE](docs/STORAGE.md) | Spaces, roles, groups, missions, notifications; storage layers and measured savings |
| [RESULTS](docs/RESULTS.md) | What was measured, how, and its limits |
| [DEMO_SCRIPT](docs/DEMO_SCRIPT.md) · [SUBMISSION](docs/SUBMISSION.md) | Three-minute demo; deployment status and submission checklist |

## Honest limits
- The Marathi evaluation is small (8 cases, 1 run), uses synthetic speech and has not yet been reviewed by a native speaker. The Marathi interface is partial.
- Accessibility has had no screen-reader or disabled-user testing.
- The expansion features are implemented and tested locally but **not yet deployed**.


- Judgment detection is probabilistic (34/35 agreement on scripted cases in one 5-run study; the miss was a pixel-only spreadsheet).
- All benchmark and test ground truth so far is synthetic (designer-authored) or model-derived; no study with real experts or learners has been run.
- Policy texts are templates, labeled "not legal advice".
- Agamya preserves evidence and supports learning; it cannot guarantee that a skill is mastered, or that a lost technique can be reconstructed from incomplete records.
