# Accessibility and responsive review

Reviewer: independent accessibility/responsive design expert. Initial review 2026-11-14. No application files edited.

## Evidence inspected

Viewed `artifacts/shadcn-capture-final/screenshots/mobile390-draft.png`, `mobile390-evaluation.png`, `native200-draft.png`, `native200-sdk.png`, and `desktop-draft.png`. Read `styles.css`, `shell.tsx`, `file-navigator.tsx`, and `ui/disclosure.tsx`. These are baseline screenshots, not proof that a new design works.

## Initial findings and remaining objections

1. **Zoomed task visibility is the material density problem.** In the 1280 × 657 native-200 draft capture, the viewport ends at the selected-file heading. No editable source is visible. The SDK capture similarly reaches the installation heading and opening paragraph only. This is a space-allocation issue: global topbar, bundle heading, tabs, workflow/status/actions, Files disclosure, then selected-file heading consume the draft viewport. Make the task start sooner by merging compatible rows and removing repeated labels/outer spacing. Do not solve it by reducing text or controls.
2. **Some task state is currently undersized.** `.draft-status p`, `.draft-workflow`, and `.workflow-steps` use 12px; selected-file paths use 12px. The saved/unsaved state and stage guidance determine which action is safe and are task information. The supplied constraint is at least 14px for task text. Keep decorative/secondary metadata small only where the user does not need it to complete the task. Diff task text currently uses 13px and should also be reviewed when touched.
3. **Narrow-width file navigation remains unverified.** The mobile draft screenshot shows the Files disclosure closed. Desktop file names/directories use single-line ellipsis. Preserve an accessible full path/name and a way to visually inspect it on touch; `title` alone is insufficient for touch/keyboard. A compact redesign must show opened navigation at 320 and 390px, including long paths and long workspace names. Do not claim passing from the closed disclosure screenshot.
4. **Focus and hidden state have valuable existing behavior.** Shell includes a skip link, named navigation, a focusable main, a modal sheet, and focus transfer after navigation. File disclosure uses `aria-expanded`, `aria-controls`, and `hidden`; shared disclosure uses Radix Collapsible and `display:none` for mounted closed content. Preserve these semantics and form state. A replacement layout needs keyboard testing because screenshots cannot verify them.
5. **Touch sizing is conditional in the baseline.** Coarse-pointer rules raise buttons, disclosure triggers, tabs, links, inputs, and selects to 44px, and touch editors/inputs to 16px. Keep these rules. Test a genuine coarse-pointer context, not only a narrow desktop viewport. A finer desktop pointer can use the existing 36px buttons, provided the user’s 44px touch requirement remains intact. On hybrid devices test `any-pointer:coarse` if the new design changes this policy.

## Safe compacting

- Reduce empty outer margins/panel padding and combine title/context, workflow/state, and local file identity where the resulting line wraps naturally.
- Keep the current file navigator as one real responsive disclosure, initially closed on constrained widths, with selected-file identity visible outside it.
- Collapse supplementary instructions, import/history/details, and alternate evaluation setup behind named buttons; retain their values when closed.
- Use a 14px task baseline and 16px touch editing; keep line height around 1.4–1.6 and usable text wrapping.
- Use normal document scrolling for narrow/zoomed layouts, with local scrolling only for genuinely wide code or bounded file lists.

## Harmful compacting

- Making save state, workflow steps, controls, or code smaller to create apparent density.
- Hiding the only save/evaluate/publish action or current unsaved/saved state behind a generic icon/menu.
- A fixed-height app frame or sticky stack that leaves only a few editor lines at 200% or traps scrolling on mobile.
- An icon-only rail as the sole mobile navigator, path ellipsis without an accessible and visible recovery route, horizontal page overflow, or `overflow:hidden` used to conceal a layout failure.
- Moving focus into collapsed content or allowing offscreen/collapsed controls into the tab sequence.

## Acceptance criteria for the real implementation

- At 320px and 390px, draft/evaluation/SDK and opened navigation have no page-level horizontal overflow; all stage/tab/action labels and focus indicators remain reachable.
- At 200% browser zoom, layouts reflow and core task content appears earlier than baseline; draft should expose editable text in the initial 1280 × 657 capture where feasible, with every action available by ordinary vertical scrolling.
- On touch: every actionable target is at least 44 × 44 CSS px; task text is at least 14px and editable fields at least 16px.
- Keyboard: skip link works; focus is visible; all disclosures work with Enter/Space; closed content is untabbable; navigation sheet traps focus, Escape dismisses it, and route navigation has a sensible destination focus; all local actions remain keyboard operable.
- Draft text and import form values survive open/close; resizing across the navigation breakpoint never leaves focus in invisible content.
- Check long names/paths, an unsaved draft, an evaluation without results, and populated results; preserve the distinction between evaluating a saved generation and current unsaved edits.

