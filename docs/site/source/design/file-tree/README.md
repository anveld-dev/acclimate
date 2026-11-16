# File tree

[Concepts](comparison.html) · [Exact prompts](prompts.json) · [Live console](https://localhost:3443/w/acclimate/bundles)

Published content and draft editing now share a real folder tree. Folders collapse; files keep their actual basenames. The tree replaces the repeated directory subtitles in the old list.

## What we chose

Three built-in image-generation concepts explored the explorer layout. Six reviewers chose B’s accurate folder hierarchy and subtle guides, with A’s quieter rows. A and C flattened a real folder in their mockups, so we rejected their topology. We kept the existing shell, task toolbar and inline narrow-screen picker.

The shared rail is 240px on desktop, with 14px text, 36px rows and 44px touch targets. Long names truncate in the tree; hover or keyboard focus shows the exact path. The selected file and keyboard focus have separate treatments. Deep indentation stops growing after seven levels so filenames keep room.

## How it behaves

- Clicking a folder changes its expansion only. It never edits content or changes the selected file.
- Arrow keys, Home, End and typing move focus. Enter or Space activates a file or toggles a folder.
- Published files retain real links. Draft files select the existing editable entry.
- Filtering shows matching files with their ancestors. Clearing filters restores the earlier folder folds.
- New, renamed and selected files reveal their ancestors. A manually collapsed selected branch stays collapsed until selection or path changes.
- The tree scrolls internally. It does not pull the document or editor away from the user.
- Empty results keep the existing clear-filter action. Invalid draft paths remain visible so they can be fixed.

## Code

[Shared component](../../../apps/console/src/components/file-tree.tsx) owns interaction and shadcn Button/Tooltip composition. [Tree model](../../../apps/console/src/lib/file-tree.ts) builds hierarchy without losing invalid or duplicate draft entries. [Model tests](../../../apps/console/tests/file-tree.test.ts) cover hierarchy, identity, focus and typeahead.

Published and draft views keep their own search, mutation, navigation and saving rules. The tree does not add filesystem commands or a new persistence layer.

## Review and verification

All six reviewers accepted the working result after inspecting the concepts, implementation and final browser evidence. No material issue remains within this change.

[Library](reviews/library.md) · [Draft editor](reviews/editor.md) · [Published content](reviews/review.md) · [Interaction](reviews/interaction.md) · [Visual](reviews/visual.md) · [Skeptic](reviews/skeptic.md)

Production build `91510cb60e16a04e626f7808892151c0ea5b86ebd6bc51f0b7e688259f4c7161` passes typecheck, all 153 console tests, 20 selected BDD scenarios (94 steps), and the current desktop, compact and interaction suites (46, 58 and 54 captured states).

[Desktop evidence](../../../artifacts/file-tree-desktop/summary.json) · [Compact and native zoom](../../../artifacts/file-tree-core/summary.json) · [Overlays](../../../artifacts/file-tree-interactions/summary.json) · [BDD scope](../../../artifacts/file-tree-bdd/coverage.md)

[Focused tree proof](../../../artifacts/file-tree/verified/summary.json) passes all six workflows: ordinary published links; 24-file keyboard navigation and exact-path tooltips; filter/fold restoration; rename/delete/add/import; touch selection and dirty-navigation cancellation; and real browser zoom at 200%. Persisted drafts and releases stayed unchanged; no model or provider calls were made.

The first diagnostic run exposed two test assumptions, fixed in the harness: fading tooltips needed exact open-state matching, and the test needed to close Entry actions before navigating the background tree. No application changes were needed after freezing the build. Passing browser checks is not a claim of broad assistive-technology qualification. Keyboard behavior follows the [W3C tree-view pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/).
