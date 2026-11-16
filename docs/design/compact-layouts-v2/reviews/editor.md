# Developer-editor review

Reviewer: independent editor UX. Status: baseline audited; concepts pending.

## Baseline findings

- At 1440×900, draft source begins at y≈253 and occupies about 966×608. This is already a usable source canvas; retain its plain Markdown and visible focus ring. Large gains must come from navigation and repeated workflow chrome, not smaller source text.
- At 390px, source starts at y≈445. Bundle title/channel, tabs, draft status, workflow steps, three actions, Files, and entry heading consume roughly half the first viewport. The workflow step list repeats the surrounding navigation and contributes little during sustained editing.
- A 236px file rail is expensive for four entries. Its controls consume about 164px before the first row. Search plus separate Search button in published content makes the search field too narrow to communicate its scope.
- Full selected file paths are essential when filenames collide. The baseline preserves paths in the selected header, but list paths are ellipsized; avoid replacing paths with friendly names everywhere.
- Saved generation and unsaved browser payload are different objects. Current dirty-state evaluation explicitly targets saved generation N. Hiding that qualifier to shorten a toolbar is a material regression.
- The mobile Files disclosure remains expanded after selection. A larger navigator can put the newly selected source below the viewport. Switching files must preserve all browser edits and make the selected source easy to reach.
- File switching is currently local state over one payload. Do not add discard dialogs for ordinary file selection. Actual route/channel/draft/reload transitions must retain existing pending-change protection.
- Filters can hide the selected draft entry while its source stays open. Preserve editing, but clearly expose the active path and a Clear filters escape.
- Current raw source wraps long lines; do not silently convert to rendered Markdown or a rich-text document to make screenshots prettier.

## Preferred alternatives

1. Desktop: compact navigation rail, dedicated file rail that can collapse, one selected-file/source bar, and one draft action bar. Put import/history/details into a secondary disclosure or menu. Keep Save directly visible.
2. Small screens: a 44px Files trigger that includes the active filename, opening a bounded picker; selecting closes it and restores focus to the source or trigger. Put entry actions behind one explicit menu. Keep full path obtainable without hovering.
3. Remove the persistent Edit → Evaluate → Publish stepper during editing. Use concise saved/unsaved status beside Save, then a clearly labelled saved-generation evaluation action. Do not create a fake Publish shortcut.
4. Search should use most of the file rail width. Use Enter to submit published search, with an accessible search icon button or compact affordance if a button is retained. Make filtering behavior explicit; published searches paths and content, draft searches paths only.

## Acceptance / material objections

- Source remains a plain textarea/pre showing exact Markdown; copy/download still use exact text. No generated summaries, rendered preview default, line-number machinery, or decorative code gutters that reduce writing width.
- Source text is ≥14px desktop and ≥16px on touch. Touch hit targets are ≥44×44px. Do not claim density gains from shrinking controls or metadata users need to read.
- At 390px, aim for first source line by y≤360; keep ≥300px visible editing width and avoid global horizontal scrolling. At desktop, preserve ≥900px source width at 1440px unless file content demands more rail width.
- Saved generation N, unsaved changes, and uncertain submission remain explicit. Evaluation uses the immutable saved snapshot; a dirty draft must label that target, including on mobile.
- Tab order remains logical, focus visible, menus/dialogs support Escape and return focus, file picker is keyboard reachable. Do not intercept textarea Tab or replace native editing behavior without an explicit requirement.
- Switching files with edits preserves text; changing draft/channel/route or reloading saved draft retains dirty guards. Busy/recovery/read-only states retain their existing disabling rules.
- Check long nested paths and duplicate basenames, empty/filtered files, many files, very long source lines, dirty drafts, uncertain submission, 390px and 200% zoom. Acceptance is against browser implementation, not image aesthetics.

## Six generated concepts

Viewed all six actual PNGs and read their intended prompts. Ranking for editing: **A > B > D > C > E > F**. This ranks directions, not implementation approval. Generated dimensions/oversized type are not browser acceptance evidence.

- **A — best foundation.** App, bundle, draft, and selected-file scope remain distinct. Save/Evaluate are above both files and source. Keep the persistent file map and quiet utility footer. The actual rendering still spends too much space on file controls and oversized bars; implement the prompt's compact dimensions, not its literal image scale.
- **B — good writing width, higher global-change cost.** Removing the app rail leaves more source width while files stay discoverable. Its actual rendering adds excessive space above the draft bar and editor. A coherent alternate app shell, but A is a smaller change and works across existing app views.
- **D — useful narrow/focus variant.** A closed Files picker restores full writing width. Reject as default desktop: hiding the collection makes file changes two actions, reduces instruction/skill/memory awareness, and makes bundle Save feel selected-file scoped. Its actual repeated top rows also fail to exploit height fully.
- **C — efficient main canvas, weaker file scale.** The single contextual rail separates sections with headings, but bundle identity and four route links push files halfway down the screen. Ten or thirty files would expose the cost. Do not mix file selection and bundle route navigation without a stronger scroll/focus contract.
- **E — reject literal inspector.** It squeezes source into a narrow third column and shows a saved-versus-browser comparison that is not today's Review changes behavior. Current code compares published parent (`base`) against browser payload. Adopting its title would silently mislabel the baseline. Keep a full-width optional review toggle using existing semantics.
- **F — reject collection accordion.** File discovery moves with expanded document length; changing files risks unmount/caret/scroll churn. The mock also substitutes generic Markdown kind badges for domain types and repeats structural cards. It starts writing much lower despite its nominal simplicity.

