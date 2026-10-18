# Submission handover

| Deliverable | File | Status |
|---|---|---|
| Pitch deck (editable) | `Agamya-Submission-Deck.pptx` | 15 slides on the challenge template. Headings unchanged; full references in the speaker notes and on slide 14. |
| Pitch deck (PDF) | `Agamya-Submission-Deck.pdf` | 15 pages, exported from PowerPoint. |
| Demo video | `Agamya-Demo.mp4` (not in git) | **3:16.7**, 1920×1080, captions burned in, −16 LUFS. |
| Captions | `Agamya-Demo.srt` | English; Marathi lines are translated. |
| Story page | `/#/inspiration` in the app | Public, linked from the landing page. |
| Sources | `RESEARCH_LEDGER.md` | Every outside fact, with its source and caveats. |

## Still to do (you)

1. Upload `Agamya-Demo.mp4` to YouTube (Unlisted is fine). Put the link in:
   - slide 13 ("ADD YOUTUBE LINK"), then re-export the PDF;
   - `README.md` ("Demo video");
   - the submission form.
2. Run `git push origin main`.

## What the video shows

1. Story cards: muslin, Majhi, Japan, the workplace.
2. Bharati records a Satara recipe in Marathi, and Moti asks why (low flame, reddish onion).
3. The Work Map and the Marathi lesson.
4. The map is shared with Kiran.
5. Export for agents.
6. Kiran practises with Moti.
7. The Work flow, from screenshots.
8. Google Cloud stack and links.

The narration was voiced with Gemini TTS, and the speech was transcribed with Gemini on Vertex AI.

**Left out on purpose:** practice moments where Moti added details Bharati never said ("remove the skins", "5–7 minutes").

## Fact checks that changed the story

- **Majhi.** The source reports **one** speaker in India in 2013: Thak Bahadur Majhi, 80, in Sikkim. It does not say "four speakers in one family". Majhi is still spoken in Nepal.
- **Muslin.** The "cut thumbs" story is told as a **legend**. It traces to William Bolts (1772). The documented causes are tariffs and machine-made imports.
- **Japan.** The figures (288,000 in 1979 to 48,334 in FY2022) come from Garland Magazine, citing industry-association data. JapanCraft21's uncorroborated "90% lost by 2028" forecast is **not** used.
- **The 42% figure** is from Panopto's own 2018 survey, and is attributed to it.
- **Costs.** Only the Work Map cost is measured ($0.23 for 50 builds). The other costs are labelled as estimates.

## Checks run

- 176/176 automated tests pass, including the accessibility checks.
- Every slide was rendered and inspected.
- Inspiration page:
  - checked at desktop and 375 px width, with no horizontal scroll;
  - chapter links move focus;
  - reduced motion is respected.