Status: **not approved yet**. Awaiting proposed concepts and real rendered implementation. A mockup cannot establish target sizes, focus behavior, or overflow correctness.

## Generated concepts review and debate

Viewed every actual image A–F with `view_image`, then read the prompts. Ranked **A > C > D > B > E > F** for this task, while borrowing D's Files disclosure as a constrained-width pattern rather than making it the desktop default.

- **A — preferred base.** Clear app/bundle/file levels and one integrated scope strip remove a redundant header. It preserves visible file selection and named task actions. Its actual editor edge is approximately y247 in a 1586px-wide image (~224 at 1440), substantially later than its promised y140. The generated image does not establish that the requested geometry was achieved.
- **C — credible alternate architecture.** Moves bundle context sideways and gives source width/height, but mixes two kinds of local navigation into one tall pane. At narrow widths it needs careful separation of bundle views from files and a considered focus destination; a single large hidden contextual drawer could make switching files harder.
- **D — useful narrow-width fallback.** A named Files control and selected identity preserve source width. Do not replace a discoverable desktop file pane solely to gain empty editor width. Opening the actual selector, long paths, and keyboard movement still need proof.
- **B — readable but keeps multiple wide header bands.** Removing the sidebar does not by itself address zoom height, and all app navigation cannot stay in a horizontal row on mobile.
- **E — optional wide-screen review only.** Saved-versus-browser labeling is valuable. A third permanent pane is harmful at narrow widths/zoom: stack the comparison or use a focused review surface with clear return instead.
- **F — not recommended.** Other files follow the expanded editor, increasing navigation distance and tab traversal; generated generic Markdown badges also lose the useful instruction/skill/memory distinction.

I challenged visual and hierarchy reviewers directly: A's one-row scope is a desktop opportunity, not a `nowrap` constraint. Long names, 14px state text, and 44px coarse-pointer controls must be allowed to wrap without page overflow. Global navigation may collapse into its existing sheet; local task context must remain discoverable. Preserve actual DOM/visual order and current keyboard/focus semantics.

The visual reviewer correctly challenged my initial reliance on natural wrapping: three actions can still recreate a tall mobile stack. I conditionally accept their explicit mobile composition: menu/parent return, title/channel, reachable local tabs, compact state with visible Save, then Files/selected identity. A named **More draft actions** menu can hold secondary Review and **Evaluate saved generation N**, provided saved-generation plus unsaved state remain visible before opening it, it has a 44px target and proper keyboard/focus behavior, and the workflow reviewer agrees with secondary-action discoverability. This is different from hiding core state and all task actions behind a generic icon.

Measure first source position at 320/390 and native 200% against baseline; do not use desktop y140 as an inflexible mobile rule. The real design must also remain usable after long identities wrap. **Concept preference is not implementation approval.**

Hierarchy reviewer agreed that A is one scope **region**, not necessarily one physical row, and rejected C as default after the tall mixed rail objection. I recommended wrapping identity instead of a mobile clamp requiring yet another recovery control.

Workflow reviewer added an accepted material condition to secondary actions: while dirty, visible **Save draft** is appropriate and evaluation of the older saved generation is secondary. Once clean/saved, **Continue to evaluation** must be visible as the next primary step; it must not remain hidden in More. Review can stay secondary. Preserve the dirty-navigation guard. On successful Save, announce the state change and avoid losing keyboard focus when the primary action changes (stable control or deliberate focus handling).

## Real implementation: capture 3 review

Viewed all eight desktop and all eight mobile routes in `artifacts/layout2-capture-3/screenshots/`: library, content, draft, evaluation, releases, SDK setup, connections, and members. Also viewed mobile draft actions, opened Files, Entry actions dialog, opened 390/320 navigation, 320 draft, and 320 long scope/path. Read their geometry JSON, updated FileNavigator, Shell, pending-change guard, and draft primary-action focus code.

**Visual assessment:** no new material visual accessibility objection in these captures. Desktop editor begins at y156 and is 1006px wide; 390px dirty editor begins at y333.39 instead of the baseline approximately y445. The 320px clean draft begins at y368.58, with Continue naturally wrapping. All capture-3 reports have document width equal to viewport width and report zero small targets/task-reading text. Touch captures use 44px controls and 16px editing. Long bundle title uses available width; full selected path wraps at 320 without an extra hover-only recovery step. Open navigation fits both 320 and 390, and its workspace select, close target, lower Account, and Refresh are available. Entry actions is a named scrollable dialog with a 44px close target. Evaluation and SDK retain readable task information while collapsing supplemental sections.

I do not object to the taller opened Files state: it is an intentional navigation interaction, not the resting editor layout. The menu-open screenshot is scrolled by 74px (reported), so it must not be used to claim the resting source begins at y259.

