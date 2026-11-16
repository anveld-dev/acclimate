# Hierarchy and navigation review

Reviewer: independent information architecture / navigation. Evidence: baseline `artifacts/shadcn-capture-final/screenshots/{desktop-draft,desktop-library,desktop-evaluation,mobile390-draft}.png`; `shell.tsx`, `routes/w.$.tsx`, and `styles.css`.

## Findings

- Draft desktop stacks global back bar, bundle identity/channel, section navigation/back link, workflow/actions, then file identity. Editing begins around y=253; mobile begins around y=444. The repeated scope presentation costs more than oversized typography does.
- `Bundles` appears as sidebar destination, topbar title, and page heading on the library. Keep the page heading; the topbar copy adds no information. The single card also spends 87 px on a name, description, channel, and arrow.
- Desktop retains a full 196 px global sidebar with only three destinations while adding a second 236 px file sidebar. Those are legitimate scopes, but the global rail dominates a detail task despite being used less frequently.
- Draft action competition: `Review changes`, `Save draft`, and `Evaluate saved generation 1` have similar visual size. The page correctly distinguishes saved generation from unsaved edits, but that distinction needs to sit beside the relevant action instead of being decoded from a sentence.
- Evaluation has a second copy of workflow numbering in section titles, many equal-weight disclosure rows, and request-creation instructions before the completed result. `Inspect evidence` is the meaningful next action in the shown state; it needs to lead.
- `Back to changes` repeats the hierarchy already conveyed by the selected Changes section; on desktop it is stranded at the opposite end of the tab row. Mobile improves the back label but still stacks all other layers.
- The product boundary is sound in evaluation copy: an app runs evaluation and returns evidence. Compacting must preserve that boundary. A layout must not introduce a console-owned Run/Evaluate control or imply that an external reported completion means passing evidence.

## Acceptance criteria

1. A bundle detail view has one bundle identity, one channel selector, one section-navigation group, and one visible return to the immediate parent. No duplicated topbar page title or repeated back links.
2. At 1440×900, source begins at or above y=225; at 390×844, source begins at or above y=360 with the file navigator collapsed. Preserve readable source and 44 px coarse-pointer controls; do not meet the target by shrinking text/targets.
3. Bundle/channel stay visible during a task without repeating the same scope in every panel. Long bundle names and channels truncate or wrap without pushing section navigation off-screen.
4. Draft state makes both facts explicit: whether the editor has unsaved changes, and which saved generation is selected for evaluation. Save is the primary action when dirty; evaluation of an older saved generation cannot look like evaluation of current editor text.
5. In the completed-request evaluation state, the result status and `Inspect evidence` appear before request-creation utilities and above the fold at desktop and mobile. Keep complete/requested/failed distinct from pass/fail and publish eligibility.
6. Workflow stages appear once. The current stage is visually prominent; unrelated stages and advanced metadata do not receive equal weight with the next action. Publication guards and publish-without-evaluation remain explicit when reached.
7. Switching bundle section preserves channel. Switching channel clears unsafe detail identity as existing routing intends. Browser Back, explicit parent navigation, and mobile menu each have an unambiguous destination. Verify using real navigation, not screenshots alone.
8. New layout uses shared shadcn controls and semantic navigation; visible active scope, keyboard focus, mobile navigation, and selected file are verifiable in the implementation.

## Two directions

### A. Integrated workbench

Use one compact app/scope bar: workspace switcher, `Bundles / BDD bundle`, channel, account. Put Content / Changes / Releases / App setup immediately below; collapse global destinations to a small shadcn menu or a compact global rail. A detail surface owns its immediate-parent back control and task actions. Keep the file navigator beside source on desktop; turn it into one Files selector on mobile. Dirty state sits beside Save; evaluating a saved generation is secondary until saving. Evaluation uses a dominant evidence/result area with request utilities in a secondary panel/disclosure.

Tradeoff: hiding workspace destinations reduces their discoverability. Require an explicit workspace menu, labelled mobile trigger, and easy access to Connections/Members.

### B. Bundle notebook with task focus

