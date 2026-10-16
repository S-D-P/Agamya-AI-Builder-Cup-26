# Threat model

Scope: the Agamya web application, its API and worker, PostgreSQL, object storage and the Vertex AI boundary. Method: assets → actors → trust boundaries → STRIDE-style threats with the mitigation as implemented, and what remains.

## Assets

| Asset | Why it matters |
|---|---|
| Raw capture (screen frames, camera, voice) | May contain customer data, colleagues, faces, voices; highest sensitivity, shortest retention |
| Transcripts and observations | Derived from raw capture; still sensitive |
| Validated knowledge | The organization's intellectual property; the product's value |
| Learner attempts and reasoning | Personal performance data |
| Credentials, session and CSRF tokens | Account takeover |
| Audit trail | Accountability; must be tamper-resistant |
| AI budget | Direct cost |

## Actors

Anonymous internet user · authenticated user of another tenant · a member with a lower role (learner, expert) · a malicious or careless document author (SOP content) · content on the captured screen or spoken aloud · the model itself (untrusted output) · an operator with cloud access.

## Trust boundaries

1. Browser ↔ API (cookie session, CSRF, Origin).
2. API ↔ PostgreSQL (`app_rw` role + RLS vs. owner role for `db.system`).
3. API/worker ↔ object storage (org-namespaced keys; private bucket).
4. Application ↔ model (prompt trust layers in; deterministic validators out).
5. Tenant ↔ tenant inside one database.

## Threats and mitigations

| # | Threat | Mitigation (implemented) | Residual risk |
|---|---|---|---|
| S1 | Credential stuffing / brute force | scrypt, per-IP+email rate limit, lockout, generic errors, timing equalization | No breached-password service; no MFA in local auth (use OIDC with IdP MFA) |
| S2 | Session theft | HttpOnly, `__Host-`, Secure, SameSite cookie; hashed token storage; idle + absolute expiry; revocation | An XSS would still act as the user; CSP and no inline script reduce this |
| S3 | CSRF | CSRF header token + Origin check on every state change | — |
| T1 | Tampering with org/role/owner in requests | `ctx` only from the server session; bodies never carry an authorization org; RBAC + ownership in domain code | — |
| T2 | Audit or validation history altered by the app | UPDATE/DELETE revoked from `app_rw` on audit, inference log, validations, versions, acceptances | A database owner or operator can still alter rows; export audit to a separate sink for stronger guarantees |
| I1 | Cross-tenant read (IDOR) | RLS on every tenant table + app checks; 404 on foreign ids; tested on 13 endpoints | Bugs in reviewed `db.system` code paths (identity, job claiming) bypass RLS by design |
| I2 | Raw media exposure | Private bucket, media served via authorized endpoint or 5-minute signed URL; retention purges non-evidence media at approval and on expiry | Signed URLs are bearer tokens for 5 minutes |
| I3 | Secrets in logs | Redaction list; no bodies or transcripts logged; 5xx hides internals | New log statements must respect the list (reviewed manually) |
| I4 | Over-collection during capture | Explicit per-modality consent; pause, exclude modality, delete moment; frames sent only on change; raw retention "evidence only" by default | Whatever is on screen while capturing is captured; experts must pause for sensitive moments |
| D1 | Upload or job flooding | Per-route rate limits, size limits, idempotent uploads, bounded job retries with dead-lettering | No per-tenant storage quota yet |
| D2 | AI cost exhaustion | Per-organization monthly budget blocks model calls; per-operation context profiles cap tokens | Budget is an estimate from list prices |
| D3 | Poison media (malformed WAV/PDF) | Magic-byte sniffing, PDF active-content rejection, defensive WAV parser; failing jobs dead-letter after 4 attempts | Gemini still receives the bytes for transcription |
| E1 | Learner reads answers or evidence | RBAC denies sessions, knowledge internals and audit to learners; tutor leak guard prevents hints that reveal the answer key | — |
| E2 | Expert approves someone else's judgment | Only the captured expert's person may approve; tested | — |
| AI1 | Prompt injection via SOP, screen text or speech | Trust-segmented prompt, random fences, injection scan with visible flags; tested (document instructions 3/3, fake system command in an answer 3/3) | Novel injections may still bias wording; they cannot approve knowledge, since only humans can |
| AI2 | Hallucinated reasons or boundaries | Verbatim-quote verification, event-id evidence for OBSERVED, boundary confirmed only from expert words, epistemic status per field; tested (invented boundary 3/3 refused) | Paraphrased-but-wrong summaries of real quotes are possible; the expert reviews before approval |
| AI3 | Confidence presented as truth | Knowledge levels derive from evidence and human validation, never model confidence (unit tested); confidence displayed as "self-reported, not used as evidence" | — |
| AI4 | Model output used for grading | Learner correctness is deterministic against the answer key; the model only coaches | Model-derived *scenarios* are labeled MODEL_DERIVED until a human validates them |
| G1 | A learner or colleague sees knowledge its contributor kept private | One visibility predicate on every read path (lists, detail, lessons, attempts, scenario visuals); 404 when not visible; tested | Reviewers in a workplace can see *unapproved* drafts (to supervise capture); never in living spaces |
| G2 | Private knowledge leaks into another person's AI session (retrieval, cross-expert checks) | AI retrieval only considers knowledge shared with the whole space or the session owner's own; tested | — |
| G3 | Sensitive cultural knowledge shared too widely | Restriction flag limits sharing to named people (database constraint); public publication and model training have no code path | The software cannot judge cultural sensitivity; communities set their own rules |
| S4 | Public sample spaces abused to burn AI budget or storage | Per-IP rate limit (6 per 10 min), daily cap on new sample spaces (60 in the deployed demo), $1 monthly AI budget per sample space, no passwords on sample accounts | Abandoned sample spaces are not yet garbage-collected |
| S5 | A visitor enters someone else's sample space or a real organization | Sample sign-in only for users whose memberships are all in that one sample space; switching only to people inside the current space; shared demo sign-in refuses sample spaces; tested | — |
| R1 | Repudiation of consent or approval | Consent records policy version, modalities, time and clock offset; approvals and validations are append-only and audited | — |

## Out of scope / not yet addressed

- Customer-managed encryption keys (CMEK), data residency controls, and per-tenant databases (the model supports adding these).
- SCIM provisioning; MFA for local accounts (delegate to OIDC IdP).
- Malware scanning of uploads beyond type sniffing and PDF active-content checks.
- Formal penetration test.
- Email delivery (invitations are copy-paste links).
