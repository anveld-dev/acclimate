# File-tree implementation and product review

Implemented only `components/file-tree.tsx` and `lib/file-tree.ts`; root owns styling, peers own published/draft integrations and tests. Followed the [W3C APG tree pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): single roving tab stop, focus independent of selection, arrow/Home/End/typeahead navigation, real Enter/Space activation and owned child groups.

## Three-concept opinion

Personally viewed A/B/C and debated editor, review, interaction, visual and skeptic. **B > A > C for truthful hierarchy**: only B retains the actual `references` folder. Combine A's quiet row economy with B's correct topology and subtle guides. Reject A/C flattened paths, fabricated narrow pickers/type options and misleading empty-search examples. Actual 240px rendering must decide indentation/ellipsis, not the wider concept sheets.

## Implemented contract

- Folders first with stable source order inside each group; exact basename, including `SKILL.md`, replaces aliases/subtitles. Folder IDs and stable item IDs are separate; duplicate and invalid draft paths remain represented as individual leaves.
- Initially expanded folders; independent collapse never changes selected content. Temporary filter folds start open and reset with applied filter identity, while clearing restores base folds, including selection temporarily missing from results.
- Selected/add/rename ancestors reveal without stealing outside focus. Initial/changed selected-row reveal scrolls only the tree scroller; unrelated folding does not jump back to a selected row. Same-ID rename consumes its reveal immediately.
- Published leaves remain actual `ConsoleLink` targets and keep browser modifiers; draft leaves remain Buttons. Only leaves have `data-file-path` and `content-file-button`. Folder treeitem Buttons own sibling child groups through `aria-owns`, avoiding nested interactive controls or oversized focus boxes.
- Exact-path hover/focus tooltips supplement real labels. `data-slot="button"` survives Tooltip wrappers. Narrow Files selection remains governed by the existing committed-path change contract; activating an already-selected path is not a new change.

## Final actual-result opinion

Accept frozen build `91510cb60e16a04e626f7808892151c0ea5b86ebd6bc51f0b7e688259f4c7161`. Personally viewed actual core published/draft/native-200% captures and all seven focused verified captures: ordinary four-file tree, 24-file selected-root reveal, exact deep-path tooltip, restored selected-folder fold after filtering, browser rename/delete/add/import, 390px coarse and actual native 200%. The truthful hierarchy, actual `SKILL.md`, restrained guides, 240px rail and distinct selected/focused states read clearly. No concept's flattened references folder or fake controls were copied.

The focused report passes six checks on identical before/after hashes. It proves real published href Enter/Space activation; independent folder toggles; native Tab/arrows/Home/End/typeahead; initial selected-root internal reveal without document scrolling; full-path hover/focus/Escape; temporary filter folds and selected-file-absent restoration; invalid/duplicate draft paths, stable rename, earlier-entry deletion, add/import ancestry and preserved dialog/source focus. Narrow folder toggles keep Files open, committed leaf changes return focus, and cancelled dirty navigation preserves the current state.

The skeptic's nine model tests and root's reported 153-unit/typecheck/build and broader captures supplement that evidence; I did not run builds, tests or browser automation. All focused browser edits were discarded, saved versions/promotions/drafts stayed unchanged, and no provider/model calls occurred. APG semantics and browser keyboard behavior are evidenced; screen-reader/assistive-technology testing was not performed. No further implementation or visual change requested.
