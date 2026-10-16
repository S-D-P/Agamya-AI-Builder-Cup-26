# Plan: Personal + Enterprise spaces, KT missions, groups, notifications, storage (2026-10-14)

## What exists (verified in code)
- **Spaces.** A space is an `organizations` row with `experience` = `work` | `living`; RLS isolates tenants (`app_org()`). Each space has memberships carrying per-space `roles`, plus `people`. Signup creates one space. `switch-org` exists, but signed-in users cannot create more spaces, and invitations can only be accepted by token link (no accept/decline/revoke states).
- **Roles:** ORG_ADMIN, WORKFLOW_OWNER, EXPERT, LEARNER, REVIEWER; the permission map is in `src/platform/authz.mjs`.
- **Sharing.** Knowledge is shared via `knowledge_artifacts.visibility` (private | named | organization) plus `shared_with` person ids, enforced by `visibleSql`. There are no groups.
- **Transfers.** `transfers` holds one expert and one learner per plan, with a start-capture link (`expert_sessions.transfer_id`). There are no missions, briefs, templates, lifecycle or requirements.
- **Notifications:** none. **Email:** none. Invitation links are shared out of band.
- **Capture.** Sources are `live:screen`, `live:camera`, `manual` and `sim:*`. Consent is per session and per modality. Narration and spoken answers work over the microphone. There is no audio-only source.
- **Storage.** Media goes to GCS or local disk, never PostgreSQL. `media_assets` records `sha256`, and duplicates are removed within one session. Unchanged frames are stored but not sent to the model. A context budget manager and the live token benchmark (72% fewer tokens) exist. There is no cross-session content addressing, no derived cache and no storage report.
- **Verified before changing:** the AI retry (`callJson`, one bounded retry for timeout, 429 and error, each attempt recorded) and migration 003 on PGlite. Migration 003 has **not** been run on Cloud SQL, and there is no local PostgreSQL or Docker on this machine.

## Smallest coherent design
1. **Migration 004** (additive only):
   - new roles ORG_OWNER, KT_COORDINATOR and AUDITOR (the roles CHECK constraint is replaced, never narrowed);
   - `groups` and `group_members`, with soft removal;
   - `knowledge_artifacts.shared_groups`;
   - `kt_missions`, `mission_participants`, `mission_groups`, `mission_requirements` and `kt_templates` (organization templates; built-in templates live in code);
   - `notifications`, with a dedupe key per user;
   - invitation states;
   - `expert_sessions.mission_id`;
   - `media_assets.dedup_of`;
   - `derived_cache`.
2. **Personal = `living`, Enterprise = `work`.** Same engine. Signed-in users can create more spaces and see their spaces and pending invitations.
3. **Groups** are application-level only, with no claimed IdP sync:
   - Mission assignment resolves group members into participants once (a snapshot, deduplicated, with the group recorded), so later membership changes never alter missions silently. Re-sync is explicit and shows the difference first.
   - Knowledge shared with a group is resolved at read time. The UI shows the resolved people before confirming.
4. **Missions** orchestrate existing engines (capture, Detective, Stress Test, Radar):
   - a template plus a structured brief, with an optional text, Markdown or PDF brief document;
   - requirements are derived from the brief;
   - the stage is **derived from records**, except for explicit states (draft, paused, cancelled, completed);
   - completion requires every requirement to be satisfied or not applicable, approved knowledge, and results for every receiver, **or** an explicit exception recorded by an authorized owner.
5. **Moti and the brief:**
   - The pre-capture summary is built deterministically from the brief, and the expert confirms it.
   - The brief is passed to question and gap prompts as fenced, untrusted *focus* data.
   - Requirement status comes from an AI comparison with verified quotes; "satisfied" is downgraded without a verified quote. People can override it, and their decision is labelled.
   - Approved acceptance criteria feed scenario generation.
6. **Notifications** are in-app only, with idempotent inserts (`ON CONFLICT DO NOTHING` on the dedupe key). Content is minimal, with no private mission detail before access. The deadline check runs on the existing scheduler.
7. **Capture.** A new `live:audio` source and explicit capture-method choice (audio, audio+video, screen+narration, text). Consent states the purpose, who can see it, AI processing and retention.
8. **Storage and AI:**
   - content-addressed reuse of identical blobs within a space, with a reference-counted delete;
   - a derived-artifact cache for Ask, keyed by question, language, model and the exact set of visible knowledge versions;
   - a storage and AI report by layer (A original, B evidence index, C approved, D derived);
   - an offline storage benchmark with a measured baseline against optimized runs.
9. **Landing:** two modes, the user's spaces and invitations, an honest video placeholder (`DEMO_VIDEO_URL`; not playable until set), and a dismissible first-run guide.
10. **Tests:** isolation and authorization for groups, missions, notifications and invitations; the three-domain mission flow (payments, weaving, ghee in Marathi); accessibility coverage of the new routes.