Keep the familiar sidebar but move bundle identity/channel into the topbar and use an inset horizontal section strip as the only secondary navigation. Draft is one task header followed directly by file/source split. Evaluation is a stage-specific page: completed evidence first, then publish readiness, with request creation and identifiers under a single supporting-details disclosure. On mobile, show one scope row, horizontally fitting section nav, one state/action row, then Files/source. Do not render an additional generic card header around each layer.

Tradeoff: less radical width improvement than A, but lower navigation risk and easier continuity across library, content, releases, and setup. Prefer B if a compact global menu cannot pass discoverability review.

## Current verdict

Baseline is readable and far better than a card-heavy dashboard, but it does not yet pass criteria 1, 2, 5, or 6. No approval of a generated direction or implementation until actual screens and navigation behavior are available.

## Six generated options: actual-image review

Inspected all six PNGs and `prompts.json`. Ranking is architectural; generated type, row heights, and missing controls are not implementation proof.

| Rank | Option | Keep | Material objection |
| --- | --- | --- | --- |
| 1 | A — Integrated scope header | One visible bundle scope strip; clear app/bundle/file separation; draft actions span file pane and source; persistent selected file. | The single line is crowded with long names and channels. Actual image has enlarged row heights; implement the intended compact strip, then verify intermediate widths. |
| 2 | B — Application bar | Global destinations remain discoverable while recovering sidebar width; file map stays visible and independent of bundle-navigation length. | Generated image restores substantial empty gaps and three broad horizontal layers; not demonstrably more compact than A. App row becomes crowded on intermediate widths. |
| 3 | C — Contextual left column | App destinations in a distinct global row; clearly labelled bundle and file groups; broad editor. | Four vertical bundle destinations push file navigation low. Long file lists compete with global/local navigation in one scroll region; selected Changes and selected file use similar emphasis. |
| 4 | D — Document focus | Files count, selected filename, Add entry, entry actions form an understandable file toolbar; suitable narrow mode. | Closed picker hides the bundle's collection and makes every file switch a second action. A very wide source line adds little. Preserve as narrow/focus behavior, not desktop default. |
| 5 | E — Review inspector | Clear `Saved draft (generation 1) vs. browser draft` language and labelled Close review. | Four columns/scopes compress source sharply. Inspector should be temporary, with a narrow-screen sheet/dialog; it cannot be the default editor structure. |
| 6 | F — Inline collection | Bundle-wide actions remain above the whole collection; paths sit alongside collapsed filenames. | Accordion navigation follows document length: other files drift below the source. Separate card/tool layers push source lower. `Markdown` also loses the important instruction/skill/memory distinction. |

### Recommended concrete hybrid

- A provides desktop structure: a labelled global sidebar, one compact bundle scope strip, one draft status/action bar spanning the entire workbench, then a stable file pane and source.
- Keep one immediate-parent return in the scope strip. Do not add a generic topbar and another Back to changes control. Sidebar Bundles remains the higher-level escape when inside a change.
- Preserve file list selection, paths, kinds, search, and Add entry on desktop. Use D's labelled Files control at narrow widths; selected filename/path remains in the source header. A desktop focus mode is optional and should not be introduced merely to match the image.
- Save draft stays above both panes, communicating bundle scope. Entry actions stay inside the selected-file header. Do not add per-file Save. Show changed paths in Review changes; add per-file dirty markers only if grounded in actual draft state.
- Borrow E's explicit saved-versus-browser wording for review, not its permanently open inspector. Do not carry F's accordion editing model forward.
- At intermediate widths, allow a controlled second bundle navigation row before hiding names or shrinking controls. The goal is removing redundant rows, not forcing an unbreakable desktop line. Mobile still must satisfy the source-height criterion through reordered/collapsed secondary actions.

### Peer challenge and resolution

Challenged visual review on A's long-name/intermediate-width resilience and F's unstable file discovery. Challenged editor review on D's hidden collection and C/F's below-fold file access. Editor independently agrees that A best preserves bundle Save scope and persistent collection; it challenged how the hybrid keeps multi-file changes obvious. Resolution: bundle-wide action/status bar spans both panes; file actions are nested one level below; review identifies changed paths without new per-file dirty-state derivation.

