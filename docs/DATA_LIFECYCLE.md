# Data lifecycle

What is kept, for how long, who can delete it, and what happens automatically. Retention is enforced by the application (audited) rather than by blanket bucket rules, because some raw objects must outlive others: evidence behind approved knowledge is kept after other raw media is purged.

## Data classes and default retention

Configured per organization in **Administration → Retention & AI budget** (`organizations.settings.retention`).

| Class | Examples | Default | Enforced by |
|---|---|---|---|
| `raw_media` | uploaded frames, audio chunks, video chunks not backing knowledge | **30 days**; purged earlier at approval when the session's raw retention is "evidence only" | `retention_session` job at approval; hourly `lifecycle_sweep` |
| `transcript` | transcript segment text | **180 days** | hourly `lifecycle_sweep` (text cleared, row kept as a tombstone) |
| `semantic` | observation text and readings | **730 days** | hourly `lifecycle_sweep` (text cleared, tombstone kept); observations that are evidence behind a judgment are kept |
| `knowledge` | judgment versions, knowledge artifacts and versions, **and the evidence frames behind them** | until the knowledge is retired | not auto-expired |
| `audit` | audit events, inference log | **2,555 days (7 years)** | append-only; no application deletion |

## Lifecycle of a capture session

1. **Consent**: nothing is accepted before the captured expert consents to specific modalities under a specific policy version.
2. **Capture**: each upload becomes a `media_assets` row (`retention_class = raw_media`, `expires_at = now + raw retention`) plus an object in storage.
3. **Processing**: observations and transcript segments are derived. Raw bytes are not copied into the database.
4. **During the session**, the expert can:
   - **pause**: the server refuses uploads while paused;
   - **exclude** a modality;
   - **delete a moment**: removes the storage object *and* the derived observation text, and is audited;
   - choose raw retention `evidence` (default), `none`, or `all`.
5. **Approval** (the expert's decision): `retention_session` runs.
   - `evidence`: raw objects that back the approved judgment are **promoted** to `retention_class = knowledge` with no expiry. Every other raw object of the session is deleted from storage and marked `purged`.
   - `none`: all raw objects of the session are purged; knowledge keeps its text evidence only.
   - `all`: nothing is purged at approval; raw media expires on its normal clock.
   - The bytes purged are recorded on the session ("Raw stored / purged" in the UI).
6. **Rejection**: `retention_session` also runs. A rejected judgment protects no evidence, so with `evidence` or `none` all of the session's raw media is purged immediately; with `all` it expires on its normal clock.
7. **Hourly sweep** (`lifecycle_sweep`, per organization): purges media whose `expires_at` has passed (evidence promoted to knowledge has none), clears expired transcript text, and clears observation text older than the semantic retention unless it is judgment evidence.

Tests: `tests/ai-contract.test.mjs`, "after approval, raw media that is not evidence is purged; evidence is kept". It also fast-forwards the raw-media clock and runs the sweep, proving the evidence survives with `retention_class = knowledge`, and that old non-evidence observation text is cleared while evidence text is kept. "Deleting a moment removes the raw object and the extracted text" is tested in the same file.

## Withdrawal by the contributor

Withdrawing knowledge (`POST /api/knowledge/:id/withdraw`, contributor only; in a workplace also an organization admin) sets it to `retired` and `private`, removes it from lessons, retrieval and other people's views, clears its embedding, deletes its evidence media from storage, records a `RETIRED` validation and an audit event. Its version history stays in the database for audit; erasing the text itself is part of the operator data-subject procedure below.

## Sample spaces

Per-visitor sample spaces follow the same retention rules as any space. They are not yet garbage-collected after the visit (see "Not yet automated").

## Knowledge lifecycle

`observed` judgment → expert **approves** (artifact v1, EXPERT_CONFIRMED) → peers confirm (MULTI_EXPERT_CONFIRMED) → learners transfer and pass counterfactuals (LEARNER_VALIDATED) → after 180 days without validation it shows as **STALE** and should be re-validated. Open disagreements show as **CONFLICTED**. New versions append; history is never overwritten. Artifacts can be retired (status `retired`, validation kind `RETIRED`).

## Accounts and organizations

- Sessions expire after 12 h absolute or 120 min idle, and are revoked server-side on logout.
- Invitations expire after 7 days and are single use.
- Disabling a user prevents sign-in (local and OIDC) and invalidates their sessions at the next request.

## Not yet automated (honest list)

- **Dialogue retention**: question and answer text (`session_dialogue`) is not swept separately; it is kept as part of the knowledge record.
- **Sample-space clean-up**: abandoned sample spaces remain until removed by an operator.
- **Data-subject deletion workflow** (erase one person across an organization): today requires an operator procedure. The data model supports it, because people are per-org and evidence is linked rather than copied.
- **Organization offboarding / export**: no self-service export or full tenant deletion yet.
- **Backups**: Cloud SQL automated backups and point-in-time recovery are enabled by the deploy script. Restoring a backup can resurrect data deleted after the backup was taken; document this in your retention policy.
- **Object versioning** is not enabled on the bucket, so a deleted object is gone.
