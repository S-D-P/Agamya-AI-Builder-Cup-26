# Security, privacy and access

## Who sees what

| Person | Sees |
|---|---|
| The expert who recorded it | their own sessions and Work Maps, drafts included |
| Space owner, admin, coordinator | everything in the space; can share any map |
| Everyone else in the space | confirmed maps shared with **everyone in the space**, **their group**, or **them**; other confirmed maps by title only, with **Request access** |
| People in other spaces | nothing (enforced by PostgreSQL Row-Level Security) |

- **Confirming is approving.** Only the expert confirms their map; then Agamya asks "Who should learn from this?".
- **Optional space passcode.** The owner can require it on top of each person's own password, once per sign-in. Changing it locks the space again for everyone else.
- **Removing someone** ends their access at once and takes them out of the space's groups.
- **Inboxes are per space.** Other spaces show only an unread count.

## Privacy

- **Consent:** the consent card says what is captured, who sees it and for how long, before anything starts.
- **Off the record:** nothing is sent or stored until the expert comes back. Terminate removes what a session captured.
- **Masking:** speech is masked before storage (emails, phone, card, IBAN and national-ID numbers). See [EVALUATION](EVALUATION.md).
- **Frames:** only changed frames are sent, at most one per second. Practice frames are never stored.
- **AI processing:** Gemini on Vertex AI. Content is not used to train models.
- **Retention:** recordings are kept 30 days for review; confirmed Work Maps until they are removed.

## Platform security

- **Sign-in:** HttpOnly session cookies, CSRF tokens, a same-origin WebSocket check, rate limits, and lockout after failed sign-ins.
- **Invitations:** a link never signs anyone in to an existing account without that account's password.
- **Agent keys:** scoped to one map, stored as a hash, revocable and rate-limited. Actions in the check log are masked.
- **Prompt injection:** what appears on screen, in documents or in speech is data, never instructions to the AI.
- **Secrets:** kept in Secret Manager. The runtime service account has only the permissions it needs, and the storage bucket is private.
- **Accessibility:** targets WCAG 2.2 AA. Automated axe checks run on every page, there is keyboard and screen-reader support, text alternatives to voice, and reduced-motion support.
