# Submission: Google Cloud AI Builder Cup 2026

**Product:** Agamya · **Category:** Future of Work & Enterprise Productivity

## Deployed prototype

**URL:** https://agamya-82538920788.us-central1.run.app (verified October 14, 2026: `/readyz` reports Cloud SQL, Cloud Storage and Vertex AI ready; landing, sample space, kitchen capture, live detection and questions work). Known issue: Vertex AI intermittently returned 429 (resource exhausted) and timeouts on this project; a retry is implemented locally and needs one more deploy.

> **Deployment status (October 15, 2026), round 2:** Personal and Enterprise spaces, KT missions, groups, in-app notifications, storage reuse and the Ask cache are implemented and pass 146/146 offline tests. The mission flows were also verified live against Vertex AI from a local server. **Not deployed.** Migration 004 has been verified on PGlite only.
>
> **Deployment status (October 14, 2026):** the deployed revision predates the expansion round (Detective, Stress Test, Radar, Marathi, accessibility fixes, AI retry). Those are implemented and pass 112/112 tests locally. They go live after the next deploy (`PROJECT=polaris-opportunity-engine bash scripts/deploy/cloudrun.sh`), which applies migration 003 on start.

## How a judge can try it (about 3 minutes)

1. Open the URL and click **Watch Amma teach Meera to make ghee**. A private sample space is created just for you.
2. Accept the (template) policies. The journey page shows each step and its real state.
3. **Start the kitchen session** → agree to capture → open *Sample script* → **Play the actions**. Wait for Agamya's question (~30–40 s of live Gemini processing).
4. Click **Use the sample answer** (or type your own) → Send; answer the follow-up the same way.
5. Read *What Agamya understood*: each field is observed, quoted from the teacher, or labeled AI-inferred, plus what is still uncertain. **Approve** (saved privately).
6. Back on the journey: **Share with Meera only** → **Continue as Meera** → **Start my lesson**. Try the new case, then the counterexample. Copying Amma's timing on the counterexample is caught as overgeneralization.
7. Sign out and click **Explore Agamya for Work** to see knowledge transfers, the expert disclosure, and learner progress.

The kitchen camera is simulated (rendered frames that go through the real capture → storage → analysis path), and the suggested answers are scripted. Both are labeled in the product.

## Google Cloud services actually used

| Service | Used for |
|---|---|
| **Vertex AI: Gemini 2.5 Flash** | Reading camera and screen frames, transcription, judgment detection, questions, knowledge extraction, boundary discovery, documentation-gap analysis, expert reconciliation, scenario generation, coaching, learner evaluation |
| **Vertex AI: text-embedding-005** | Retrieval of related approved knowledge |
| **Vertex AI: Gemini TTS** | Spoken questions (optional) |
| **Cloud Run** | The application (one service in the demo profile; API + worker in production) |
| **Cloud SQL for PostgreSQL 16** | System of record, row-level-security tenancy, job queue, pgvector index, audit |
| **Cloud Storage** | Private media and documents |
| **Secret Manager** | Database URL, IP-hash salt |
| **Cloud Build / Artifact Registry** | Container build and image storage |

## Submission checklist

**Proposal PDF**
- [ ] Problem: tacit judgment is lost at handovers and between generations; recordings and documents don't capture *why* or *when not*
- [ ] Solution and the pipeline (Observe → Notice → Ask → Approve → Boundary → Compile → Test transfer → Measure)
- [ ] Two experiences on one engine (Work, Living Knowledge) and the governance model
- [ ] Technical merit: Gemini's role vs the deterministic guards ([DIFFERENTIATION](DIFFERENTIATION.md), [AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md))
- [ ] Architecture diagram ([ARCHITECTURE](ARCHITECTURE.md)) and Google Cloud services (table above)
- [ ] Measured results with method and limits ([RESULTS](RESULTS.md)): 72% fewer tokens, 34/35 detection agreement, 36/36 adversarial, live acceptance, 112 offline tests (incl. 23 accessibility, 23 Detective/Stress/Radar/Ask/language), 8/8 live Marathi eval
- [ ] Impact framing for enterprise buyers (handover time, single-holder risk, supervision needs) and for communities
- [ ] Honest limits: synthetic ground truth, no human study yet, simulated feeds in the demo, template policies
- [ ] Deployed URL and repository link

**Demo video (public, ≤3 minutes)**: script in [DEMO_SCRIPT](DEMO_SCRIPT.md)
- [ ] Record against the deployed URL; prepare one completed sample space as a fallback
- [ ] Say that the kitchen feed is simulated and answers are scripted
- [ ] Show the question, the evidence labels, private-by-default sharing, the counterexample, and the Work transfer
- [ ] Upload as public; add the link to the proposal and the submission form

**Repository**
- [ ] README and docs match the implementation (reviewed October 13, 2026)
- [ ] No secrets committed (`.env` ignored; production secrets live in Secret Manager)

## Running costs and teardown

The demo deployment creates: Cloud SQL instance `agamya-db` (db-f1-micro, about $10/month while it exists), bucket `polaris-opportunity-engine-agamya-media`, secrets `agamya-*`, Artifact Registry repository `agamya`, Cloud Run service `agamya` (scales to zero; billed per use), and service account `agamya-run`. Model calls are billed per use; each sample space has a $1 monthly AI budget and at most 60 sample spaces can be created per day.

To remove everything after judging:

```bash
gcloud run services delete agamya --region us-central1 --project polaris-opportunity-engine
gcloud sql instances delete agamya-db --project polaris-opportunity-engine
gcloud storage rm -r gs://polaris-opportunity-engine-agamya-media
gcloud artifacts repositories delete agamya --location us-central1 --project polaris-opportunity-engine
gcloud secrets delete agamya-database-url --project polaris-opportunity-engine
gcloud secrets delete agamya-db-password --project polaris-opportunity-engine
gcloud secrets delete agamya-ip-hash-salt --project polaris-opportunity-engine
```
