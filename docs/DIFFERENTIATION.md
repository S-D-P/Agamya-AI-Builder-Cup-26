# What makes Agamya different

## The problem

When an experienced person leaves, what disappears is rarely the procedure. The procedure is written down. What disappears is the judgment around it: *the runbook says retry, but not at month-end when the upstream date is malformed*; *the recipe says twenty minutes, but you stop when the specks turn light golden, and with store-bought butter that takes longer*. That knowledge is tacit. People don't write it down because they don't notice they use it, and a recording doesn't capture it either, because a recording shows what was done, not why, and not when doing the same would be wrong.

The cost is concrete: repeated errors after handovers, months of shadowing, a few people whose absence stalls a process, and in families and crafts, skills that end with a generation.

## What exists today, and the gap

| Approach | What it keeps | What it misses |
|---|---|---|
| Documentation / SOP tools | The procedure as someone wrote it | Exceptions people don't think to write; why; when the procedure is wrong |
| Screen or video recording | What happened | Why; which signal mattered; when not to do it; no check that anyone learned |
| Meeting / call summarizers | What was said | What was *done*; no link between action and reasoning |
| RAG over documents | Retrieval of existing text | Knowledge that was never written; trust in what was retrieved |
| AI tutors | Teaching existing content | Where the content comes from; whether it is the expert's actual judgment |

## What Agamya does that these don't

1. **It looks for the decision, not the transcript.** Detection is a contract: an action, the alternative that was *not* taken, observed evidence that a choice was made, and whether it changed what was done. A deterministic gate then decides if the moment is worth the expert's time. Routine steps that match the documented procedure are not interrupted. (Measured: 0 false alarms on 3 routine control cases; 34/35 detection agreement over repeated runs, on synthetic cases.)
2. **It asks at the right moment, about the right thing.** One question at a natural pause, tied to the specific observation ("you turned off the heat at 12 minutes, though the card says 20; what did you notice?"), then a follow-up that targets the *boundary* ("…regardless of the timer?").
3. **It separates evidence from inference, field by field.** Every part of the knowledge is labeled observed (with event ids), expert-stated (with a verbatim quote that is machine-checked), AI-inferred, or insufficient evidence. Deterministic validators downgrade unsupported claims and record why. Model confidence is never treated as truth.
4. **It discovers boundaries, not just rules.** The artifact states when the rule applies, when it does not, what the normal way is, and what is still uncertain. A boundary counts as confirmed only if the expert's own words confirm it.
5. **It keeps the three sources apart.** Documented procedure, observed behavior and expert explanation are compared, never merged. A difference becomes a documentation gap the owner decides on (undocumented exception, outdated procedure, or possible error), not a silent override.
6. **It tests transfer with counterexamples.** Learners get a case they haven't seen *and* a nearby case where applying the expert's rule would be wrong. Passing the first but failing the second is **overgeneralization**, the failure mode that copying an expert produces and that quizzes don't detect. Correctness is checked against the approved answer, not by the model.
7. **It measures demonstrated understanding, not content consumed.** Per learner and per piece of knowledge: demonstrated in simulation, needs supervision, with gaps. It says plainly that this is not on-the-job proficiency.
8. **The contributor stays in control.** Recording, saving, sharing, publication and model training are separate permissions. Living knowledge is private by default; restricted knowledge can only go to named people; withdrawal removes it from lessons and deletes its evidence media.
9. **It is efficient by design.** It sends text instead of pixels when text exists, sends frames only on change, uses the lowest image resolution that works, transcribes audio once, and bounds every context. Measured: 72% fewer tokens than sending everything, with equal recall on the benchmark cases.

## Why Gemini is essential here, not decorative

Gemini does the work no rule can: reading a camera frame or screen, transcribing speech, proposing which moments were judgment, phrasing a question that refers to what it saw, structuring an explanation into a decision chain with quotes, proposing scenarios, coaching a learner, and evaluating reasoning. Around it, deterministic code does what must be reliable: gating, quote verification, evidence checks, grading, authorization. Without Gemini, the product degrades to a recorder with forms (the offline fallback shows exactly that).

## Why the two experiences share one engine

A payments analyst handing over month-end exceptions and a mother teaching her daughter to make ghee are the same problem: an action whose reasons live in someone's head, a written instruction that is incomplete, and a learner who must know when the rule does not apply. Agamya uses the same capture, evidence, judgment, boundary, compilation and transfer machinery for both. What changes is the governance default (workplace-shared vs private), the language (expert vs teacher, workflow vs skill) and the pace.
