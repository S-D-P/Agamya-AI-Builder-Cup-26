# AI cost model

All costs are **estimates**: token counts reported by Vertex AI multiplied by configurable list-price assumptions (`PRICING` in `src/ai/gemini.mjs`; override via `PRICE_*` env vars). Verify the prices against your contract and the current Vertex AI price list before using these figures for budgeting.

| Assumption (gemini-2.5-flash) | USD per 1M |
|---|---|
| Input tokens (text, image, video) | 0.30 |
| Input tokens (audio) | 1.00 |
| Output tokens (including thinking) | 2.50 |
| TTS input / output | 0.50 / 10.00 |
| Embeddings (text-embedding-005) | 0.025 per 1M characters |

## Where cost comes from

Every call writes an `ai_inferences` row (tokens by modality, cost, latency, status). `ai_usage_daily` rolls them up per organization. **Insights → AI cost & efficiency** shows calls, tokens, image tokens, cost per session, **cost per validated judgment**, validated judgments per 100k tokens, a per-operation breakdown, the context profile of each operation, and the naive-vs-optimized benchmark.

### Measured per-operation cost (live runs on the demo, Oct 2026)

| Operation | When | Typical tokens | Typical cost |
|---|---|---|---|
| interpretObservation | changed frame without text | ~200 output + 66–258 image | ~$0.001 |
| transcribe | each speech segment | ~25 tokens/s of audio | <$0.001 |
| detectJudgment | each natural break | ~2,100 | ~$0.002 |
| generateQuestion | each question | ~1,400 | ~$0.0007 |
| extractKnowledge | each answer | ~3,100 | ~$0.005 |
| findBoundary | each answer | ~1,800 | ~$0.002 |
| detectConflict | finalize | ~900 | ~$0.0004 |
| embed | approval | rule text | ~$0.00002 |
| evaluateLearner | each learner decision | ~1,400 | ~$0.0006 |
| tutor | each hint | ~1,600 | ~$0.001 |
| tts | each spoken question (optional) | ~260 output | ~$0.002 |

**New operations in the expansion round (not yet measured one by one on the live demo):**

| Operation | When | Expected order of cost |
|---|---|---|
| detectGaps | once per captured judgment (and on "Look again", at most 6 per judgment) | similar to findBoundary, about $0.002 |
| integrateGapAnswer | each gap answer | about $0.001–0.002 |
| answerFromKnowledge (Ask) | each learner question (30/min limit) | about $0.001; the approved-knowledge context is small |
| transcribe (draft) | each spoken gap / learner / Ask input (10/min limit) | under $0.001 |
| generateScenarios | now four cases plus criteria, once per approval | about 1.5× the previous two-case call |

The live Marathi evaluation (3 questions, 3 extractions, 4 Ask answers, 1 TTS, 1 transcription; 12 calls) cost **$0.022** in total.

**Retries:** a call that times out, is rate-limited (HTTP 429) or errors is retried **once** after 1.5–4 s with jitter. Each attempt is recorded in `ai_inferences`, so cost accounting stays exact. A failed or timed-out call is never treated as a successful knowledge task: the operation falls back and is labelled as such.

Thinking budgets are capped per operation; output is constrained by JSON schemas, which keeps output tokens (the expensive side) small.

### Per unit of value

| Unit | Measured |
|---|---|
| Expert session with one judgment (benchmark, compressed, 7-case mean) | 13,747 tokens · **$0.013** |
| Expert session including question, two answers, boundary and conflict check (browser walkthrough, payments) | 8 calls · 9.7k in / 6.0k out · **$0.018** |
| Acceptance run: 3 expert sessions + 4 learner attempts + voice + 2 controls | 50 calls · **$0.071** · $0.024 per validated judgment |
| Same session through the naive pipeline (benchmark) | 48,488 tokens · $0.030 |

## Why it is cheap: the context budget

From the benchmark ([AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md)): compressed context used **72% fewer tokens** and about **56% lower cost** than naive, with equal measured recall on 7 synthetic cases. The cost reduction is smaller than the token reduction because output tokens (priced 8× input) are similar across pipelines. The levers:

1. **Text over pixels**: app events and UI text replace screenshots; the screenshot is kept as evidence.
2. **Change-driven sampling**: stable and repetitive frames never reach the model (most are never even uploaded).
3. **Resolution by need**: LOW (66 tokens) for camera, MEDIUM (258) for screens and moments, never the default (1,806).
4. **Hear once**: audio is transcribed once; later operations see text.
5. **Detect at breaks**, not per event; bounded windows (40 events) and top-3 retrieval.
6. **Structured output** with schemas and capped thinking.

## Guardrails

- **Monthly budget per organization** (default $50, admin-editable). When month-to-date cost reaches it, model calls are refused (`skipped_budget`) and the product falls back to deterministic behavior. It does not fail open, and nothing is silently retried at higher cost.
- **Rate limits** on AI-heavy routes (120/min) and TTS (30/min).
- **Sample spaces** on the public demo: $1 monthly AI budget each, at most 60 new spaces per day, 6 per IP per 10 minutes. The featured ghee journey costs a few cents.
- **Operation profiles** cap what each call can include, with the manifest stored per call for auditing.

## Projection (illustrative, not a quote)

Assume an organization with 50 experts, each capturing 8 sessions a month (half with a question-worthy judgment), and 200 learners, each making 20 decisions a month with one hint on average:

| Item | Volume / month | Unit cost | Monthly |
|---|---|---|---|
| Expert sessions | 400 | ~$0.013–0.025 | ~$5–10 |
| Learner decisions | 4,000 | ~$0.0006 + $0.001 hint | ~$6–7 |
| Scenario generation | ~200 approvals | ~$0.005 | ~$1 |
| Spoken questions (optional) | ~400 | ~$0.002 | ~$1 |
| **AI total** | | | **≈ $15–20** |

At these volumes **infrastructure, not AI, dominates**: a small Cloud SQL instance, an always-on worker instance, Cloud Run API requests, and storage for evidence frames (kilobytes each; raw media is purged by default). Size these with the Google Cloud pricing calculator for your region and tier. The deploy script defaults to `db-g1-small` and one always-on 1 GiB worker.

## What would raise cost

Enabling continuous video evidence (storage and egress, not tokens), retaining all raw media, long uninterrupted screen sessions without text events (more MEDIUM frames), or many learners using spoken hints. Each of these is visible per operation on the cost screen.
