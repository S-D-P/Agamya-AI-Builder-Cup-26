# Multilingual intelligence

## Design
- **One model and no translation pipeline.** Gemini reads and writes the person's language directly (`src/ai/language.mjs`). No new provider or paid service was added.
- **Two separate languages:**
  - The **interface language** is the person's saved preference (`users.preferred_language`; `POST /api/me/language`).
  - The **content language** is recorded on each capture session, dialogue turn, gap answer, generated case, learner evaluation and Ask reply.
- **Original first.** The expert's words are stored and shown as said, in their script, with English words kept inside Marathi speech.
  - An English rendering (`valueEn`) is optional, labelled "AI translation, not the expert's words", and never shown as a quote.
  - Quotes are checked verbatim against the expert's words with Unicode-aware normalization (NFC; letters, marks and digits in any script).
- **Domain terms are kept.** The prompt instruction tells the model never to translate terms literally. Example: in ghee-making, "बेरी" is the browned milk solids, not the fruit.
- **Spoken input is a draft.** Speech becomes an editable transcript, shown with the detected language and a low-confidence warning. It counts only after the speaker confirms or corrects it. The answer then records `voice` or `voice_corrected` and keeps the machine transcript (`answer_original`).
- **Language choice:**
  - A session asks in the language the expert picks.
  - Ask replies in the language of the question: Marathi when at least 30% of its letters are Devanagari, unless the person set a preference.
  - If the knowledge does not cover the question, the reply says so in that language.
- **Accessibility.** Marathi text carries `lang="mr"`, so screen readers switch voice. Language selects are real, labelled `<select>` elements.

## Languages offered

| Code | Offered | Tested | Notes |
|---|---|---|---|
| en | yes | yes | |
| mr | yes | yes, with the limits below | Content: capture questions, extraction, gaps, cases, evaluation, Ask, speech. Interface: partial |
| hi | **no** | no | Present in the server registry, marked `tested: false`, and not offered in the interface |

## Marathi evaluation (`data/eval/marathi.json`, `scripts/eval-marathi.mjs`)
- **Live Gemini 2.5 Flash on Vertex AI**, run on 2026-10-14. Results are in `data/eval/marathi-results.json`.
- **Final run:** 8 of 8 cases pass, 12 model calls, 0 failed calls, $0.022.
- **First run:** reported 3 failures, all caused by two bugs in the evaluation script itself:
  - it read the wrong field for the question;
  - it checked quotes on observed fields against the expert's words.

  Both were fixed, and the run was repeated once. The first run's raw output is kept in `marathi-results-run1-harness-bug.json`.

| Case | Behaviour | Result |
|---|---|---|
| mr-ordinary | Marathi follow-up question; extraction keeps Marathi; expert-stated quotes verbatim | pass |
| mr-codeswitch | "Store-bought लोण्यात पाणी जास्त असतं, so it takes longer…": English words kept in the quotes | pass |
| mr-trap | "बेरी" kept in the value; no English rendering says "berry" | pass |
| ask-grounded | Marathi question answered in Marathi from the knowledge, with a verified citation; answers by the colour, not the time | pass |
| ask-codeswitch | "Curry leaf टाकल्यावर काय बघायचं?" gets a grounded Marathi answer | pass |
| ask-ambiguous | "ते कधी बंद करायचं?" gets a grounded answer (the model chose an interpretation rather than asking to clarify) | pass (check allows either) |
| ask-unsupported | "तूप किती दिवस टिकतं?" gets "not enough information" in Marathi; nothing invented | pass |
| tts-roundtrip | Gemini TTS Marathi audio, then transcription: exact text back, language detected as mr | pass |

Offline regression tests (`tests/detective.test.mjs`) cover the in-app flow with a fake model:
- a Marathi session puts the Marathi instruction into the prompts;
- a learner's Marathi question gets a Marathi answer with a verified citation;
- an uncovered question gets the insufficient reply;
- invented citations are withheld;
- private knowledge is never a source;
- a spoken answer becomes a draft, and the correction is kept as `voice_corrected` alongside the original.

### Limitations (read before relying on Marathi)
- **No native-speaker review yet.** The eval set and the Marathi interface strings were written for this project with AI assistance. Wording, register and the expected meanings need review by a native speaker.
- **Small, single run.** 8 cases, 1 run, so expect run-to-run variation. This is evidence that the pipeline works, not a measured accuracy.
- **Synthetic speech only.** The speech test used Gemini's own TTS voice, which is much easier than a real speaker, a kitchen, or dialects such as Varhadi, Malvani or Konkan Marathi. Real recordings have not been tested.
- **Ambiguity handling.** The model preferred a reasonable interpretation over a clarifying question. Both are allowed; neither invents.
- **Full 10-step acceptance flow.** It runs end to end offline in tests. Live, the steps were exercised per operation (above), not yet as one continuous recorded session in the deployed app.
- **Partial Marathi interface.** Navigation and the Detective, Stress Test, Radar and Ask surfaces are translated; everything else falls back to English.

## Round 2: missions in Marathi
- A mission has its own **knowledge language**, separate from each person's interface language. It becomes the content language of its capture sessions, follow-up questions, practice cases and requirement explanations.
- Brief fields accept any script and are marked `lang="mr"` when Devanagari.
- **Fallback questions** (when the model is unavailable) now exist in Marathi too, so a Marathi session never silently switches to English. These strings need native-speaker review.
- **Live end to end** (`scripts/acceptance-missions.mjs`, section 5e; Gemini 2.5 Flash, 2 runs):
  - A Marathi Personal mission asked natural Marathi questions that built on the expert's words, for example `तुम्ही 12 मिनिटांनी गॅस का बंद केलात?`.
  - It kept her code-switched Marathi quotes verbatim.
  - An uncovered Marathi question was answered "not enough information" in Marathi in both runs.
  - The covered Marathi learner question was grounded with a citation in run 1. In run 2 the model flagged it insufficient while describing the right signal. **That is run-to-run variation, 1 of 2 grounded.**
- **Offline** (`tests/platform.test.mjs`): the ghee mission in Marathi passes the Marathi instruction and the brief into the prompts.

## Fallbacks (disclosed in the UI)
- **AI unavailable during a gap answer:** the proposal is "recorded as written (AI unavailable)", using the expert's own words.
- **Transcription unavailable:** the person is asked to type. Nothing is guessed.
- **Ask unavailable:** a message in the person's language says the answer is unavailable and suggests asking the expert.
