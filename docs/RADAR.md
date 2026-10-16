# Knowledge Loss Radar

A manager view (`#/radar`; `GET /api/radar`, needs `analytics.read`: org admin, workflow owner or reviewer). For each workflow it answers three questions: **what is at risk**, **which records say so**, and **what to do next**.

There is **no score, ranking, probability or financial estimate**. Each status comes from explicit rules over records in the workspace. When there are not enough records, the status says so.

## Status rules (in order)

| Status | Rule |
|---|---|
| **Insufficient evidence** | No judgment has been captured for the workflow (no sessions, or sessions that found no judgment). |
| **Needs attention** | Judgments exist but none is approved yet; or approved knowledge has open gaps, unreviewed tests, missing rationale, learners who need supervision, or no learner who has practised it. |
| **At risk** | Approved knowledge is held by only one person and nobody else has demonstrated it in simulation; or some approved knowledge lacks an expert-stated exception, or its boundary is not confirmed. |
| **Covered** | None of the above. |

## Findings (each lists its records and one next action)

| Finding | Records | Next action |
|---|---|---|
| `awaiting_approval` | Judgments with status `observed` | Ask the expert to review and approve |
| `rationale_missing` | Approved knowledge whose reason is neither expert-stated nor observed | Ask why: fill the missing rationale |
| `exception_missing` | Approved knowledge whose exception is not expert-stated, or whose boundary is not confirmed | Capture when the rule stops applying |
| `open_gaps` | Open, answered or deferred knowledge gaps | Answer the follow-up questions |
| `accepted_unresolved` | Gaps the expert accepted as unresolved (known unknowns) | Keep supervision in place for these points |
| `tests_unreviewed` | Generated stress-test cases still in draft | Review and approve the tests |
| `needs_supervision` | Learners whose simulation result is "requires supervision" | Coach and re-assess these concepts |
| `not_assessed` | Approved knowledge no learner has practised | Ask a learner to take the test |
| `single_holder` | All approved knowledge is held by one person, and nobody else has demonstrated it | Plan a knowledge transfer |

## Privacy
The Radar uses the same visibility rule as everything else (`visibleSql`). Knowledge the viewer may not see is counted, but shown only as "Private knowledge (not shared with you)". Its title and gap text are never shown. Counts of private items appear in the facts ("2 private").

## Sample data
In sample spaces the page shows a **Sample data** notice. The records come from scripted workflows, not from a real team.

## What it is not
- It does not predict departures, incidents or losses.
- It does not rank employees. Learner records appear only as "needs supervision", with the concept they missed, so that coaching can be planned.
- "Covered" means the rules found nothing to flag in the records. It does not mean the knowledge is complete.
