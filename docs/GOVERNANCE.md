# Knowledge governance

The person who contributes knowledge keeps meaningful control over it. Agamya treats each of the following as a **separate** permission, enforced by the server (not by hiding buttons) and tested.

| Permission | How it works | Default | Where enforced |
|---|---|---|---|
| **Recording and analysis** | Asked when each capture session starts, per input (camera, screen, microphone), under a versioned Recording & Consent Policy. Only the person being captured can consent. Pause, exclude an input, or delete any moment at any time | Nothing recorded without consent | `capture.grantConsent`, upload checks (`uploadMedia`) |
| **Saving as knowledge** | Nothing becomes knowledge until the contributor approves. They can correct any field first (a new version is created; the earlier one is kept) or reject | Not saved | `knowledge.validate` (contributor only) |
| **Sharing** | Per piece of knowledge: **only the contributor**, **named people**, or **everyone in the space** | Living spaces: **private**. Workplaces: everyone who learns the workflow, which is disclosed to the expert before capture in the transfer plan | `visibleSql` predicate used by every read path: lists, detail, lessons, attempts, scenario visuals, AI retrieval and cross-expert checks |
| **Restriction** | Marks knowledge as sensitive. Restricted knowledge can only be shared with named people, and learners see the contributor's note | Off | Database constraint `knowledge_restricted_scope` + API validation |
| **Public publication** | **Not offered.** Agamya has no public pages; there is no code path that publishes knowledge | — | Absent by design |
| **Use for AI model training** | **Not offered.** Knowledge is sent to Gemini on Vertex AI only to process the contributor's own sessions and the lessons they shared | — | Absent by design |

## Other controls

- **Attribution:** each artifact records its contributor and an attribution line they can edit (for example, "as her mother taught her").
- **Craft context:** materials, tools, conditions, sensory signals, timing and local terms are written by the teacher, in their own words. Agamya does not invent them. (In the sample space a scripted suggestion is offered and labeled.)
- **Withdrawal:** the contributor can withdraw knowledge. It leaves everyone's lessons, AI retrieval and other people's views; its embedding is cleared; its evidence media is deleted from storage; the act is audited. The text history remains in the database for audit; erasing it entirely is an operator procedure ([DATA_LIFECYCLE](DATA_LIFECYCLE.md)).
- **Private knowledge never becomes someone else's AI context.** When Agamya looks for related knowledge during another person's session, it only considers knowledge shared with the whole space, or the person's own.
- **Everything is audited:** consent, approval, sharing changes (from → to), withdrawals, policy acceptances.

## In a workplace

Knowledge captured during a planned transfer is, by default, shared with people who learn that workflow. The expert is told this before capture starts ("Who sees the result"), along with what is captured, why, retention, and their controls. They can still choose "keep it private for now" at approval, and change it later.

## Missing knowledge and tests (no automatic promotion)
- A gap found by AI is labelled **AI-inferred**. A gap found by rule says which field lacks evidence. Both are suggestions.
- Only the **contributor** can answer a gap or approve a change. The AI drafts the change from the answer, its quote is checked verbatim by code, and the knowledge changes only on approval. The change becomes a new judgment version, and a new knowledge version if the knowledge is already approved.
- Each decision is audited (`knowledge.gap_*`; no answer text in the audit log). The contributor can leave a gap unresolved, defer it or mark it not applicable. Those are recorded, never filled in by AI.
- Generated stress-test cases are **drafts**. Learners never see them, and are never assessed against them, until the contributor approves the case, the expected answer and the criteria. In a workplace, a reviewer can also do this.
- Learner outcomes are only "demonstrated in simulation", "needs further practice" or "requires supervision", never certification.
- **Ask** answers only from approved knowledge the asker may see (`visibleSql`, reviewer access off). Citations are verified against that text, and an answer whose citations fail is withheld.

## Spaces, groups and missions
- Personal spaces are private by default. In Enterprise spaces, approved knowledge follows the workplace default, which is disclosed before capture.
- Knowledge can be shared with people and with groups. Group sharing follows current membership. The contributor sees exactly who will have access before confirming, and removing someone from the group, or archiving it, revokes their access at once.
- Missions resolve group members once, when assigned. Joining a group later grants nothing on existing missions.
- A mission brief guides questions and checks. It cannot grant access, override consent, or relax safety constraints, and the model is told it is data, not instructions. Brief-driven requirements are satisfied by AI only with a verified quote from observed or expert-stated knowledge.
- Receivers do not see a mission's blind spots, questions or acceptance criteria, so assessments stay fair.
- Details: [SPACES_AND_MISSIONS](SPACES_AND_MISSIONS.md).

## What the software does not decide

Agamya provides controls; it does not decide what is culturally appropriate to record or share, and it does not make a deployment legally compliant. The shipped policy texts are templates marked "not legal advice". Communities should define their own rules about who may record, what is sensitive, and who may learn, and use these controls to apply them.

## Tests

`tests/governance.test.mjs` (offline) proves: approval in a living space saves privately; private knowledge is invisible to the learner in lessons, lists and detail, and is not used as AI context for others; only the contributor can change sharing; restricted knowledge cannot be shared with the whole space; another visitor's space cannot see or enter this one; the shared demo sign-in cannot enter a sample space; withdrawal removes lessons and deletes evidence media. The live acceptance run repeats the private → shared → learn → withdraw sequence against Gemini.
