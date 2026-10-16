# Knowledge storage and AI efficiency

Goal: keep the most meaning and evidence per unit of storage and AI cost. The goal is **not** the smallest file. Original evidence is never silently replaced by something derived from it.

## Layers (report: `GET /api/storage/report`, page *Storage & AI*)

| Layer | What | Where | Kept |
|---|---|---|---|
| **A · Original evidence** | Frames, audio segments, short video clips, documents, briefs | Cloud Storage (or disk locally), **never PostgreSQL**. `media_assets` holds metadata, SHA-256, session, consent and retention | Per the space's retention policy. Evidence linked to approved knowledge follows the knowledge; the rest is purged, and the owner sees it in the report |
| **B · Structured evidence index** | Timestamped observations (text readings of frames, events), transcript segments, judgment↔evidence links, planning decisions | PostgreSQL | Per retention; evidence behind knowledge is kept |
| **C · Approved knowledge** | Versioned judgment (decision, reason, conditions, exceptions, boundary, risk, provenance per field), compiled rule and embedding | PostgreSQL | Until withdrawn; every version kept |
| **D · Learner-ready** | Practice cases (expert-approved), cached Ask answers | PostgreSQL | Cases until withdrawn; cached answers are keyed to the exact source versions, so they are never stale |

## Optimisations implemented (and why these)

| Technique | Implementation | Status |
|---|---|---|
| Change-based visual indexing | Existing sampler: unchanged frames are stored as evidence but not sent to the model (`drop_stable`); with readable text, the text is used instead of the image (`evidence_only`); vision only when needed, at the lowest sufficient resolution | Existing, measured below |
| Silence reduction | Existing: silence is never uploaded; speech is transcribed once | Existing |
| Context-aware token budgeting | Existing context budget manager (live benchmark: 72% fewer tokens than sending everything, `data/benchmark.json`) | Existing, measured live earlier |
| **Content-addressed reuse** | Identical bytes in the same space reuse one stored object (`media_assets.dedup_of`). Each upload keeps its own row, session, consent and deletion state. An object is deleted only when no live row references it. Never across spaces | **New**, tested |
| **Derived-artifact cache** | Ask answers keyed by sha256(normalised question, language, model, sorted knowledge `id:version` the asker can see). Only successful model answers are cached; fallbacks never. Hits are counted | **New**, tested |
| **Bounded, accounted retries** | One retry for timeouts, 429s and transient errors; **no retry for rejected requests (400/403/404)**; every attempt recorded; retries counted in the report | **Fixed this round** (400s were retried) |
| Decision-centric segmentation | Existing: evidence windows around the detected moment, not fixed windows | Existing |
| Incremental updates | Gap answers change one field, creating a new version; the requirement check reruns only when the knowledge state changes (idempotency key) | New for missions |

**Not implemented: lossy re-encoding of originals.** Frames are already small, change-sampled images, and audio is 16 kHz mono WAV segments. Re-encoding could damage visual or acoustic signals (the colour of milk solids, a click) and was not evaluated, so originals are stored as captured.

## Controlled context compaction (what the model receives)
1. Each operation declares what it needs (`OPERATION_PROFILES`).
2. Only relevant, visible, approved knowledge and the windowed evidence are retrieved.
3. Each field keeps its status (observed, expert-stated, AI-inferred, insufficient) and the expert's exact quote.
4. Exceptions and the boundary are always included in the knowledge text given to Ask.
5. Source versions are recorded (inference manifests; cache keys).
6. Where the knowledge does not cover a question, the answer says so rather than guessing. There is no blind truncation and no summary of a summary.

## Measured (`node scripts/storage-benchmark.mjs` → `data/storage-benchmark.json`; offline, deterministic, repeatable)
Three representative sample sessions (payments console, loom camera, kitchen camera), each captured **twice**, through the real pipeline. Baseline and optimised were measured on the same runs.

| | Baseline | Optimised | |
|---|---|---|---|
| Stored bytes | 1,824,458 | 912,229 | −50%: **exactly the deliberately repeated capture**, stored once. It shows reuse works; it is not a general saving. Real savings depend on how often identical bytes recur (retries, re-uploads, identical documents) |
| Visual observations sent to the model | 56 | 30 | −46%. Payments sent 0 images (readable text was used instead), weaving 16 of 26, ghee 14 of 16 |
| Model calls for 5 identical Ask questions over unchanged knowledge | 5 | 1 | 4 served from the cache |

**Not measured here:** token savings (the scripted model's tokens are fake; see the live benchmark), lossy compression, and savings on real camera or screen media, which differ from the simulated frames.

## Live AI cost observed in this round
- Marathi evaluation: $0.022.
- Six-operation live probe: $0.0075.
- Two live mission acceptance runs and one main acceptance run: see `RESULTS.md`.
