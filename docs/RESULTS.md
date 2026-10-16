# Measured results

Everything below was run on this codebase. Each result states its method, its ground truth and its limits. **No study with real experts or learners has been run.** All ground truth is *synthetic* (designer-authored) or *model-derived*.

## 1. Automated tests (offline, deterministic)

`npm test`: **112/112 passing** (October 14, 2026; was 66/66 before the Detective / Stress Test / Radar / language / accessibility work). The tests use a scripted fake model (no network) against a real PostgreSQL engine (PGlite) and the real HTTP stack.

| Suite | What it proves |
|---|---|
| `unit` (19) | Validators, prompt fencing, context planning, gate, password and token primitives, knowledge levels from evidence (never model confidence), transfer scoring, hostile WAV parsing, production configuration refusal, the learner-mastery rule |
| `security` (19) | Authentication, lockout, CSRF and Origin, policy gate, RBAC, captured-expert-only actions, audited denials, **cross-tenant IDOR on 13 endpoints**, database-level RLS, upload validation, PDF active content, headers and caching, no leaking of internal database codes |
| `ai-contract` (13) | Malformed / over-claiming / confused model output is caught or degraded safely; prompt injection is fenced and flagged; budget exhaustion degrades; media pipeline async, idempotent, temporal, deletable; retention purges non-evidence and keeps evidence through the sweep |
| `detective` (23) | Missing Knowledge Detective: gaps cite real evidence (uncited AI gaps dropped), idempotent re-analysis, contributor-only answers, answer → verified proposal → approval → new judgment version **and** new knowledge version, gap resolved; unresolved / deferred / not applicable / reopen; Stress Test: four case types, drafts invisible to learners until approved, criteria editable, escalation credited, false confidence and unnecessary escalation detected, outcome labels; Radar: insufficient evidence → needs attention → at risk from real records, manager-only; Ask: Marathi in/out with a verified citation, uncovered → insufficient, invented citations withheld, private knowledge never a source; spoken answers are drafts and corrections keep the machine transcript |
| `a11y` (23) | Palette contrast for every text token and tint; zoom not disabled, skip link, live region, reduced motion, focus ring; reflow guards; the real client rendered in jsdom against the real server for 4 personas and 21 routes (English and Marathi) with axe-core: 0 violations; Marathi text carries `lang="mr"` |
| `governance` (15) | Private by default in living spaces; private knowledge invisible to the learner (lessons, lists, detail) and never used as AI context for others; contributor-only sharing; restriction scope; sample-space isolation; demo sign-in cannot enter a sample space; withdrawal deletes evidence media; transfer authorization (manager plans, only the named expert starts, people see only their own, cross-tenant 404) |

**Postgres wire protocol (the Cloud SQL code path):** the governance and transfer suites (15/15) and 14 of the 19 security checks also pass through the `pg` driver against a socket-served PGlite. The remaining security checks fail only because that emulator desynchronizes after a database error in parameterized queries (reproduced in isolation: after an expected unique-violation error, the next `SELECT $1` returned no rows). Real PostgreSQL does not do this. The deployed Cloud SQL instance is the final check ([SUBMISSION](SUBMISSION.md)).

## 1b. Marathi evaluation (live, once)

`node scripts/eval-marathi.mjs`: **8/8 cases pass**, 12 calls, 0 failed calls, $0.022 (October 14, 2026). It covers ordinary Marathi, code-switching, the "बेरी" literal-translation trap, ambiguity, an uncovered question, and a TTS→transcription round trip. A first run reported 3 failures that turned out to be bugs in the evaluation script; it was fixed and re-run once, and both outputs are kept. The set has **not** been reviewed by a native speaker and the speech is synthetic. Details: [MULTILINGUAL](MULTILINGUAL.md).

## 1c. Accessibility checks

axe-core (automated, every route, 4 personas) plus manual checks in a real browser: contrast, 320 px reflow, keyboard, skip link and dialog focus. All issues found were fixed. No screen-reader or user testing yet, and **no conformance claim**. Details: [ACCESSIBILITY](ACCESSIBILITY.md).

