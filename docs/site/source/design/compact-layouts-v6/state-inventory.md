# Interaction coverage

The desktop change must preserve the [existing interaction system](../compact-layouts-v5/state-inventory.md), not just look good with everything closed. The new top bar is checked across Bundles, Content, draft editing, evaluation review, Releases, App setup, Connections and Members.

| Area | Checks for this pass |
| --- | --- |
| Desktop navigation | 1024/1440/1920px, visible labels and workspace, current route, keyboard reachability, no overlap, wide working area |
| Workspace/account | Hover and keyboard tooltip, Escape, long names, account details, creation, native workspace selection, focus return |
| File workspace | Published and draft source, clean/dirty Save, browser edit retention, file search/filter, selected path, Add entry and Entry actions |
| Collapsed content | Import, history, draft details, setup recipes, advanced settings, account details, output/error and recovery details |
| Evaluation/release | Saved generation, external execution handoff, evidence provenance/missingness, manual reason, exact release/restore target, decisions and cancellation |
| Forms/admin | Inline errors, permission-sensitive navigation, member lookup/removal, connection scope/revocation, masked one-time credentials |
| Responsive/access | Phone picker and navigation, coarse targets, long strings, short viewport, native 200% zoom, focus visibility/return, reduced motion |

These are representative states and behavior tests, not every permutation. Rare storage/service faults, every concurrent permission race, platform-native popup appearance, and assistive-technology qualification remain narrower evidence or source-only limits. Live model quality is outside this UI pass. Test fixtures use private PostgreSQL and identity/TLS infrastructure, with no paid model calls.

The [final evidence table](README.md#verification) links 227 captures across four suites. The accepted desktop run adds 28 checks and the expanded interaction/navigation run adds 418. The ten-cycle resize stress test checks the focus handoffs immediately, before any screenshot settling. Editor focus and unsaved text stay intact; an open account dialog retains focus through resize, then returns to visible main content if its trigger has disappeared.

Early captures with compositor lag, superseded build2 focus failures, the macOS caret-setup failure, and the transport-classifier false positive remain diagnostic records. They are excluded from the accepted counts. The classifier explicitly distinguishes known read actions from writes and unknown requests; backend-state checks remain in place.
