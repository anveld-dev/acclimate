# Library and information architecture review

## Initial findings

Read current `bundle-library.tsx`, `bundle-changes.tsx` and suggestion-form sections of `improvement-workspace.tsx`; viewed actual desktop10 1440px and native-200% library captures. Desktop10 does not contain Changes-index, suggestion or bundle-creation captures, so their initial assessment is source-based until new runtime evidence arrives.

- Preserve the accepted bounded library and direct exact-channel links. Sparse space is honest; metadata remains name/origin/compatibility/channel only. Do not add a selection pane, activity or status dashboard.
- Changes has three real tasks: start an edit/suggestion, inspect channel-scoped drafts, inspect bundle-wide suggestions. The scope distinction must survive compactness changes. A bounded single column may improve current full-width lists without new tabs or selection state.
- Draft and suggestion requests load, fail, refresh and paginate independently. Closed-draft visibility affects only loaded rows; do not substitute total counts or claim that a filtered loaded page proves no history. Suggestion polling and already-loaded active-row refresh must remain intact.
- Suggestion authoring is a form, not a chat or agent runner. Parent channel/revision, editable paths, whole-bundle disclosure and explicit consent are critical. Allowed edit paths do not limit reading. A narrower form and clear field grouping may help; a duplicated scope/consent sidecar does not inherently earn space.
- Creation already has four source modes, import preview/confirmation, immutable compatibility target settings, immediate publication summary and unresolved-operation recovery. Preserve all modes and honest Create/Import **and publish** labels. Reformatting as a wizard or modal needs a real gain and must not hide publication or recovery state.
- Read-only new-draft/new-suggestion routes already show alerts, while existing history remains inspectable. Provider-not-configured errors must retain actual server semantics; no invented provider setup or execution controls.

## Six-image verdict after peer debate

Viewed all six actual images and debated all five peers. Borrow **A's 1024px bound for the Changes index only** and responsive aligned definition lists for actual full draft/suggestion metadata. Keep existing separate panels, scopes, record links, refresh, closed visibility and pagination. A's fabricated names/statuses and suggestion-identity omission are invalid. **B's split columns** do not earn their width: channel drafts and all-channel suggestions are different tasks, and full IDs/reasons become cramped.

Borrow **C's approximately 768px bound for the entire proposal-mode surface**, including errors, messages, related pending and recovery. Keep source order and explicit Check result outside hidden details. Preserve whole-parent disclosure/consent and exact editable paths; long path labels need wrapping, fixed checkbox visibility and usable coarse targets. C's invented disclosures and D's provider setup link, progress, counters and glob paths are invalid. **D's sidecar** has no demonstrated gain.

Retain current library/create over **E/F**. Side-by-side creation or cards/nested modals compress real import previews and publication/recovery context without adding needed information. No new creation flow or scope state is earned.

## Confirmed existing behavior gap

The Include published and discarded drafts control cannot fulfill its label: `server/drafts.ts` lists without status, Rust defaults to open, while the SDK already supports status all. This deserves a narrow repair using the existing capability. If all statuses are fetched and then locally filtered, a loaded page containing only closed drafts plus an older-page cursor must say no open drafts **on loaded pages**, preserving Load more. Server open/all queries with reset are another valid approach. Acceptance needs real closed/mixed pagination and toggling both ways, not only source review.

## Final independent result verdict

Accept final build `0f5464d8a58e669deee66734d3bd734b0afb5b88339012c89dc79334715c2ff1`. Personally inspected accepted actual captures of four-bundle library, all four creation modes and publication settings/summary, Changes closed-first-page cursor and full independent details, long-path suggestion at 1440px/native 200%, read-only route guard and real local-provider result. Re-read final source for list/proposal-only bounds, wrapping labels, complete metadata and status-all request.

The Changes index is compact without obscuring channel drafts versus all-channel suggestions. The formerly ineffective closed toggle is now backed by status-all retrieval: the accepted run proves 20 real discarded drafts on the first page, two older open drafts, working pagination and toggles both ways. The empty loaded-page explanation is honest. Full metadata stays available in independent disclosures.

The narrower proposal form keeps exact path choices, parent scope and whole-bundle consent readable; the native-zoom capture preserves checkbox alignment and wraps the long path. Current library/create remains the right composition: exact channels/unpublished rows, real JSON/files/example previews, explicit immediate publication and fixed compatibility target all retain their meaning. No new inspector, wizard or modal stack is needed.

The accepted summary reports five passing checks/25 captures, matching final hashes before/after and no geometry violations. It verifies one explicit UI initial publication and one consented UI suggestion to a localhost synthetic provider; existing content/promotions/drafts were unchanged. These are inspected evidence reports, not tests run by this reviewer. Queued/running states were not artificially held; provider-not-configured, transport/recovery failures and external-provider quality remain source-reviewed or outside this focused proof. No app edits, builds or tests by this reviewer. No further composition change requested.
