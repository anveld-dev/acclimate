# Interaction coverage

Compact layouts still need room for the states people actually use. Generated insets suggest compositions; actual browser checks establish behavior.

| Area | States to inspect | What must remain true |
| --- | --- | --- |
| Search | Empty, typed but unsubmitted, Enter, submit click, applied query, type filter, no match, Clear | Input and submit stay associated; URL scope and selected path behave as before. |
| Search help | Hover, keyboard focus, Escape, coarse pointer | The icon has its own accessible name. Help is supplemental. Focus rings and tooltip fit the viewport. |
| Files | Selected entry, long path, narrow picker closed/open, keyboard selection | Exact path stays available; hidden controls leave the tab order; selection returns focus to the picker. |
| Draft | Clean/dirty, saved generation, browser changes, entry actions, add/import/history | Whole-draft actions stay distinct from entry actions and saved-version review. |
| First evaluation | No requests, setup open/closed, custom configuration, validation | App-owned execution is clear; closing setup preserves edits. No empty results panel competes with setup. |
| Request history | Requested, running, completed, unrelated loaded rows, older-page cursor | No matching rows on a loaded page never means there are no older rows. Handoff and loading remain available. |
| Evidence | None selected, selected, incomplete, mismatched, detailed pairs | Candidate/parent binding, missingness and per-arm facts stay intact. A report is not an automatic release verdict. |
| Release decision | Evidence path, manual reason, Cancel/Escape, final confirmation | The target, candidate and saved generation remain explicit. No silent publication. |
| History | Several revisions, current marker, long reason, full UTC, details open independently, Inspect | Real identities and digest remain readable and copyable. No fixed table truncates them. |
| Restore | Past version, reason required, Cancel/Escape, return focus, uncertain outcome | The existing deliberate new-release flow and recovery distinctions remain. |
| Shared shell | Navigation, workspace/account menus, tabs, mobile sheet, errors | Workspace and bundle/channel scopes remain separate. |
| Reflow | 1440/1920/1024 desktop, narrow viewport, native Chrome 200%, coarse pointer | Controls stay usable, fields wrap, and dialogs own their scrolling. |

The focused v10 run covers the changed paths. Existing broader suites cover the surrounding editor, shell, disclosures and dialogs on the same build. Their exact results are linked from the guide.

Rare unknown-outcome recovery, permission branches and identity edge cases are also reviewed in source. We do not claim a newly captured screenshot for every possible server or network failure. No paid model execution or broad assistive-technology qualification is implied.

## Issues caught during verification

The first geometry run found a real component-composition bug: TooltipTrigger replaced the Search button's slot marker, bypassing the shared 36px button rules. The fix preserves the Button marker through the tooltip. The search addon also drops its inset negative margin so the larger target stays inside its group at native zoom.

Early focused runs also exposed test-fixture assumptions: a broad query matched content as well as paths, a request disclosure was addressed as a region, and pagination clicks needed to wait for the actual request response. Those diagnostics are kept separately from accepted evidence. The older core assertion expecting the intentionally removed empty results panel was updated while keeping the setup and creation checks.
