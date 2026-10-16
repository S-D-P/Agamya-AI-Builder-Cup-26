# Evaluation on public data

Two evaluations on public datasets, chosen to test two of the Apprentice Test questions: **can the expert trust it** (personal data) and **does Moti understand what it saw, without inventing anything** (the Work Map). Both are reproducible. The datasets are not redistributed: download them into `data/public/` (gitignored), then run the scripts. Results are versioned in `data/`.

## 1. Personal-data masking (trust)

**Data.** [ai4privacy/pii-masking-200k](https://huggingface.co/datasets/ai4privacy/pii-masking-200k), English file (43,501 labelled sentences), used under its free licence for evaluation.

**What is measured.** For each type the redactor targets: was the labelled value removed? For values that must stay readable at work (amounts, dates, times, building numbers, zip codes): was the value changed (over-masking)?

```
curl -L -o data/public/ai4privacy-english.jsonl https://huggingface.co/datasets/ai4privacy/pii-masking-200k/resolve/main/english_pii_43k.jsonl
node scripts/eval-redaction.mjs        # → data/eval-redaction.json (deterministic, about 10 s, no AI)
```

| Type | Labelled | Before evaluation | After fixes |
|---|---:|---:|---:|
| Email | 4,092 | 100% | **100%** |
| IBAN | 1,973 | 99.9% | **99.9%** |
| National id (US SSN and similar) | 2,045 | 53.2% | **99.9%** |
| Phone number | 2,425 | 46.0% | **94.6%** |
| Card number, Luhn-valid | 266 | 100% | **100%** |
| Card number, all labelled | 2,574 | 10.4% | 10.4% (see below) |

| Must stay readable | Changed |
|---|---:|
| Amounts, dates, times, ages | 0% |
| Building numbers / zip codes | 0.3% / 0.9% |

**What the evaluation changed.**
- Phone numbers written with dots (`+234 693-143.6710`) and national ids glued to a label (`SSN132-65-3444`) or with dots (`756.2808.9893`) were missed. The patterns now cover them.
- The spot check that came with this showed a real problem for the Work use case. Plain 10–11 digit **business numbers** (PO 4500012345, transaction 20231015001) were being masked as phone numbers. A plain digit run is now treated as a phone number only if it starts with `+` or is an Indian mobile number. All of these cases are now unit tests.

**Honest reading.**
- Most card numbers in this synthetic dataset fail the Luhn checksum, which every real card number passes. The redactor deliberately masks only Luhn-valid numbers so that invoice and account references stay readable. It catches 100% of the Luhn-valid ones.
- The remaining phone misses are unusual mixed-separator formats (`09 37.71.60-04`).
- Names, addresses and free-text identifiers are **not** detected. This is pattern masking, not a guarantee. Off the record and per-moment deletion remain the primary controls.

## 2. Work Map grounding (understanding without invention)

**Data.** [YouCook2](http://youcook2.eecs.umich.edu/) validation annotations (via the `lmms-eval/YouCook2` mirror). These are real YouTube cooking videos with human-annotated, timestamped procedure steps. Each annotated step becomes a timestamped camera event, as Agamya's capture would record it. The first 25 recipes with at least 5 steps are used, in two conditions:
- **silent:** the cook says nothing, so every reason must be labelled AI-inferred and any quote the model claims is unsupported.
- **narrated:** the cook says each step aloud ("Now I …"); quotes must verify verbatim against that speech.

**What is measured.** All checks are deterministic, with no LLM judge:
- coverage of the annotated steps;
- cited evidence that does not exist (invented event ids), before verification;
- step order;
- quotes claimed versus verified;
- the number of "still unclear" questions.

```
curl -L -o data/public/youcook2-val.parquet https://huggingface.co/datasets/lmms-eval/YouCook2/resolve/main/data/val-00000-of-00001.parquet
python scripts/youcook2-to-json.py     # needs pyarrow
node scripts/eval-workmap.mjs 25       # → data/eval-workmap.json (live Gemini 2.5 Flash, about 50 calls)
```

**Results** (25 recipes, 212 annotated steps, both conditions, run 2026-10-16, 50 calls, $0.23, 0 failed):

| | Silent | Narrated |
|---|---:|---:|
| Annotated steps covered by the map | 100% | 100% |
| Map steps / annotated steps | 179 / 212 | 211 / 212 |
| Cited evidence that does not exist (of 424 citations, before verification) | 0% | 0% |
| Steps in the order they happened | 100% | 100% |
| Quotes claimed by the model → verified | 1 → 0 | 3 → 3 |
| Maps listing 3+ open questions | 25/25 | 23/25 |

**Honest reading.**
- With the cook silent, the model claimed **one** quote. It did not appear in anything said, so the deterministic check removed it and the reason shows as AI-inferred. Every narrated quote verified. This is the guarantee that matters: *no reason is shown as the expert's words unless they said them*.
- Each map listed what it did not know (why a step is done, quantities, signals). That gives the debrief its questions.
- The events here are human-written step descriptions. That is easier than perceiving raw frames, so coverage and order measure the **map builder**, not frame perception. Frame understanding is exercised in live sessions ([LIVE_MOTI](LIVE_MOTI.md)).
- YouCook2 has no "why" annotations, so this does not measure the quality of reasons, only that none are invented.

## Not evaluated yet

- **When to ask.** There is no public dataset of "good moments to interrupt an expert". This is measured in live sessions instead (see [LIVE_MOTI](LIVE_MOTI.md)).
- **Learner outcomes.** Practice results are labelled as practice, not certification.
- **Web-task traces** (Mind2Web / WebArena) would test screen capture of software work. They are too large for this round.
