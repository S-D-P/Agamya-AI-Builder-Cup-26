# Three-minute demo: a real session, recorded by you

No samples: the demo is a real person doing real work. Record it on the live local build (`tacit-poc-live`) or on the deployed app. Use Chrome or Edge on a desktop, wear headphones (so Moti's voice is not picked up by the microphone), and use test data on screen, never real customer data.

**0:00 – 0:20 · Landing.** The painted stage: Kathak in Jaipur melts into the Phulia loom, then the Seki swordsmith, the Seoul vocal coach, Bengaluru debugging and the Singapore investment call. "Every craft keeps its judgment in a few heads." Click **Agamya for Work → Start with your screen**.

**0:20 – 1:20 · Capture (Work).** One consent card (what is captured, by whom, how long, your controls). Then share a screen showing a test spreadsheet of supplier invoices. Work and talk naturally:
- "This one is 72,000, over fifty thousand, so I hold it for the controller."
- Pause. Moti asks one short question (expect a guardrail or exception question).
- Answer it. Click **Off the record**, then come back; show that the panel says so.
- Click **I'm done**.

**1:20 – 2:00 · Work Map and debrief.** The map: steps, the screen moment, the decision, the reason in your quoted words, guardrails. Point at one item labelled **AI-inferred**: "it never pretends I said something I didn't." Click **Start the debrief**, answer one of Moti's unclear questions, and let Moti explain the process back. Click **Yes, that's how it works**. Then show **Export for agents** (the `STOP AND ASK A PERSON` lines).

**2:00 – 2:45 · Practice.** As a teammate (or in a second browser profile), open the map, choose **Practise this**, choose Hindi or Kannada, and share the screen with the same sheet. Start to post the 72,000 invoice. Moti interrupts in that language ("… would stop here. Why do you think?") and replays the expert's screen moment. Say "I'm finished": Moti summarises, and the result shows what was handled well and what to practise.

**2:45 – 3:00 · Culture and close.** Flash **Start with your camera**: the same loop for a craft, such as a ghee pan or a loom. Close on the moonshot line from [LIVE_MOTI](LIVE_MOTI.md).

## Backup plan
If live Gemini is slow or returns HTTP 429:
- Narrate over the prepared records.
- A failed AI step shows its fallback honestly (for example "Not checked yet: the AI check was unavailable").
- Never present a timeout or a 429 as a success, and never edit the database to fake a state.

## Video placeholder
The landing page shows "Product walkthrough coming soon" until `DEMO_VIDEO_URL` is set (see `src/config.mjs`; also `DEMO_VIDEO_CAPTIONS_URL` (WebVTT), `DEMO_VIDEO_TRANSCRIPT_URL`, `DEMO_VIDEO_POSTER`, `DEMO_VIDEO_TITLE`). The configured origin is added to the media CSP automatically. Provide captions and a transcript with the real video.
