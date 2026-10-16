# Security

What is implemented, where, and how it is tested. Threats and residual risks are in [THREAT_MODEL](THREAT_MODEL.md).

## Principles

1. **Never trust the client** for organization, user, role, permission, ownership or workflow access. `req.ctx` is built only from the server-side session. Request bodies never carry an `orgId` that is used for authorization.
2. **Defense in depth for tenancy**: application checks *and* PostgreSQL Row-Level Security.
3. **Least data**: raw media is short-lived, logs exclude content, IPs are stored hashed.
4. **The model is untrusted**: its output is validated deterministically before it can become knowledge, and content it reads is fenced as data.

## Identity and sessions (`src/domain/identity.mjs`, `src/platform/security.mjs`)

| Control | Implementation |
|---|---|
| Passwords | scrypt (N=32768, r=8, p=1, 64-byte key, per-password salt), NFKC-normalized, constant-time compare; unknown users still pay a hash (timing equalization). Minimum 12 characters, common-password and email-derived checks |
| Lockout | 5 failures → 15 minute lock (configurable). The failure counter is committed in its own transaction so it survives the rejected login |
| Rate limits | Login 10 / 5 min per IP+email; signup 5 / 15 min; invite acceptance 10 / 15 min; global 600 / min per user or IP; AI-heavy routes 120 / min; TTS 30 / min |
| Sessions | Opaque 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` prefix + `Secure` in production). Only its SHA-256 is stored. 12 h absolute and 120 min idle expiry. Server-side revocation on logout |
| CSRF | Per-session CSRF token (stored hashed) required in `x-csrf-token` on every state-changing request; `Origin` must equal `PUBLIC_ORIGIN` when present |
| Enterprise SSO | OIDC authorization code + PKCE + state + nonce (`openid-client` v6). Requires `email_verified`. Disabled accounts are refused at login |
| Invitations | Single-use, hashed token, 7-day expiry, roles fixed by the inviter. Email delivery is not implemented; links are shared out of band |
| Demo sign-in | `/api/auth/demo-login` exists only when `DEMO_LOGIN` is on (default off in production) and only for users whose memberships are **all** in the shared demo organization (never a sample space or real organization). It is used by scripts; the browser uses per-visitor sample spaces instead |

## Authorization (`src/platform/authz.mjs`)

Server-side RBAC with five roles: `ORG_ADMIN`, `WORKFLOW_OWNER`, `EXPERT`, `LEARNER`, `REVIEWER`. A single permission matrix (`PERMISSIONS`) is the source of truth; `requirePermission` is called in domain code, not only in routes. Ownership rules are layered on top:

- Only the **captured expert** can consent, upload, answer, pause, delete moments, or approve their judgment.
- An expert cannot peer-confirm their own knowledge.
- The last `ORG_ADMIN` cannot be demoted.
- Learners see lessons and their own attempts; they cannot read sessions, raw evidence, knowledge internals or audit.

Every `403` is written to the audit log (`authz.denied`) with route and reason.

## Knowledge governance inside a tenant

Sharing is the contributor's decision, separate from consent to record (details in [GOVERNANCE](GOVERNANCE.md)). `visibleSql` in `src/domain/knowledge.mjs` is a single predicate applied to every read path; a stricter rule (`aiUsableSql`) applies to AI retrieval so another person's private knowledge is never sent to the model for someone else. Only the contributor can change sharing; restricted knowledge is limited to named people by a database constraint; withdrawal deletes evidence media. Public publication and model training have no code path.

## Sample spaces

Public visitors can create an isolated sample space (`POST /api/samples`, when `SAMPLE_SPACES` is on). Sample people have no password; the only way in is the sample flow, which signs in a user whose every membership is in that one space (`identity.sampleLogin`). Switching person (`/api/samples/switch`) is limited to people in the visitor's current space. The shared demo sign-in (`DEMO_LOGIN`) refuses sample spaces and real organizations. Abuse is bounded by per-IP rate limits, a daily cap and a small monthly AI budget per space.

## Tenant isolation (`src/platform/db.mjs`, migrations `001_init.sql`, `002_agamya.sql`)

- Every tenant table has `org_id` and an RLS policy `org_id = app_org()` for both `USING` and `WITH CHECK`.
- Request and job code runs in `db.tenant(ctx, fn)`: one transaction that executes `SET LOCAL ROLE app_rw` (not the owner, no `BYPASSRLS`) and `set_config('app.org_id', …, true)`. Forgetting a `WHERE org_id` cannot leak rows.
- Identity tables (`users`, `user_identities`, `auth_sessions`, `invitations`) are revoked from `app_rw` entirely; only reviewed `db.system` code touches them.
- Audit, inference logs, validations, judgment versions and policy acceptances are append-only for `app_rw` (UPDATE/DELETE revoked).
- Object keys are namespaced `org/{orgId}/…` and validated against a strict pattern (no `..`). Media is served only through `/api/media/:id`, which authorizes the asset through RLS first.
- Cross-tenant IDs return `404`, not `403`, so existence is not disclosed.

**Tests** (`tests/security.test.mjs`): tenant B probes 13 of tenant A's resources by ID (workflow, session, media, judgment, attempt, scenario visual, knowledge list, evidence window, validate, delete observation, start session, start attempt, consent), and every probe fails. A direct database test shows `app_rw` sees zero rows without the tenant setting.

## Uploads (`validateUpload`, `sniffMime`, `inspectPdf`)

- Type is decided by **magic bytes**, not the declared `Content-Type`, and must match the declared kind and modality (PNG/JPEG/WebP frames; WAV or WebM audio; WebM/MP4 video; PDF or UTF-8 text documents).
- Per-kind size limits (frames 3 MB, audio 6 MB, video 25 MB, documents 10 MB).
- PDFs containing active content (`/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/RichMedia`, `/XFA`, or a JavaScript `/OpenAction`) are rejected. PDFs are never rendered or executed server-side; they are only passed to Gemini.
- Uploads require active consent for that modality, a session in capturing state, the modality not paused or excluded, and the uploader to be the captured expert.
- SHA-256 idempotency: duplicate uploads return the existing asset and are not reprocessed.
- Audio is parsed defensively. A malformed or hostile WAV header yields "unknown" rather than an exception (regression test included).

## Web hardening (`src/app.mjs`)

Helmet CSP: `default-src 'self'`, no inline script (the UI uses no inline handlers), `frame-ancestors 'none'`, fonts only from Google Fonts, media/img from self, `blob:` and the GCS host. `Permissions-Policy` allows camera, microphone and display capture only for self. `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. UI assets are served `Cache-Control: no-cache` (ETag revalidation) so clients never run stale code after a deploy. JSON body schemas use `additionalProperties: false` and max lengths. Known Postgres conditions map to client errors (unique violation → 409, malformed id → 400), and 5xx responses carry only a request reference, never database codes or stack traces.

