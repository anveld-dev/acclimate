# Accessibility and responsive review: round 3

Reviewer: independent accessibility and responsive UX reviewer. Initial inspection 2026-11-14. Scope: review/setup discovery and density; no application edits.

## Baseline evidence

Viewed the actual `mobile390-evaluation`, `mobile390-sdk`, `native200-evaluation`, `native200-sdk`, `desktop-evaluation`, and `desktop-sdk` screenshots in `artifacts/layout2-capture-final-2/screenshots/`. Read mobile geometry reports, the prior final accessibility review, `sdk-setup.tsx`, and the evaluation setup/review sections in `improvement-workspace.tsx`.

The existing editor is an accepted baseline, with source at y156 on desktop and y333 on mobile. Preserve its progress. Current mobile setup/review reports show 14px task text, 16px inputs, 44px coarse-pointer targets, and no page overflow. No new baseline accessibility failure is established by these screenshots. The 196 passing BDD checks and focus regressions are existing evidence, not proof of any forthcoming changes.

## Material opportunities and constraints

1. **Initial task discovery at zoom.** At native 200%, SDK setup shows app ownership, language, Install SDK, installation prose, and a closed installation disclosure; the viewport ends there. Evaluation reaches only its Results heading after saved identity, ownership guidance, and two details disclosures. Reduce repeated vertical framing and put the next usable setup operation or current result/request sooner. Do not shrink text or targets to do this.
2. **Setup is a reference surface as well as a first-use flow.** Keep Install, access configuration, and delivery recipe independently reachable. A forced stepper, automatic close-on-open accordion, or mandatory success gate would make comparison/copy work and returning setup slower. Numbered headings are useful; steps must not imply verified success the app cannot observe.
3. **Evaluation state needs a visible identity and next action.** The completed request row has a useful named Inspect evidence link. Preserve its distinction from creating a new request and from publishing. With no request, expose the setup affordance; with a request, expose current app-reported state and the evidence action sooner. A decorative success badge cannot replace the reported-state language.
4. **Language choice has radio semantics.** Retain the named Recipe language group, one selection, keyboard selection, and stable focus while recipe text changes. A compact segmented appearance must not turn the choice into navigation or lose its checked state.
5. **Preserve actual hidden-state and focus behavior.** Named independent disclosures can safely reduce detail. Closed content must be untabbable; values and selected language must survive close/open; changing a section's order must not silently move focus, discard forms, or break hash navigation to local install/reporting.
6. **Full context remains recoverable on touch.** Long channel, bundle, evaluator configuration, and full file paths must wrap or have a direct visible recovery surface. Hover-only titles and truncated identities do not meet this requirement. Local code overflow is acceptable; page overflow is not.
7. **Private configuration and execution boundaries must remain clear at action time.** Setup keeps credentials in the application's private environment. Evaluation creates a request that the app runs. Do not replace these with a generic Run button or an upload/paste flow for secrets. Place concise boundary text next to the relevant operation; optional implementation detail may collapse.

## Optional refinements

- On desktop, use available width for compatible identity/action rows or a secondary reference column; reading/keyboard order must still make sense when stacked.
- Replace repeated section framing with compact headings and separators while retaining meaningful section names.
- Shorten introductory prose where the adjacent action already conveys the task. Reducing empty space alone will produce a smaller benefit than revealing an actionable task.
- Recipe and environment details can remain collapsed by default if their trigger names make the content obvious and copying is still understandable before activation.

## Acceptance criteria for implementation

- Compare unscrolled resting states at desktop, 390px coarse pointer, 320px coarse pointer, and genuine native 200% zoom. Record viewport/document width and scroll offsets. Show the next operation/result earlier without regressing accepted draft geometry.
- No page-level horizontal overflow, clipped focus indicators, inaccessible action labels, or nested page scroll traps. Long scope and full path must be tested, not inferred from short fixtures.
- Task text stays at least 14px; touch editing at least 16px; all coarse-pointer action targets at least 44 by 44 CSS pixels. Preserve ordinary document scrolling and readable wrapping.
- Keyboard: named group and radio selection; named disclosure Enter/Space; hidden content absent from Tab order; visible focus; collapse/resize return to a connected visible control; navigation sheet and dialogs retain Escape/focus return.
- Setup: both languages, local install hash, reporting hash, independent details open together, copy controls, non-admin credential guidance, and 200% open code/environment surfaces remain operable.
- Evaluation: no request, app-reported pending/completed/interrupted state, selected evidence, invalid/mismatched evidence, and first/another request forms preserve clear request-versus-execution-versus-release boundaries and user input.
- Existing dirty-navigation guards, first/second-save focus, unsaved content preservation, full path recovery, and release review safeguards remain intact.

