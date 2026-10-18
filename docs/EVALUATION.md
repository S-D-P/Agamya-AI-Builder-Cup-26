# Evaluation

Measured on public data and on the live app. Raw results are in `data/`. The datasets are not in the repo: download them into `data/public/` (see each script's header).

## 1. Personal data is masked before storage

**Data:** [ai4privacy/pii-masking-200k](https://huggingface.co/datasets/ai4privacy/pii-masking-200k), English, 43,501 labelled sentences. **Run:** `npm run eval:redaction`

| Type | Masked |
|---|---:|
| Email | 100% |
| IBAN | 99.9% |
| National ID (SSN and similar) | 99.9% |
| Phone number | 94.6% |
| Card number (valid) | 100% |
| **Kept readable:** amounts, dates, times | 0% changed |

The evaluation found two gaps, which are now fixed and tested:
- **Missed formats:** phone numbers and IDs written with dots were missed.
- **Business numbers:** PO and transaction numbers were being masked as phone numbers. They now stay readable.

The redactor does not detect names or addresses. Consent, "off the record" and deleting a moment remain the main controls.

## 2. Work Maps stick to what was shown and said

**Data:** [YouCook2](http://youcook2.eecs.umich.edu/) validation set: 25 real recipes, 212 human-annotated steps, each step given to Agamya as a camera event.

**Run:** `npm run eval:workmap` (50 Gemini calls, $0.23 in total).

| | Cook silent | Cook narrating |
|---|---:|---:|
| Annotated steps covered | 100% | 100% |
| Invented evidence (made-up event ids) | 0% | 0% |
| Steps in the right order | 100% | 100% |
| Quotes claimed → verified | 1 → 0 | 3 → 3 |

The one quote nobody said was caught and labelled AI-inferred. **No reason is shown as the expert's words unless they said them.**

## 3. The live app (October 2026)

| Check | Result |
|---|---|
| Moti asks after the expert pauses | about 2 s (English, Marathi, Hindi, Kannada) |
| Tutor stops a wrong decision (Hindi, Kannada, English) | about 1.6 s, at the right step |
| Agent on Vertex AI Agent Engine, "post ₹88,000 invoice" | STOP, quoting the expert |
| End-to-end on the deployed app (22 checks: capture → map → share → request → Ask → listen → agent → impact → passcode → removal) | 22 / 22 pass |
| Automated tests | 177 / 177 pass |
| Tested on iPhone (camera practice, voice) | works |

## Not measured

- **When to ask:** there is no public dataset for "the right moment to ask". It is checked in live sessions.
- **Learning outcomes:** practice results are labelled practice, not certification.