## AI-specific security (`src/ai/prompt.mjs`, `src/ai/validators.mjs`)

Trust segmentation, highest to lowest: **SYSTEM POLICY** › **PLATFORM POLICY** › **WORKFLOW CONFIG** › **EXPERT KNOWLEDGE** › **USER INPUT** › **OBSERVED CONTENT** › **EXTERNAL DOCUMENT CONTENT**.

- Only the system and platform policy and the task section instruct the model. Everything else is wrapped in a per-call random fence (`<data-1a2b3c4d …>`), with the fence string removed from the content, so data cannot close its own block.
- `scanForInjection` flags instruction-like text in documents, screen text and transcripts; flags are stored on the observation and shown in the UI. Documents with suspicious instructions are flagged at workflow creation.
- Model output never becomes knowledge directly: quotes must be verbatim in the expert's words, OBSERVED claims must cite real event IDs, documented-procedure attributions must overlap the actual procedure, boundaries are "confirmed" only from expert words, and only a human approves.
- Tested live: 36/36 adversarial cases (document injection, fake system command inside an expert answer, invented boundaries, changed answers, accidental and cosmetic changes). See [AI_CONTEXT_ARCHITECTURE](AI_CONTEXT_ARCHITECTURE.md).
- A per-organization monthly AI budget blocks model calls when exhausted. The product degrades to deterministic fallbacks; it does not fail open.

## Logging and audit

- Structured JSON (pino), Cloud Logging `severity`, request id, tenant id, user id, operation, latency, error category.
- **Never logged**: passwords, session or CSRF tokens, cookies, authorization headers, API keys, request bodies, transcript text, answers, learner reasoning, media bytes (`REDACT` list in `src/platform/logger.mjs`).
- `audit_events` records security-relevant actions: logins and failures, role changes, invitations, consent, privacy changes, deletions, approvals, policy publication and acceptance, settings changes, authorization denials. IPs are stored as salted SHA-256 hashes (`IP_HASH_SALT` required in production).

## Secrets

No secrets in code or image. Production reads `DATABASE_URL`, `IP_HASH_SALT` and the OIDC client secret from Secret Manager. Vertex AI and GCS use the Cloud Run service account; signed URLs use IAM signBlob, so there are no key files.

## Policies and consent (`src/domain/policy.mjs`, `src/policies/*.md`)

Versioned Terms of Service, Privacy Policy, AI Usage Policy, Recording & Consent Policy and Acceptable Use Policy. Users must accept current versions before using the API (HTTP `428`). Acceptance records version and content hash. Admins can publish organization versions, which re-prompts acceptance. **The shipped texts are templates, marked in the UI as "template, not legal advice"; they are not legally sufficient and must be replaced by counsel-reviewed text.** Capture consent is explicit, per session and per modality, references the consent-policy version, and is revocable (pause, exclude a modality, delete a moment).

## Running the security tests

```bash
npm test     # includes tests/security.test.mjs (19 checks) and tests/governance.test.mjs (15 checks)
```

## Spaces, roles, groups, missions (expansion round 2)
- **Roles are per space.** The permission map is in `src/platform/authz.mjs`.
  - Only an owner grants or removes Owner or Administrator.
  - The last owner cannot be removed.
  - Coordinators can invite only experts and receivers.
- **Every group, mission, requirement, invitation and notification route** checks permissions on the server, then checks resource access (coordinator, participant, or read-any role). Records from another space return 404 under RLS.
- **Tests:** `tests/platform.test.mjs`. They cover cross-space ids (person, group, mission), receivers versus coordinators, learners creating groups or templates, drafts hidden, notification row-level privacy, and revoked invitation links.
- **Brief documents** are untrusted:
  - type and size validated (text, or PDF validated by magic bytes and active-content checks);
  - text sanitised;
  - scanned for instruction-like content, with flags shown to the coordinator;
  - fenced in prompts as data.
- **No email or other external messages** are sent by any code path.
