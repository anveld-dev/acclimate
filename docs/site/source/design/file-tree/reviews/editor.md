# Draft task review

Integrated the shared FileTree into the draft file navigator only. Leaves use the existing payload index as ID and exact path/kind; selection still calls setIndex and onSelectPath. Fold scope follows workspace/channel plus draft identity, not source text, selected file, rename, or saved generation. Existing search/type/Add/empty states, browser edits, Save/evaluation scope and source/header remain intact.

The tree must earn repeated file finding: show real directory hierarchy and `SKILL.md` basename, preserve exact paths and semantic selection, and keep matching ancestors visible under filtering. Folder controls must not navigate or mark a browser edit. A renamed/added entry should reveal its ancestors without stealing focus from source/dialog; collapsing folders should preserve the selected file's content.

Draft-specific review bounds: browser paths can be temporarily empty/invalid while renaming, duplicated before validation, or removed with index changes. The navigator must retain every entry and avoid path-key identity collisions. Busy state should disable file selection consistently with the existing editor. Narrow Files selection/return focus and unsaved navigation guards must continue to work.

Three polish concepts and actual runtime evidence are pending. No build/runtime/tests run by this reviewer.

## Polish concept judgment

Viewed all three actual concepts and debated all five peers. Borrow B's truthful `references` nesting and restrained guides with A's quiet row treatment. A/C incorrectly flatten the hierarchy; all generated narrow popovers, Add mislabels and invented type options are rejected. Keep the existing inline Files picker and task bands. Actual tokens/targets matter more than image rail dimensions; avoid double indentation that crowds basenames.

Further runtime requirements from debate: keyboard focus must remain distinct from selection; folder disclosure must not close narrow Files; collapsing a selected ancestor must stay collapsed during source typing/save. Filtering may temporarily reveal matching ancestors and allow temporary folds, then restore base folds when cleared. Rename/Add/import must reveal without stealing outside focus. Since draft IDs are source indices, removal can reindex entries: verify selected/earlier deletion preserves existing editor behavior and does not move focus to an unrelated file. Folding distant branches must not repeatedly scroll back to the selected leaf and hide the focused folder.

No further image round requested. Actual implementation judgment pending.

## Final actual runtime — approved

Inspected frozen `91510c…` ordinary published/draft/mobile captures and verified browser rename/delete/Add/import, filter-clear fold restoration, coarse 390px and native 200% captures. The real tree preserves `skills/review/references/checks.md` and `SKILL.md`, uses restrained guides and distinct selected/focused rows, and keeps source/header/Save/saved-generation actions intact.

The [verified report](../../../../artifacts/file-tree/verified/summary.json) passes all six focused checks: native published links; focus-only tree keys/typeahead and exact hover/focus paths; filter ancestry/base folds; invalid/duplicate/renamed entries; earlier-entry deletion followed by correct content selection; Add/import reveals without dialog focus theft; narrow folder non-close and committed-leaf focus return; dirty navigation cancellation. I inspected this evidence and source rather than running the checks. The removal handler's deliberate reset to current first entry remains the same as before integration.

No material draft-task objection remains; no further polish image round is needed. Browser mutations in the focused proof were discarded, with persisted versions/promotions/drafts unchanged and no Save/publication/provider calls. It does not qualify assistive technologies or newly exercise unknown-write recovery. My app changes were limited to the requested draft integration; no builds/tests/runtime automation run by me.
