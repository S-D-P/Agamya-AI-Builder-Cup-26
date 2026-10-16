# Media architecture

Goal: capture video and audio of real work **without losing knowledge or context**, while sending the model only what it needs. The rule is **capture never degrades; inference context does**. Every accepted byte is stored (subject to consent and retention), while what reaches Gemini is planned per observation ([AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md)).

## Pipeline

```
 Browser                                  API                                Worker                          Storage / DB
 ───────                                  ───                                ──────                          ────────────
 getDisplayMedia / getUserMedia
   │ 1 Hz 32×18 thumbnail diff
   │ changed? → JPEG ≤1280px ──── POST /media (binary, x-captured-at, x-modality, x-kind)
 MediaRecorder (mic)                      │ consent ✓ capturing ✓ not paused ✓
   │ VAD segments ≤20 s → 16 kHz WAV ─────┤ magic bytes ✓ size ✓ owner ✓
 MediaRecorder (camera, optional)         │ sha256 → duplicate? return existing
   │ 10 s WebM evidence chunks ───────────┤ put object  org/{org}/sessions/{s}/{kind}/{id}.{ext} ──────────────► GCS / disk
                                          │ insert media_assets (+expires_at)  ──────────────────────────────► Postgres
                                          │ enqueue process_frame / process_audio (idempotency key)
                                          └─► 202 {assetId, jobId}
                                                                             claim (SKIP LOCKED)
                                                                             plan observation (context budget)
                                                                             interpret frame @LOW/MEDIUM, or
                                                                             transcribe audio once
                                                                             insert observation (+ transcript segment,
                                                                             link to nearest visual moment)
```

## Capture sources

| Source | Browser API | What is uploaded | Notes |
|---|---|---|---|
| Screen | `getDisplayMedia` (5 fps stream) | JPEG keyframes, max 1280 px | Sampled every second; a frame is sent only when the 32×18 grayscale thumbnail changes by >0.4%, plus a heartbeat every ~20 s. The client also sends a cycle-diff (similarity to the last 8 thumbnails) so repetitive motion can be dropped server-side |
| Camera | `getUserMedia` 1280×720 | Same keyframe sampler; optional 10 s WebM chunks (600 kbit/s) | WebM chunks are **evidence only**: stored, never sent to the model |
| Microphone | `getUserMedia` (echo cancellation, noise suppression) | Speech segments as 16 kHz mono WAV | Voice activity detection: RMS > 0.02 opens a segment; 1.2 s of silence or 20 s length closes it; segments < 0.6 s are discarded. Silence never leaves the browser |
| Spoken answers | `MediaRecorder` push-to-talk | One WAV per answer | Transcribed and recorded as the expert's answer |
| Documents | file upload at workflow creation | PDF or text | Magic-byte check, active-content rejection, injection scan |
| Simulated sources | server-side SVG → PNG (resvg) | Real PNG frames, plus app events where the source has them | Same upload → storage → job path as live capture. Sources: mainframe console, revenue spreadsheet, loom camera, kitchen camera (the featured ghee journey) |

Permission denial degrades per modality (for example, the microphone is refused but screen capture continues). Uploads retry with exponential backoff (600 ms × 2ⁿ, 3 retries) on network or 5xx errors. Server-side SHA-256 idempotency makes retries safe.

## Chunking

- **Frames** are naturally chunked: one object per meaningful change.
- **Audio** is chunked at speech boundaries (VAD), so each chunk is a complete utterance where possible and transcription context is not cut mid-sentence. A segment that still ends mid-speech (20 s cap, or a stopped recording) is detected two ways: the model's `incomplete` flag, and a deterministic acoustic check on the last 80 ms of the WAV (`endsMidSpeech`). The transcript is then marked "[recording ended mid-speech]". This check exists because in the live adversarial test the model never flagged truncation (0/3 runs on a sentence cut at 30%), whereas the acoustic check flagged the cut recording and did not flag the complete one. That is a single synthetic (TTS) recording, so it shows the mechanism works, not how accurate it is on real speech.
- **Video** is chunked by `MediaRecorder` timeslice (10 s), with each chunk independently playable.

## Temporal alignment

- Every upload carries `x-captured-at` (client clock, ms). At consent the client sends its clock. The server stores `client_clock_offset_ms` (clamped to ±24 h) and corrects every timestamp. Uploads that arrive late or out of order still land at the right moment.
- Audio observations are **linked to the nearest visual observation** (`linked_observation_id`), so "what was said" attaches to "what was on screen".
- `transcript_segments` store `start_at`/`end_at` ranges. `GET /api/sessions/:id/window?at=…&span=…` returns every observation and transcript segment around a moment across modalities. The UI uses it when someone clicks evidence; extraction uses it to assemble the moment's context.
- Judgments store an `evidence_window` (`tstzrange`) spanning their evidence.

## Asynchronous processing and back-pressure

- Upload requests do no model work: they store, record and enqueue, then return `202`.
- Workers process media with configurable concurrency. Per-session serialization prevents two jobs of the same session from racing on observation sequence numbers.
- `analyze_session` re-queues itself (`RetryLater`, without consuming an attempt) until all of the session's media jobs have finished, so detection never runs on a partial picture.
- A job that keeps failing (for example, unreadable media) dead-letters after 4 attempts and stops blocking the session.
- The `pending` media count is exposed on the session so the UI can show processing state.

## What reaches the model (summary)

| Observation | Sent to Gemini |
|---|---|
| App event or UI text available | Text only; pixels stored as evidence |
| Stable or repetitive frame | Nothing (`drop_stable`) |
| Changed camera frame | One frame at LOW resolution (66 tokens); escalated to MEDIUM (258) if confidence < 0.7 |
| Changed screen frame without text | One frame at MEDIUM (258 tokens). Screens are text-dense, and LOW missed small annotations in 1 of 6 runs |
| Speech | The audio once, for transcription; afterwards only its text |
| Video chunk | Nothing; evidence only |
| Moment of judgment (question / extraction) | Up to 2 moment frames at MEDIUM, plus the text event window |

Measured on gemini-2.5-flash (Vertex): a 960 px frame costs 1806 tokens at default resolution, 258 at MEDIUM and 66 at LOW.

## Privacy controls during capture

Pause (all uploads refused server-side while paused), exclude a modality, delete a single moment (removes the object and the derived text, audited), and raw retention per session: `evidence` (default; keep only frames that back approved knowledge), `none`, or `all`. See [DATA_LIFECYCLE](DATA_LIFECYCLE.md).

## Scalability

- Bytes go to object storage; Postgres holds metadata and bounded text. Throughput scales with Cloud Run API instances (stateless) and worker instances (SKIP LOCKED claiming).
- The adaptive sampler bounds load per expert: a 30-minute session typically produces tens of frames, not 1,800 (one per second) or 9,000 (5 fps).
- The bandwidth cost of a session is dominated by optional video evidence chunks (~0.75 MB per 10 s), which is why they are off unless the workflow enables them.
- **Not implemented**: resumable uploads for very large files, server-side video transcoding or keyframe extraction from uploaded video, and a native desktop agent for application events during live capture (app events exist only in simulated sources).
