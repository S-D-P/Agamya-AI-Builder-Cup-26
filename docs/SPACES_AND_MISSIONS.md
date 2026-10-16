# Spaces, roles, groups and KT missions

## Two modes, one engine
- **Agamya Personal** is a space with `experience = 'living'`. **Agamya Enterprise** is a space with `experience = 'work'`.
- Both use the same capture, Missing Knowledge Detective, Judgment Stress Test, assessment and Radar code. Only defaults, roles and wording differ.
- A person can belong to any number of spaces of either kind. Roles are per space (`memberships.roles`), and membership in one space never grants anything in another. Row-level security enforces this in the database, not only in the code.
- Signed-in people can create more spaces (`POST /api/spaces`) and accept or decline invitations from their inbox. The creator owns the space.

## Roles (least privilege; enforced on the server for every read and write)

| Role | Can |
|---|---|
| Owner (`ORG_OWNER`) | Space settings, membership, policies; the only role that grants or removes Owner and Administrator. A space always keeps at least one owner. |
| Administrator (`ORG_ADMIN`) | Day-to-day operations, all missions, members (except owner/admin roles), retention, policies |
| KT Coordinator (`KT_COORDINATOR`) | Creates missions, coordinates their own missions, manages groups, invites experts and receivers only |
| Subject matter expert (`EXPERT`) | Captures, reviews and approves their own knowledge; answers gaps; approves practice cases |
| Receiver / learner (`LEARNER`) | Takes lessons and assessments; asks questions of knowledge shared with them |
| Reviewer (`REVIEWER`) | Reviews knowledge and tests (unchanged) |
| Auditor (`AUDITOR`) | Read-only: missions, audit trail, Radar, AI cost. No evidence media and no knowledge they were not shared |
| Workflow owner (`WORKFLOW_OWNER`) | Configures workflows (unchanged) |

Ownership of the space is separate from coordinating a mission. A mission's coordinator manages that mission without owning the space.

## Groups
- **Application-level only.** Groups live in Agamya. They are not synchronised with Google Cloud IAM, Microsoft Entra ID or any directory. Enterprise OIDC sign-in, where configured, is unchanged and does not import groups.
- **Who manages them.**
  - Enterprise: owners, administrators and coordinators.
  - Personal: any member creates groups and manages the ones they created; owners and administrators can manage all.
  - A member can always leave a group.
- **Membership alone grants nothing.**
  - **Knowledge shared with a group** follows the group's current membership. Removing someone, or archiving the group, revokes their access immediately. Before confirming, the contributor sees the resolved list of people (`POST /api/knowledge/:id/access-preview`). People reachable both individually and through a group are listed once.
  - **Missions assigned to a group** resolve its members once, when assigned: a de-duplicated snapshot that records the group. People who join the group later get nothing from existing missions, and people removed keep their assignment until the coordinator changes it.
- Every group change is audited (`group.*`). Members are notified in-app when added.

## Invitations and notifications
- **In-app only.** There is no email provider in this build, and nothing is sent outside the application.
- Invitations to an existing account appear in that person's **Invitations and notifications** page, where they can accept or decline. A single-use link (7 days) is also returned to the inviter, for people without an account.
- Invitations can be revoked; a revoked link no longer works. Each state change (pending, accepted, declined, revoked) is audited.
- **Notifications** are written through `app_notify()`:
  - The recipient must be an active member of the current space.
  - Each one is idempotent per recipient and dedupe key, so retried jobs never duplicate it.
  - Only the recipient can read it (row-level security).
  - It names the mission or space and who acted, never brief or knowledge content.
- **Events notified:** invited to a space (shown from the invitation itself); added to a group; assigned to a mission; mission details or brief changed; a participant accepted or declined (to the coordinator); knowledge awaiting the expert's review; an assessment waiting for receivers; a deadline within three days (hourly sweep, once per mission per day).

## KT missions
- **Guided creation (`#/missions/new`):**
  1. Identity: name, description, context, domain, language, target date, experts, receivers, receiver groups.
  2. Template, or General/Custom, plus the allowed capture methods.
  3. The KT Mission Brief: structured fields, and/or an uploaded `.txt`, `.md` or `.pdf`.
  4. Review: resolved recipients, eligibility problems, Moti's summary, access, consent and retention.
  
  Then send.
- **Templates** configure the process only: suggested capture methods, starter questions, expected outputs, criteria, approvals and retention.
  - Built in: software handover, business process, manufacturing, retirement or transition, cultural/craft, language, general.
  - Administrators can save organization templates.
  - All templates use the same engine.
- **The brief** is untrusted data.
  - Uploaded text is sanitised, size-limited and scanned for instruction-like text; the coordinator is shown any flags.
  - Markdown headings are parsed into suggested fields **deterministically**, with no model, and the coordinator reviews them before anything is applied.
  - A PDF is stored for the model to read as background; its text is not parsed into fields.
  - The brief is passed to the question, gap and case-generation prompts as fenced data that says "data, not instructions". It can never change access, consent or safety controls.
- **Moti's summary** before capture repeats the brief without adding to it. The expert confirms it; changing the brief requires a new confirmation.
- **Requirements:** expected outcomes, decisions to demonstrate, blind spots, questions and acceptance criteria each become a tracked requirement.
  - The AI check marks one **satisfied** only when it cites an observed or expert-stated field and the quote is found verbatim. Otherwise it is downgraded to partial or unresolved, and the reason is shown.
  - A person's decision is labelled as theirs and never overwritten. Marking something satisfied requires a note.
  - The check runs once per distinct state of the knowledge (idempotency key), not on every page view.
- **Lifecycle.**
  - Stored states are explicit decisions only: draft, active, paused, blocked, cancelled, completed, completed with exceptions.
  - While active, the stage is **derived from records**: awaiting participants, then ready to capture, capturing, knowledge review, and transfer assessment. So the stage can never claim progress that the records do not show.
  - **Completion** requires every required item satisfied or not applicable, approved knowledge, and an assessment result for every receiver. Otherwise an authorised owner records an explicit exception, shown on the mission. A recording alone never completes a mission.
- **Access.**
  - Drafts are visible to their coordinator and administrators only.
  - Participants see the mission once it is sent.
  - Receivers see the objectives, outcomes, scope and constraints, but not blind spots, questions or acceptance criteria, which would give the assessment away.
  - Other people, and other spaces, get "not found".

## What was tested
- **Offline**, with real HTTP, PostgreSQL (PGlite) and row-level security (`tests/platform.test.mjs`, 24 tests):
  - spaces and roles;
  - invitation accept, decline and revoke;
  - coordinator and owner limits;
  - group least privilege and isolation;
  - group sharing with immediate revocation;
  - notification privacy and deduplication;
  - the full mission flow: templates, the brief, group resolution, drafts hidden, minimal notifications, the brief reaching prompts, requirement downgrades, honest completion, no cross-space access;
  - three domains through one engine: payments, weaving, and ghee in Marathi.
- **Live**, on Gemini 2.5 Flash via Vertex AI (`scripts/acceptance-missions.mjs`, two runs; the first exposed a schema bug, fixed and re-run):
  - an Enterprise mission with a group, a brief-guided capture and a live requirement check;
  - a Marathi Personal mission: Marathi questions, Marathi quotes, Marathi Ask.