Visual and editor challenged my initial C-over-B ranking: C places file access at the mercy of long bundle navigation. Accepted; final ranking is **A > B > C > D > E > F**. Visual confirmed one scope *region* does not mean forcing one physical row. Accessibility requested long names at 200%/320 px, a labelled 44 px Files disclosure, recoverable full selected path, DOM/visual tab order, and sheet focus transfer; these are implementation checks, not image claims. At mobile widths Save plus truthful draft status remain visible; Review/evaluate saved generation can move into accessible named secondary actions. No implementation approval yet.

## Implementation review — capture 3

Inspected actual `artifacts/layout2-capture-3/screenshots/desktop-{draft,evaluation,library}.png`, `mobile390-{draft,evaluation}.png`, `mobile320-{long-scope,navigation-open}.png`, plus current `shell.tsx`, `routes/w.$.tsx`, `styles.css`, `draft-workspace.tsx`, and shared NativeSelect.

**Hierarchy design approved; no material layout objection in these screens.** This supersedes the baseline verdict. Approval is of the observed design, not an assertion that pending behavior checks passed.

- Desktop source begins at y=156; mobile source begins around y=341 (capture coordinate; reported element top is 333). Both pass the stated height targets with readable source and normal control sizes.
- One bundle scope region replaces the previous global bar + heading + tabs stack. A single immediate-parent return changes to Back to changes for detail routes; Bundles remains accessible in global navigation. Library no longer repeats the topbar title.
- Bundle Save/status spans file navigation and source; file actions sit within selected-file heading. Mobile keeps saved-generation and unsaved status outside Draft actions, with Save visibly primary.
- Completed evaluation results and Inspect evidence now precede request creation and remain above the fold at 390 px. Repeated stage numbering is gone. `App reported completed` accurately distinguishes app reporting from evidence judgment.
- The 320 px long bundle title wraps into full-width identity, and the selected deep file path wraps visibly; navigation remains legible. Menu shows labelled workspace destinations instead of an icon-only rail.
- The responsive implementation permits wrapping rather than enforcing A's generated single physical row.

Remaining completion evidence: final behavior suite for channel-preserving section changes, channel detail reset, explicit-parent/browser Back behavior, menu/sheet navigation and focus; parent-reported mobile Draft actions → dirty-dialog cancellation focus repair; valid native 200% captures after scroll-reset correction; long channel and intermediate-width checks if not already included in the final suite. Earlier negative-top zoom screenshots are not used as evidence. No architectural revision is requested while those checks complete.

## Final rendered review — capture 5

**Approved. I am happy with the implemented hierarchy; no material hierarchy objection remains.** No app edits requested.

Directly inspected current desktop draft, Review saved change, selected evidence, evidenced and manual release dialogs; mobile 390 draft/evaluation; 320 px focused section tab; and native 200% draft. Read capture exit status and the 35-state passing summary. This review is independent of overall test completion: the broader suite and edge checks remain the implementer's validation responsibility.

The explicit `Review saved change` heading fixes the last ambiguity in the review page's identity while preserving generation context. Selected evidence sits above request utilities and leads to `Review release with this evidence`; release dialogs retain bundle, target, parent, candidate/generation, and evidence/manual distinction without introducing another navigation layer. Manual release plainly says no evaluation supports it.

The mobile source remains readable below a compact, truthfully scoped draft header. At native 200%, the first source is visible; recorded CSS metrics show editor top 243 in a 328 px-high viewport, with document scroll, editor scroll, and visual viewport offset all zero. The 320 px focus screenshot keeps the focused Content link outline inside the visible navigation region. No earlier auto-scroll artifact was used to approve zoom behavior.

Capture summary records keyboard file selection, editing, save, evaluation navigation, disclosure use, preserved collapsed edits, and unchanged release state. Parent reports the final capture also verifies dirty-menu cancellation restores the trigger and edits; Files selection closes with focus; sheet Escape returns to its trigger and Members navigation focuses main; first Save transfers keyboard focus to Continue after remount. These address the previously pending focus concerns. Long-channel/intermediate-width and second-save checks are additional edge validation, not grounds for another architectural change absent an actual failure.
