# Expansion plan: Missing Knowledge Detective · Judgment Stress Test · Knowledge Loss Radar · Accessibility · Marathi

Baseline (2026-10-14): `npm test` 66/66. `tacit-poc/` is untracked in git (no diff to protect beyond the files themselves). The local Vertex retry fix (one retry for timeout / 429 / service errors) is present and not yet deployed; it now also waits 1.5–4 s with jitter after a 429 and records each attempt.

## What already exists (inspected, not assumed)
- Judgments carry per-field epistemic status (observed / expert stated / AI inferred / insufficient), verbatim-quote verification, boundary confirmation, and a computed "still uncertain" list. Versions are append-only (`judgment_versions`).
- In-session follow-ups (≤2) are asked before extraction finishes; there is no persistent, answerable gap record.
- Scenarios: `apply` + `counterfactual`; curated (synthetic) and generated (model-derived, usable without review); `reviewScenario` exists but nothing requires it.
- Learner scoring is deterministic against the answer key; Gemini coaches and evaluates reasoning.
- Progress/transfer views exist; there is no continuity view.
- Language: everything is English-only. Transcription returns text but no language. UI has no `lang` handling.
- Accessibility: semantic shell, skip link (but not visible on focus), native dialogs, aria-pressed chips, reduced motion; several text colours below 4.5:1 (`--faint`), white on coral buttons below 4.5:1, unlabeled textareas, no live announcements for async state.

## Smallest viable changes
1. **Migration 003** (additive, safe defaults): `knowledge_gaps`; scenario `review_status`, `criteria`, `language`, kinds `boundary` and `insufficient`; session `language` and `answer_draft`; dialogue `question_language`, `answer_language`, `answer_original`, `answer_source`; `users.preferred_language`.
2. **Missing Knowledge Detective** (`src/domain/gaps.mjs`, op `detectGaps`, op `integrateGapAnswer`): deterministic gaps from field statuses + AI-proposed gaps whose evidence ids must exist; answer → proposal → expert approval → new judgment version + knowledge version → re-evaluation. Accept-unresolved / defer / not-applicable. Idempotent via `(judgment_id, dedupe_key)`.
3. **Judgment Stress Test**: generated scenarios start as `draft` and are never used for assessment until the expert approves them; four kinds; an always-available "not enough information, stop and ask" choice that is *correct* for insufficient-evidence cases; criteria-based feedback with the supporting quote.
4. **Knowledge Loss Radar** (`GET /api/radar`): per-workflow indicators from real rows, each with evidence and a next action; "insufficient evidence" when there is nothing to judge.
5. **Language layer**: session language drives question / extraction language; quotes stay in the original language with a labelled machine translation; voice answers become an editable draft before they count; `POST /api/ask` answers learners in their language from approved, visible knowledge only, and says so when evidence is insufficient.
6. **Accessibility**: fix contrast tokens, visible skip link, labels, live announcer, dialog focus return, `lang` attributes; automated axe checks on rendered views (jsdom) + palette contrast unit test + manual browser checks.

No new infrastructure. Gemini on Vertex AI does multilingual understanding directly (no translate-then-reason pipeline).

## Outcome (2026-10-14)
Implemented as planned. Tests: 66 → **112/112**. Not deployed. See README "New in this round", [RADAR](RADAR.md), [MULTILINGUAL](MULTILINGUAL.md), [ACCESSIBILITY](ACCESSIBILITY.md) and [RESULTS](RESULTS.md).
