# Accessibility

**Target:** WCAG 2.2 Level AA on every route.
**Status:** automated and manual checks pass on the routes listed below. This is **not** a claim of verified conformance or legal compliance. No audit by an accessibility specialist and no testing with users of assistive technology has been done. Those are the next steps before any compliance statement.

## What was checked, and how

| Method | Scope | Result |
|---|---|---|
| `tests/a11y.test.mjs`: axe-core 4.10.2 in jsdom | Real client against the real server. Rendered for 4 personas: signed out, expert, manager, learner (Work sample) and teacher (Living sample). Expert pages in both English and Marathi. 21 route renders: landing, sign-in, session review, knowledge with gaps, capture setup, home, Radar, transfers, workflows, knowledge, progress, insights, administration, lessons, attempt (deciding and complete), and the Living home, journey, capture, knowledge, sharing and people pages. Tags: wcag2a/aa, wcag21a/aa, wcag22aa, best-practice | 0 violations |
| Palette contrast test (same file) | Every text token against every surface and tint it is used on; white on every filled control | All at least 4.5:1 |
| Reflow guard (same file) | No `1fr` single-column grid; no fixed-minimum auto-fill grid; no `overflow-x: hidden` on the page | Enforced |
| axe-core in a real Chromium page at 1280×900 | Knowledge with gaps, lessons, capture, workflows and home, in English and with the Marathi interface | 0 violations; 220+ nodes contrast-checked on the knowledge page. "Incomplete" items were reviewed by hand (below) |
| Manual: reflow at 320 px | Knowledge, workflows, lessons, insights, transfers, capture, home, session | No horizontal scrolling after the fixes below |
| Manual: keyboard | Skip link, Tab order, the evidence dialog, gap answer flow | See below |

### Manual review of axe "incomplete" items
axe could not compute the background behind the judgment-chain pins and the striped "Insufficient evidence" badge, because of gradients and pseudo-elements. These were checked by hand from computed values:
- Insufficient-evidence badge: `#616a64` on `#f4f1ea` or white stripes; the worst case is 4.96:1.
- Pins: white on sage is 5.9:1, white on sky is 6.75:1, coral-ink on white is 5.76:1.

## Issues found and fixed in this round

| WCAG | Issue | Fix |
|---|---|---|
| 1.4.3 | `--faint` text was 2.4–2.7:1. White on coral buttons and steps was 3.18:1. Sage-2 links on cream were 4.06:1. `--muted` on tints was 4.38–4.45:1 | `--faint` and `--muted` are now `#616a64`. A new `--coral-strong` (`#b5573e`, 4.78:1) is used only where white text sits on coral, and coral stays for decoration. Links use `--sage` |
| 1.4.10 | At 320 px the app shell was 361 px wide, because `1fr` has an automatic minimum. `overflow-x: hidden` then **clipped** that content instead of reflowing it | `minmax(0, 1fr)` everywhere; auto-fill grids use `minmax(min(Npx, 100%), 1fr)`; clipping removed |
| 2.4.1 | The skip link set the hash to `#main`, which the hash router treated as a route, so it navigated away | The skip link now moves focus to `<main>` without changing the route |
| 2.4.7 | The skip link was never visible on focus | Visible high-contrast pill on focus |
| 2.4.7 / 2.4.11 | Focus ring was 70%-coral, which is weak on tinted surfaces | 3 px ink outline plus a white halo on every focusable element |
| 2.1.1 | Session timeline moments opened only on mouse click | Each moment id (e1, e2, …) in the text list is a button that opens the same evidence window |
| 2.4.3 | After closing the evidence dialog, focus was lost because the opener had been re-rendered | Focus returns to the same control, found by its data attributes after re-render |
| 4.1.2 | Insights and administration "tabs" used `role="tab"` with `aria-pressed` and no tab keyboard model | A labelled group of toggle buttons (`aria-pressed`) |
| 4.1.2 | Workflow cards were `<button aria-label>`, which hid the description and counts from screen readers | Card with an `h2` that contains a real button; the rest is readable text |
| 1.3.1 | Knowledge list used `button role="listitem"` | `<ul><li><button>` |
| 1.3.1 | Skipped heading levels (lessons, journey) | Corrected levels |
| 1.3.1 / 4.1.2 | Some textareas and selects had no programmatic label | Every field has a `<label for>`. Gap answers are also described by their own question |
| 3.1.2 | Marathi text was not marked as Marathi | Gap questions, answers, proposals, knowledge values, quotes, lessons and Ask answers carry `lang="mr"`. Translated interface strings carry their own `lang="mr"`. The page stays `lang="en"` while Marathi interface coverage is partial |
| 4.1.3 | No status announcements | A persistent polite live region (`#announcer`) announces: answer sent, transcript ready, change approved (with version), decision outcome, language changed |
| 1.4.1 | Status shown by colour | Every status tag (gaps, cases, Radar, outcomes, learner result marks) has words and an icon |