## Peer debate and recommended hybrid

- Challenged hierarchy about whether D makes bundle Save look document-scoped, and whether C's combined pane scales. Hierarchy agreed Save/Evaluate must span file rail and source, with selected-entry actions one level below. We agree D belongs at narrow widths, not as desktop default. Hierarchy accepted C's file-scale objection and revised to A > B > C > D > E > F. Editor's D-above-C ranking refers to its value as a narrow layout pattern, not hidden files on desktop. Available source width should inform the breakpoint, but a ~700px writing target is not an absolute minimum for every intermediate device.
- Challenged workflow about E's incorrect comparison baseline and mobile saved-generation wording. Workflow independently identified the same baseline problem. We agreed to retain published-parent review, avoid adding dual-diff modes, and keep evaluation explicitly saved-generation scoped. Dirty evaluation remains a route transition protected by existing guards.
- Workflow proposes mobile compact saved status plus Save and a labelled saved-generation evaluation action in two rows. Editor accepts that structure; the visible label may wrap within a ≥44px control. A bare Evaluate button is unacceptable. File picker changes local selection, closes after selection, and retains the browser payload.
- Do not add new per-file dirty indicators in this layout pass: the existing model reports bundle-wide dirty state, and rename/package edits complicate invented per-file precision. A truthful bundle status is sufficient.

**Hybrid recommendation:** A's app/bundle hierarchy and shared draft action bar; persistent desktop file rail; D's named Files picker only when writing width becomes constrained; one selected-file/path toolbar with entry actions; full-width existing published-parent review; quiet footer utilities. Recover space by removing the edit/evaluate/publish stepper and repeated heading rows, not shrinking source or hiding saved-state meaning.

No implementation approved yet. Browser evidence must satisfy the acceptance list above.

## Implementation review — capture 3

Viewed actual desktop draft/content, mobile390 draft/actions/files, mobile320 draft, and mobile320 long-scope captures; inspected current DraftWorkspace, FileNavigator, and ContentDiff.

**Conditional design verdict: approved direction, behavioral completion pending.** No new material visual, writing-space, or action-scope objection in these captures. Desktop source now begins at y≈156 and is about 1006×676; compact bundle scope and removal of the stepper recover useful height without reducing 14px source. Mobile390 source begins around y340, retaining 16px source and 44px actions. The 320px clean Continue action wraps safely; hiding the type pill there is acceptable because entry actions retain kind and the full path remains visible. Long title/path wrapping keeps source readable without page-wide horizontal scrolling.

- Shared draft actions still span files and source, while Entry actions remain inside the selected-file header. Explicit saved-generation wording survives in the mobile Draft actions menu. This resolves the original document/bundle scope objection.
- Published-parent review now names its actual baseline; `ContentDiff base={base} current={payload}` remains intact. No E-style incorrect saved-versus-browser claim was introduced.
- File selection remains local payload selection; the picker closes after a committed changed path and returns focus to its persistent toggle when focus was inside the list. A cancelled guarded navigation does not prematurely close it.
- Save focus code tracks whether Save owned focus and yields to later user focus movement. Final verification must include creating the first saved draft, where navigation/remount can differ from saving an existing draft.
- Minor nonblocking polish: choosing the already-selected file in an open narrow picker does not close it, because the committed path did not change. Selecting another entry behaves correctly by source inspection; actual selection/edits evidence remains required.

Outstanding material acceptance evidence: dirty menu route cancellation returns focus to the persistent trigger (parent reports fix in progress); first-create and existing-draft Save → Continue focus behavior; edits in multiple files survive picker navigation; actual native 200% zoom after viewport/scroll reset. The prior negative-scroll zoom image is not approval evidence.

## Final editor verdict — capture 5

**Approved. Happy with the implemented direction; no remaining material editor objection.** This supersedes the conditional capture-3 verdict. The earlier same-selected-file picker detail remains optional polish, not a blocker.

Inspected capture-5 native200 draft, mobile390 draft and Draft actions, selected evidence and evidenced-release dialog. Read the green capture exit and 35-state summary, native zoom metrics, current focus handoff in DraftWorkspace/BundleChanges, persistent-trigger restoration in PendingChangesProvider, and the committed-selection picker logic.

- Native 200% now has a valid initial viewport: CSS width 640, height 328; page scroll, textarea scroll, and visual viewport offset all zero. Source begins at CSS y243 with a useful visible portion. Paths, controls, and source remain readable; this resolves the previous invalid zoom evidence.
- Mobile keeps Save directly visible and the saved-generation evaluation target explicit inside Draft actions. The file picker remains a separate control above the selected-entry toolbar. No document/bundle action-scope ambiguity was introduced.
- First-save remount focus intent now lives above the keyed workspace and is consumed once. Existing Save focus yields when users move elsewhere. Parent's capture assertions cover creating the first draft and focusing visible Continue; the summary confirms keyboard selection, rename, editing, save, evaluation navigation, and collapsed-edit preservation.
- Cancelling a guarded action from a menu now restores its persistent trigger rather than a detached menu item. Parent reports the capture explicitly asserts Keep editing retains edits and returns focus to Draft actions; source matches that contract.
- Published-parent review remains correctly labelled. Evidence and release UI continue to refer to a saved candidate/generation and selected evidence, rather than implying browser edits are evaluated or published.

The independent extra edge runner and full BDD run are still in progress as of this verdict. Their outcomes belong in the final validation report; this approval does not claim they already passed. No additional UI changes are requested from this reviewer unless those checks expose a regression.