Status: **awaiting six generated concepts, peer debate, and rendered implementation evidence.** Concept preference alone cannot establish implementation approval.

## Initial peer debate

- Workflow reviewer favors state-aware next-action guidance, first-request form open when there are no requests, reported result/Inspect evidence before another-request setup, and environment prerequisite summary before Copy recipe. I agree. I asked that the actual result/action enter view earlier at zoom, rather than merely moving its heading, while keeping Review file changes directly discoverable.
- Visual reviewer agrees on truthful result/action before quieter utility metadata and real numbered SDK steps without completion badges. A desktop action column is conditional on a demonstrated benefit; it is not needed to make the responsive layout work.
- Information reviewer cautions that below-fold content is not itself an accessibility failure. I agree: native-200 geometry supplies comparative evidence for the user's density goal, not an arbitrary fold pass/fail rule. Necessary evaluator purpose/prerequisites before Create outrank a y-coordinate target. The next action must remain understandable.

## Six generated images: independent review

Viewed every actual image `images/a.png` through `images/f.png`, then checked the prompts. Generated desktop geometry and apparent font sizes are not implementation evidence.

**Review ranking: A > C > B.**

- **A, next decision first:** best structure. The reported request and named Inspect evidence action precede quiet Review file changes/Saved snapshot details controls. The utility region remains discoverable. Reject its green check icon: a report of completed execution does not establish complete/bound evidence or release quality. Reject the visible required-reason input outside the collapsed manual-release form; preserve the real review form and safeguards.
- **B, request and details:** weakest for this task. It duplicates candidate/parent identity in a large summary and detail pane, and actual Inspect evidence sits around y700 in the generated image. At zoom, the list/detail split would either squeeze the task or stack repeated context before the action. More requests might eventually justify master/detail, but the single-record current case does not.
- **C, three task lanes:** readable categories but more framing and equal-weight surfaces than needed. Its Saved change lane naturally precedes Evaluation in a narrow stack, restoring the delay the change aims to remove. Do not use CSS visual reordering to show evaluation first while keyboard order stays saved-first. A linear document gives one consistent reading order.

**Setup ranking: F > E > D, with F conditional on narrow rendering.**

- **F, one useful document:** preferred base. Install command, private configuration, and delivery check form a coherent order; long source is an independent disclosure. The generated five-row environment table is useful at desktop but may reflow into a tall wall before Copy recipe at 390px/200%. Keep a concise private prerequisite summary visible and allow the detailed definition list to remain independently expandable if the real narrow evidence shows the full table worsens task discovery. A real table needs correct header associations; a responsive definition list is also appropriate.
- **E, compact step columns:** numbered documentation order is useful without a gate, but equal column cards force long line wrapping and stack into a long document on mobile. Its source scrollbox appears cramped and its scope-as-directory description is wrong. Do not copy those details.
- **D, recipe and prerequisites:** long source dominates, while installation/private prerequisites sit to its right and run instructions below it. Stacking source first delays prerequisite discovery; placing prerequisites first recreates a long header before source. The narrow reference rail and source-heavy default are unnecessary for this task.

Asked visual, information, and workflow reviewers to resolve F's narrow composition explicitly and challenged A's checkmark. These are substantive implementation conditions, not reasons to redesign the accepted shell/editor or require another generated-image round.

Workflow and information reviewers agreed: F should supply a concise visible summary of the five required names with accurate brief meanings; exact definitions, actual URL/copy, and strict directory constraints remain available in an independent disclosure. Preserve install → access → check DOM/reading order. Do not call `ACCLIMATE_SCOPE` a directory. Full default-open table is not necessary to keep prerequisites before copying. Workflow also confirms Inspect evidence is primary only when a comparison actually exists, and the manual reason remains inside the actual release form. These conditions resolve my conceptual objections to an A/F implementation.

Visual reviewer independently agreed with A > C > B and F > E > D after seeing all six images. Their explicit narrow composition preserves three real numbered sections, supplied-package command and replaceable-path note, concise five-variable summary, independent exact definitions, then runnable command/Copy/truthful expected output. They reject the green completion check and literal detailed five-row default-open narrow table. This resolves the requested mobile-composition debate.

