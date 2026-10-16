# Live Moti: capture → Work Map → debrief → tutor

The third round turns Agamya into a minimal, live product. You pick **Work** (share your screen) or **Culture** (camera). After one consent card you are straight in the work, with Moti watching, listening and asking. There are no samples and no demo data in the product.

```
Expert works (screen or camera + voice)
   │  Moti (Gemini Live) stays quiet, asks one short question at a natural pause
   ▼
Work Map built (Gemini 2.5 Flash, structured, verified)
   │  steps · screen moment · decision · reason in the expert's words · guardrails · what is still unclear
   ▼
Debrief (Gemini Live): Moti asks what is unclear, explains the process back, expert confirms
   ▼
Confirmed Work Map ──► Export for agents (markdown + JSON stop points)
   ▼
Practice: a new hire shares their screen; Moti tutors in their language and stops a wrong decision
```

## How it is built

| Piece | Where | What it does |
|---|---|---|
| Live relay | `src/domain/live.mjs`, `GET /api/live` (WebSocket) | Browser ↔ our server ↔ Gemini Live on Vertex AI (`gemini-live-2.5-flash-native-audio`). The browser never holds credentials. Same-origin and cookie-authenticated. Messages that arrive while the model session is still opening are buffered, not lost. |
| Browser client | `public/js/live.js`, `public/js/pcm-worklet.js` | Microphone → 16 kHz PCM. Screen/camera frames are sent **only when the picture changes** (32×18 thumbnail diff), at most 1 per second, max 1024 px. Moti's 24 kHz voice stops the moment the person talks over it. |
| Token degradation | Live config | `contextWindowCompression: slidingWindow` keeps long sessions inside the context window. `sessionResumption` reconnects without losing the conversation. Unchanged frames are never sent. |
| Storage | `capture.uploadMedia` | Only changed frames are stored (content-addressed, deduplicated). Tutor frames are not stored at all. |
| Speech → evidence | `workmaps.liveTurn` | Each expert turn is stored as a microphone observation, **redacted first** (email, card numbers with a Luhn check, IBAN, PAN, Aadhaar, SSN, phone). Business numbers such as invoice ids are kept. |
| Off the record | relay + `expert_sessions.off_record` | Nothing is sent to the model or stored until the expert comes back. Only the period itself is recorded. |
| Work Map | `src/ai/ops/workmap.mjs` | One structured Gemini 2.5 Flash call. Then deterministic checks: unknown screen-event ids are dropped, and a quote that does not appear verbatim in what the expert said is removed and the item is labelled **AI-inferred**. |
| Tutor judge | `judgeTutorTurn` in `workmap.mjs` | Gemini Live does the talking. After each Moti turn, a short structured call decides whether Moti just stopped the learner, at which step, whether to replay the expert's screen moment, and whether practice is over. The guardrail text comes from the confirmed map, not from the model. |
| Agent export | `GET /api/maps/:id/export` | Confirmed maps only. Markdown with `STOP AND ASK A PERSON` and `NEVER` lines, plus JSON. |

**Why a judge instead of Live function calling.** We probed this on Vertex in October 2026. With the tutor's tools attached, the native-audio Live model often ended its turn silently with `MALFORMED_FUNCTION_CALL`. Through our relay it failed on every turn, including after a repair prompt. A learner left in silence is worse than a slower side channel. So Live only talks, and the structured call (already reliable in this codebase) carries the decisions.

## The Apprentice Test: our answers

1. **When does it ask?** Only at a natural pause: after the person stops typing or talking, never mid-action. The instruction targets 3–5 questions per 10 minutes. In the live check, Moti answered about 2 s after the expert paused.
2. **What does it ask?** About what is on screen and why, with at least one guardrail question ("What would make you stop and ask someone?"). With a KT mission, its brief steers the questions. In the English live check, Moti's first question was about the exception the expert had just mentioned: why call new suppliers first, even under the limit.
3. **How does it know it has understood?** The Work Map lists what is still **unclear**, as short spoken questions. The debrief asks them, then Moti explains the whole process back in under a minute and asks "Is that how it works?". The map is only usable for practice after the expert confirms it.
4. **Did the new hire learn?** In practice, Moti asks the learner to predict decisions and stops them before a guardrail is broken ("Asha would stop here. Why do you think?"). Every stop is recorded with its step and guardrail. The result lists the steps handled well and the steps to practise. It is labelled *practice in a live session, not a certification*.
5. **Can the expert trust it?** Off the record at any time. Personal data is redacted before storage. Every reason carries the expert's verbatim quote or an **AI-inferred** label. Nothing is used for practice until the expert confirms it. Maps are private in Culture spaces, and in Work spaces they are visible to colleagues only after confirmation. Recordings are kept 30 days for review.

**Stretch goals.** *Any language*: the expert speaks their language, the map is stored in English (the shared base), quotes stay verbatim with an English rendering, and the learner is taught in their own language. *Agent-ready guardrails*: the export above. *Two experts*: the existing reconciliation engine (`reconcileExperts`) applies to captured knowledge; it is not yet wired into Work Maps.

## Verified (live, on Vertex AI, 15 Oct 2026)

Each check is one short run with a typed turn through the real relay. The voice came back as audio; the expert's side was typed, not spoken.

| Check | Result |
|---|---|
| Capture, English | Moti asked a guardrail question ~1.9 s after the expert paused (21 audio chunks). The map: 1 step, 2 guardrails with verified verbatim quotes, 3 unclear questions. |
| Capture, Marathi | Moti asked in Marathi. The map is in English; quotes stayed verbatim in Marathi with an English rendering; 3 unclear questions linked to steps. |
| Tutor, Hindi | Learner: "posting this ₹75,000 invoice now". Moti: "Asha यहाँ रुक जातीं। आपको क्या लगता है क्यों?" (Asha would stop here. Why do you think?) about 1.6 s later. The judge recorded the stop at the right step. The finish produced mastered/practise lists and Moti's spoken summary. |
| Tutor, Kannada | Same scenario. Moti stopped the learner in Kannada about 1.6 s later; the stop was recorded at the right step and the finish was correct. |

**Not yet verified live:** spoken (rather than typed) expert input in Hindi or Kannada; a full browser session with a real microphone and screen share, which the user will do when verifying locally; the debrief teach-back end to end. The offline test suite covers all of these paths with a scripted fake Live session (`tests/live.test.mjs`).

## Run it locally with live AI

`.claude/launch.json` → `tacit-poc-live` (port 3202, persistent local database, no samples). It needs `GOOGLE_CLOUD_PROJECT` in `.env` and `gcloud auth application-default login`. Chrome or Edge on a desktop is needed for screen sharing.

Without AI (`tacit-poc-offline`), the same flow runs **typed**. Words are stored and the session ends in a Work Map page, which says plainly that steps need AI.

## Moonshot

Every organization and every craft keeps its judgment in a few heads. With a camera or a shared screen and twenty minutes of someone's time, Moti can turn that into a confirmed, quoted, testable Work Map. The same map then teaches the next person in their own language and gives AI agents a list of the places where they must stop and ask a human. A Kathak guru in Jaipur, a weaver in Phulia and a payments analyst in Bengaluru use the same loop: **show it once, confirm it, pass it on, without losing why.**