**Code assessment:** the pending-change guard now tries to map a menu item to the persistent menu trigger through `aria-labelledby`; it rejects disconnected/hidden/disabled return targets and otherwise falls back to main. This addresses the identified detached-menu-item focus defect in principle, but needs actual cancel/Escape/proceed checks. FileNavigator observes committed path selection (so a canceled dirty guard does not close it), moves focus to Files before hiding its contents, and handles collapsing across its breakpoint. The draft primary swap preserves user intent and includes a status announcement; actual Save completion must confirm it does not steal focus after the user moved elsewhere.

**Required final evidence before approval:**

- Valid native 200% captures and dimensions on the final code, with recorded window/document scroll and editor internal scroll. Do not approve a negative-top editor caused by autofocus or claim that scrolled capture as the resting layout. Check draft, evaluation, SDK, and navigation; source/actions must remain reachable at zoom.
- Dirty draft actions menu → Evaluate saved generation → Keep editing and Escape both return to the connected visible Draft actions trigger with edits intact. Proceed should reach the destination and its main focus.
- Save while focused → announced saved state and visible Continue to evaluation with sensible focus; Save while focus moved elsewhere must not steal it.
- Keyboard Files open/select/close; hidden contents leave the tab sequence; resize focused desktop rail across 899px without leaving focus hidden. Keyboard sheet Escape returns to opener; route navigation moves to main.
- A focused local tab at 320px. `.bundle-tabs` still uses horizontal overflow while custom focus outline has 3px offset and no vertical padding; inspect the rendered indicator for clipping. This is a verification concern, not a confirmed defect from unfocused screenshots.

Status: **visual capture 3 accepted; final accessibility approval pending zoom and behavior evidence.**

## Final verdict: capture 5

**Approved: no remaining material accessibility or responsive-design objection in the reviewed implementation.** This verdict is based on real rendered evidence and source inspection, not the generated concepts.

Reviewed `artifacts/layout2-capture-5/exit.json` (exit 0) and `screenshots/summary.json` (35 captured states, no failures/browser errors), the final geometry reports, and actual images for native 200% draft/SDK/evaluation, mobile focused tab, dirty draft, long scope, both opened navigation widths, selected evaluation evidence, and both publication-review dialogs. Earlier all-route review remains applicable; capture 5 includes all eight desktop, mobile, and native-zoom routes.

The native zoom evidence is now valid: browser zoom 2 gives a 640 × 328 CSS viewport, document width 640, window scroll 0, visual viewport offset 0, and draft editor internal scroll 0. Draft source begins at y243 CSS px with the first source lines visible, resolving the baseline's empty editor viewport. Mobile dirty draft begins at y333.39; desktop draft at y156. All final reports record no small reading text or targets and no page-width overflow. The 320px focused Content tab shows a continuous visible inset outline, resolving my earlier clipping concern. Long title and full path wrap, and navigation fits 320/390.

Read `scripts/testing/compact_console.py` assertions as well as its passing result: dirty saved-generation menu cancellation returns focus to Draft actions and preserves exact unsaved content; Escape from the menu returns focus; file selection collapses Files and focuses its trigger; Entry actions Escape returns focus; sheet Escape returns to Open navigation; sheet route selection closes and focuses main. The keyboard workflow selects/renames/edits, creates a saved draft, verifies stored payload, and asserts the visible Continue to evaluation link is focused after the remount. Collapsed forms preserve edits and leave the tab sequence. The script verifies that review interactions neither publish nor start an evaluation.

The current focus code deliberately handles both initial-save remount and existing-draft Save completion, rejects hidden/disconnected guard-return targets, and moves focus before a file rail becomes hidden. The additional edge runner (second save, dirty-proceed destination, resize across sheet/file breakpoints, intermediate widths and long channels) is useful regression coverage; I have no evidence-based design objection requiring another redesign while it runs. Reopen this approval if that runner discovers a failure. Full application-suite completion remains the integrator's verification task and is not represented here as already finished.

### Frozen-build confirmation

Approval still stands after final regression evidence. `layout2-capture-final-2` exits 0 with 35 passing states and no browser errors; `layout2-edges-final/summary.json` passes 27 states across long identities, responsive focus, and mobile workflow. This covers six widths (1024/900/768/600/390/320), long channel/path/title, sheet Escape and resize focus, file-rail resize focus, two-file edit preservation, first and second save focus, Keep editing/Escape return, and exact saved-candidate proceed to main without publishing or requesting evaluation.

Inspected `layout2-edges-final/long-1024-content.png` and its JSON: long scope and full selected path reflow, document width is exactly 1024, pointer is coarse, small target/reading lists are empty, and the Acclimate brand link now measures **155 × 44px**. The added coarse-pointer brand minimum fixes the discovered 28px target. No new material objection or further design request.