## Multimodal alternatives
- **Voice ↔ text:** every voice input (capture answer, gap answer, learner reasoning, Ask) has a typed equivalent. Spoken input always becomes an **editable draft** before it counts.
- **Speech out:** "Speak questions" is optional and off-switchable. Every spoken question is also shown as text.
- **Camera and visuals:** simulated scenes and scenario pictures have their facts listed as text next to them. Evidence frames have alternative text, and the extracted text is always shown.
- **Reduced motion:** `prefers-reduced-motion` disables animation and transitions.

## Round 2: spaces, missions, groups, inbox, storage, landing
- **Automated** (`tests/a11y.test.mjs`, now 27 tests). axe-core runs on:
  - the new landing, with both modes and the video placeholder;
  - sign-up, spaces, inbox, groups (list and detail), storage and invitations admin;
  - **each step of the mission wizard, driven through the real UI** (including the inline error on a missing name);
  - the mission overview as coordinator and as expert.

  New static checks: no `aria-label` on a role-less div or span; reflow guards.
- **Real browser (Chromium)**, axe with rendered contrast at 1280×900: session/consent, mission overview, missions, groups, spaces, inbox and home. 0 violations; 25–127 text nodes contrast-checked per page.
- **Manual keyboard walkthrough** of the complete mission flow, by real key presses:
  - accepting policies;
  - the wizard (Tab order, Space on checkboxes, arrow keys on template radios, Enter on buttons);
  - sending;
  - as the expert: opening the notification, accepting, confirming the brief, choosing the capture method with arrow keys, and reaching the consent screen.

  Every step was operable and announced (`Step 2 of 4: template.`, `Invitations sent to 4 people.`, `Brief confirmed…`).
- **Reflow at 320 px:** mission overview, missions, wizard, groups, spaces, inbox, home, session, storage and admin. No page-level horizontal scroll. Wide data tables scroll inside labelled, focusable regions (`role="region"`, `tabindex="0"`), as WCAG 1.4.10 allows for data tables.

### Found and fixed in round 2

| WCAG | Issue | Fix |
|---|---|---|
| 2.4.3 / 3.3.1 | A background re-render (inbox refresh) reset form state and dropped focus to the top of the page while a person was ticking checkboxes in the wizard | Wizard state is updated on every input. `render()` now restores focus by data attributes when a control has no id. Stable ids on checkboxes and radios |
| 1.4.10 | Mission tables widened the page to 383 px at a 320 px viewport | Scroll regions with an accessible name, focusable by keyboard |
| 4.1.2 | `aria-label` on role-less divs (capture indicators, lesson stepper, simulated viewport) | Proper roles (group, img); regression test added |
| 1.3.1 | Duplicate landmark names (a section and its table region) | Distinct names |
| 2.4.3 | Wizard steps moved focus to the first button | Focus moves to the step's heading; the step change is announced |

## Known limitations (not yet fixed or verified)
- **No screen-reader pass.** No testing with NVDA, JAWS, VoiceOver or TalkBack, and no testing with disabled users.
- **Zoom:** checked only through 320 px reflow. 200% zoom and text-spacing overrides (1.4.12) were not checked separately.
- **Keyboard:** every interactive element was confirmed to be a native, focusable control, and the skip link and dialog were tested with real key presses. A full keyboard-only walkthrough of every flow (live screen capture and the transfer planner) has not been done.
- **Timing (2.2.1):** status polling is passive, and toasts disappear after 5 s, but their content is also announced through the live region.
- **Rendered visuals:** simulated camera frames and scenario visuals are pictures with text alternatives. A blind learner gets the facts list, not the visual cue. For skills where the cue *is* visual (the colour of the specks), the text description is the accommodation, and its adequacy has not been tested with users.
- **Marathi interface:** partial; strings fall back to English, and translations still need native-speaker review.
- **Contrast:** checked for text tokens and the main pages. Charts and coloured meter bars rely on adjacent numbers, not colour, but were not separately audited for 1.4.11 (non-text contrast).

## Running the checks
```bash
node --test tests/a11y.test.mjs
```
Browser check (manual): open any page, load `node_modules/axe-core/axe.min.js` into it, and run `axe.run()`.