## 1d. Round 2 (October 15, 2026)
- **`npm test`: 146/146.** By suite: unit 19, security 19, ai-contract 13, governance 15, detective 24, platform 24, retry 5, a11y 27.
- **Live, Gemini 2.5 Flash on Vertex AI, from a local server; each run once unless noted:**
  - `scripts/acceptance.mjs`: all expectations met; 72 calls; $0.12. This is the first live run of the round-1 changes: voice drafts confirmed, the gap loop, and four drafted case types.
  - `scripts/acceptance-missions.mjs`, run 1: exposed a bug. Vertex rejected the requirement-check schema (`maxItems: 40` → HTTP 400), and the script's expectation was too weak to catch it. Fixed the schema, stopped retrying permanent 4xx errors, and strengthened the expectation.
  - `scripts/acceptance-missions.mjs`, run 2: all expectations met, including the live requirement check and the Marathi mission.
  - A one-off live probe of all six new or changed operations ($0.0075) confirmed each schema is accepted.
- **Storage benchmark:** `data/storage-benchmark.json`; see [STORAGE](STORAGE.md).

## 2. Live acceptance (Gemini 2.5 Flash on Vertex AI)

> The acceptance script was updated for this round: spoken answers are confirmed as drafts, the expert reviews four drafted cases, and one gap loop runs on the weaving capture. **The updated script has not been run live yet**; the results below are from the previous version.

`npm run acceptance`: **all expectations met** (October 13, 2026). One run, end to end through the HTTP API:

- **Weaving (camera + voice):** a new workflow is created from an uploaded guide; procedures are extracted; the expert's dry-day tension change is detected from pixels, questioned by voice (Gemini TTS → recorded answer → transcription), structured, approved; tests are generated; one learner transfers after a hint; another **overgeneralizes on the counterexample and is caught**.
- **Payments (multiple experts):** two experts' practices for the same error code are captured; the disagreement is detected and the hidden variable (value date) is identified.
- **Revenue reporting (pixel-only screen):** the judgment is captured from the spreadsheet image alone; the routine case is **not** interrupted.
- **Living Knowledge (ghee):** in a fresh sample space the kitchen camera session produces the judgment "turn off the heat when the specks turn light golden, not at 20 minutes"; approval saves it **private**; the learner sees no lesson; after named sharing she gets a new case and a counterexample; her overgeneralization ("Amma turned it off at 12 minutes") is caught and corrected after one hint; withdrawal removes the lesson.

Cost of that whole run: 71 model calls, about $0.12 (estimated from token counts at list prices).

## 3. Context-compression benchmark

`npm run benchmark` (`data/benchmark.json`). 7 scripted expert sessions across the three work workflows (4 containing a judgment, 3 routine controls), one run per pipeline.

| Pipeline | Tokens / session | Image tokens | Cost / session | Judgment recall | False alarms |
|---|---|---|---|---|---|
| naive (every frame, full resolution, detect on every event) | 48,488 | 20,861 | $0.030 | 4/4 | 0/3 |
| raw at natural breaks | 33,823 | 14,964 | $0.022 | 4/4 | 0/3 |
| **Agamya (compressed context)** | **13,747** | **795** | **$0.013** | **4/4** | **0/3** |

**72% fewer tokens and about 56% lower cost**, with equal recall and false alarms in this run. Limits: one run, 7 cases, synthetic labels; earlier runs measured 71–77%. This does not show zero quality loss. It shows no loss on these cases.

## 4. Detection stability

`npm run stability`: 7 cases × 5 runs. Agreement with designer labels **34/35**. The miss was the pixel-only spreadsheet case (4/5, "no candidates"). Model output varies between runs; pixel-only screens are the weakest input.

## 5. Adversarial suite

`npm run adversarial` (`data/adversarial.json`): **36/36** (12 cases × 3 runs). Covers actions or outcomes without judgment, routine repetition, accidental bump-and-restore, cosmetic and ambiguous changes, a document that instructs the AI, a fake system command inside an expert's answer, a model tempted to invent a boundary, an expert changing their answer, and a truncated recording. The last passes only because of the deterministic acoustic check; the model alone flagged truncation 0/3.

## 6. Browser walkthrough

The featured journey was completed in the browser on live Gemini: landing → private sample space → consent → eight simulated kitchen actions → detected deviation → question → two answers → structured knowledge (each field quoted from the teacher or marked inferred) → approval (private) → shared with Meera → Meera's lesson (correct; then overgeneralized on the counterexample, a Socratic hint, corrected) → result step → artifact with the teacher's craft context. The Work sample was checked for transfer planning, the expert disclosure, starting capture from the plan, home and learner progress.

## What these results do not show

- That learners coached with captured judgment outperform learners given documentation alone. The experiment exists in the product (SOP-only vs SOP + judgment arms, immediate and delayed retest) but has not been run with people.
- Accuracy on real, unscripted work or real speech.
- On-the-job proficiency. "Demonstrated in simulation" means correct decisions on a new case and a counterexample.