Status: **A/F direction accepted subject to the stated conditions; implementation approval pending real code and captures.**

## Real implementation: capture 1 review

Viewed actual desktop/390px/native200 resting review and setup images; phone first-request/custom/requested states; desktop running handoff; selected evidence and release-review surfaces remain part of the reused capture suite. Read changed SDK code, review/request source, and `sdk_acceptance`/`evaluation_acceptance` assertions. All 56 geometry reports present at inspection had no page-width overflow, small task-reading text, or small-target failures. Full suite completion was still pending at that moment.

The SDK uses the agreed document order, shows a real supplied-package command with replaceable-path instruction and Copy, preserves the named language group/hash targets, and supplies accurate brief meanings for all five required variables before the delivery check. Scope is correctly an identity, not a directory. The exact URL/copy/private-directory restrictions remain independently disclosed. At native200, the install command now enters the first viewport where the baseline ended on the closed install disclosure. The longer overall document is a justified cost of useful visible prerequisites, not a new accessibility failure. The `sdk-required-environment` capture shows the visible summary scrolled into view; it is not evidence that the exact-definition disclosure is open.

Evaluation prerequisites now precede Create, with a direct `aria-describedby` association. The no-request form is open, another-request form closes after explicit creation, configuration edits survive collapse, and the script verifies that changing profiles/disclosures does not submit. Requested handoff offers Copy request ID/Copy configuration, while running wording reflects last reported state. No green success check or false verified-success treatment was introduced.

Capture 1 initially retained both review-detail controls before Results, so native200 still showed only the Results heading. I explicitly reported that this did not achieve A's earlier-action opportunity, while distinguishing it from an accessibility blocker: ordinary vertical scrolling still reached everything. The integrator proposed moving named file-review/snapshot controls after existing request results, before the quieter utilities, leaving first-request flow and blocking warnings in place. I accept that conditional DOM-order change; it addresses the useful density goal without hiding review or inventing a gate. Final rendering of that change remains to be reviewed.

## Final verdict: authoritative capture 3

**Approved: no remaining material accessibility or responsive UX objection in the reviewed implementation.** Approval is based on the rendered implementation, source, and passing behavior assertions, not the concept images.

Inspected `artifacts/layout3-capture-3/exit.json` (exit 0), `screenshots/summary.json` (58 passing captured states, no failures/browser errors), and every geometry report. They report no page overflow, undersized task-reading text, or undersized coarse-pointer targets. Viewed the final native200 and mobile result/action, requested/running handoff, first-request form, SDK install/output, 320px focused tab, and long-scope/full-path images. Earlier unchanged-surface review remains applicable.

The existing-request DOM order now puts reported results before the two named saved-change detail disclosures, followed by request/lookup/release utilities. Native200's genuine 640 × 328 CSS viewport now visibly contains both reported request and Inspect evidence at window scroll 0; the action previously lay below the viewport. At 390px the action is visibly earlier, around y405. Warnings remain in summary and first-request review/setup ordering stays coherent. Running handoff no longer repeats an instruction to start the evaluator. No quality/checkmark claim was added.

The preserved editor still begins at y156 desktop, y333.39 on the 390px phone, and y243 at native200; editor/window scroll are zero in those reports. The focused 320px tab has a visible continuous outline; long full paths wrap without hover recovery. Task text remains 14px and coarse-pointer controls 44px; fine-pointer desktop controls retain their existing 36px policy.

I raised a concrete keyboard concern: creating the first request closes/remounts its form and could strand focus on body. The integrator reproduced that failure and fixed it. Reviewed the ownership guard: focus/pointer movement away cancels the claim; after the response/busy state settles, only the initiating control/body claim transfers focus to the connected new request trigger. The final script uses real Tab → Enter activation, then asserts the new trigger focused, and reports `createFocusHandoff: true`. It performs no direct focus call to manufacture that result. Existing keyboard file/action/save/navigation and collapsed-form preservation checks also pass. Custom profile/disclosure changes produce zero writes; exactly one explicit request creation is verified and the published release remains unchanged.

SDK language choice, independent disclosure semantics, private credential boundaries, install/reporting hash handling, exact recipes, and full directory requirements remain intact in source. Its visible package instruction, five-name prerequisite summary, and expected output improve discovery while allowing ordinary scrolling. No further change is required for accessibility approval. The complete 196-scenario BDD run is still the integrator's final verification responsibility and is not represented here as already complete.
