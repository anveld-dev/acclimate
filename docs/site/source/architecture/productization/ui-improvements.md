# UI improvement plan

**Implemented, 2026-11-14.** Four agents reviewed navigation, everyday workflows, visual structure and onboarding, then challenged each other's suggestions. Seven implementation lanes landed the changes below. Two fresh reviewers checked the result, and rendered browser checks covered desktop, mobile, coarse pointers, keyboard focus and native Chrome 200% zoom.

Keep the current product and Mira components. Make the useful work easier to see: choose content, save a change, review it, optionally evaluate it in your app, then release it. Density should come from less repeated layout, not smaller reading text.

## What we found

| Current friction | Proposed change | Evidence |
| --- | --- | --- |
| Channel/revision and Connect app repeat across headers; the setup destination has no active bundle tab | One bundle context header; four tabs including App setup | [Scoped page](../../../apps/console/src/routes/w.$.tsx), [Content](../../../apps/console/src/components/bundle-content.tsx) |
| The production draft's forward link says Evaluate, although the destination also offers manual release | Call it Review release; expose the two release paths there | [Changes](../../../apps/console/src/components/bundle-changes.tsx), [Draft editor](../../../apps/console/src/components/draft-workspace.tsx) |
| Creation shows instructions, JSON and examples together; immediate publication is explained only in an error block | Choose one source; clearly label the final action Create and publish | [Bundle library](../../../apps/console/src/components/bundle-library.tsx) |
| Common controls use 12px text and 28px heights; library cards nest inside another panel | Readable task controls, compact rows and fewer containers | [Button](../../../apps/console/src/components/ui/button.tsx), [Input](../../../apps/console/src/components/ui/input.tsx), [Bundle library](../../../apps/console/src/components/bundle-library.tsx) |
| Evaluation setup, raw identities, output text and release controls compete vertically | Lead with the saved change and decision; show request/evidence summaries before technical details | [Review and evaluation](../../../apps/console/src/components/improvement-workspace.tsx) |
| App setup mixes installation, checkout packaging, reporting and cache details | Three primary setup steps; optional topics expand separately | [SDK setup](../../../apps/console/src/components/sdk-setup.tsx) |

## 1. Make ownership obvious

Keep existing URLs and the small workspace sidebar. Do not add an agent dashboard or a separate top-level evaluation area.

| Level | Navigation | Meaning |
| --- | --- | --- |
| Workspace | Bundles, Connections, Settings → Members | Content collections, app credentials/reports, and people |
| Bundle | Content, Changes, Releases, App setup | Published files, proposed edits, release history and SDK setup |
| Detail | Selected entry, draft, suggestion or evidence | Work on one thing without losing its parent context |

App setup keeps the current `/connect` URL and gets an active tab. Connections keeps its name because it includes both credentials and delivery reports. Remove the duplicate Connect app links.

Use one compact header for bundle name, applicable channel control and published revision. Content no longer repeats that row. Breadcrumbs identify the current tab and short detail label; full paths and IDs remain available in the detail.

Changes needs precise scope: **Drafts · stable** owns its channel picker; **Suggestions · all channels** stays bundle-wide. A review shows its release target explicitly. Preserve relevant Content filters when switching channels. Preserve suggestion detail only while recomputing parent/release eligibility and clearing the entered release reason; switching channels must never imply approval for the new target. Channel-owned draft detail returns to its list through the existing unsaved-work guard.

## 2. Make creation and release honest

New bundle is one compact form with three source modes: **Write instructions**, **Import JSON**, or **Use example**. Render only the selected source. Keep the immutable target choice visible; channel can default to stable with an explicit editable option.

Always show a short review before submission: “Publishes 4 entries to stable. Target: Codex, fixed for this bundle. No evaluation.” Use **Create and publish** or **Import and publish**. Preview the actual example content. Mode changes cannot replace or conceal an unresolved submitted command.

The normal editing path becomes **Content → Draft → Review release**. Save remains a distinct action. Review shows the saved generation, base/current revision, target and full diff, then two clear options:

- **Evaluate in your app:** choose configuration, create a request, follow the app handoff and inspect reported evidence.
- **Release manually:** provide its own required reason and clearly record that no evaluation supports this release.

Both end in an explicit publication decision for the reviewed snapshot. Unsaved editor text is never silently included. A short confirmation shows target, generation and evidence or reason; the long diff stays on the page.

Give **Mark interrupted** its own request action and reason field. It currently shares state with the manual-release reason. Keep the warning nearby: recording an interruption does not stop the external app or its charges.

## 3. Keep it compact and readable

Keep the palette, sidebar and current width limits. Adjust the controls used by these workflows, not all 63 primitives.

- Task text, form labels, editing text and primary action labels: **14px**. Secondary metadata can stay 12–13px.
- Default desktop controls: about **32px**. Keep coarse-pointer targets at least 44px and mobile input text at 16px.
- One title/context row, one relevant toolbar, then the working surface. Use roughly 16px section gaps and 12–16px panel padding.
- Library: one semantic row list with bundle name, target/origin and channel links. Keep real links; avoid making the whole row an inaccessible click target.
- Editor: reuse Content's file-list/detail structure. Put saved/unsaved state and Save draft in its header. Keep Add entry visible, Import secondary, and Rename/Remove contextual. Package rename gets an explicit Apply button.
- Comparison: compact case rows for parent/candidate execution, grades, rewards and known/unknown cost. Expand outputs/errors per case instead of placing paragraphs inside table cells.

Use a normal action bar first. Add sticky actions only if mobile, zoom and focus checks show they do not cover content. Keep long dialogs scrollable and mobile navigation within viewport width.

## 4. Reduce plumbing in the normal path

Request rows show last reported state, update time and the next useful action. Matching installed adapters get **Copy command**; custom configurations get **Copy request ID** and the app-owned handoff. Creating a request never pretends to launch work.

Link **Inspect evidence** from returned comparison records. Put manual comparison-ID lookup, full digests, frozen JSON and copyable identities under Details. If several comparisons exist, require an explicit selection. Complete evidence is not automatically a win or release approval.

Keep uncertain writes prominent: “We couldn't confirm this submission. Check its result before submitting again.” Make **Check result** primary. Keep exact retry, close, forget-text explanations and frozen payload accessible in recovery details. Missing replay text removes retry; forgetting text never means cancellation. Consent, incompatibility, stale state and blocking uncertainty must not disappear into generic advanced settings.

Separate success from failure presentation. For example, restore reconciliation currently sends “Restore confirmed” through the red error/alert slot in [Releases](../../../apps/console/src/components/bundle-releases.tsx).

## 5. Make setup useful to a new developer

App setup leads with **Install the SDK → Configure access → Run the delivery check**. Choose TypeScript or Python before showing its recipe. Expose only working examples. Keep actual bundle/channel scope, private-token handling and job pinning beside the relevant steps.

Put checkout packaging, optional reporting and cache/offline options in separate expandable sections. The delivery check stays explicitly model-free. Admins/operators get a real link to Connections filtered to this bundle/channel; other users get the request-a-credential explanation. A selected connection links back to App setup and preserves its filters.

Account leads with **Your user ID** and a working Copy ID action. Sign-in details can expand. Members explains how to get that ID and uses Add member or Save role according to the existing membership. Identity verification remains part of the access-change review.

Use short, role-aware empty states with one action: New bundle, Clear filters, Go to bundles, or Set up reporting. No delivery reports still means unknown delivery.

## Implementation order

| Pass | Bounded work | Ownership when implemented |
| --- | --- | --- |
| First | Single header/four tabs; readable task controls; explicit creation publication; Review release and separate reasons | Shell/layout owner; content owner; review owner |
| Next | Library/change rows; editor toolbar; scannable evidence; consistent recovery presentation | Same content/review owners; no shared-file edits by other lanes |
| Then | App setup/access copy and reciprocal links; keyboard/mobile/state polish | Setup/access owner; shared layout requests through its owner |

These can run in parallel after labels, header placement and control sizes are agreed. Content owns library/content/draft/import files; review owns changes/evaluation/releases; setup owns SDK setup/connections/account/members. One owner handles shared CSS, primitives, shell and scoped route chrome. Keep state and mutation contracts intact; sharing a layout does not require merging editor state machines.

Defer a new workspace-creation modal until it can avoid competing dirty forms. Do not introduce a new pending-form framework just for this polish pass. Also skip new themes, ornamental metrics, automatic promotion, hosted execution and new backend features.

## Acceptance

1. A newcomer knowingly creates and publishes a bundle, then edits, saves and manually releases a change without following an evaluation-labeled link.
2. The evaluated path reaches the actual app command/request handoff and evidence without typing internal IDs. No model runs from a setup/request click.
3. At 1440, 1024, 768 and 320–390px, and at 200% zoom: readable task text, reachable actions, no page-level horizontal overflow or obscured focus. Tabs may scroll deliberately; long paths remain available.
4. Keyboard users can search, rename, copy, change tabs, dismiss dialogs and return focus. Empty, loading, read-only and failed states remain usable.
5. Existing uncertainty, authorization, unsaved-work, compatibility, current-parent/revision/generation, evidence and pinned-job behavior still passes. Test both production and Vite development paths.

## Implementation evidence

The current build and typecheck pass, alongside 90 package tests and 111 console tests. Thirteen targeted browser scenarios passed all 63 steps, covering the new creation/manual-release/evaluation/setup/keyboard paths and failure recovery. Four Vite development scenarios passed all 20 steps. **The final complete suite passed all 141 behaviors, 183 scenarios and 873 steps, with no skips or failures.** Earlier selected runs remain separate evidence.

The responsive check captures widths 1440, 1024, 768, 390 and 320, plus CSS 200% scaling and real coarse-pointer contexts. The [native Chrome zoom check](../../../scripts/test_console_native_zoom.py) separately changes only its disposable profile's browser zoom, verifies doubled DPR and halved CSS viewport width, and checks 14 route surfaces and two dialogs at 640/320 CSS pixels. It captures actual viewport bitmaps through Chrome's protocol; it does not substitute CSS scaling for browser zoom.

Private evidence lives under `artifacts/remediation/`: `ui-final-browser/`, `ui-bdd-final.log`, `ui-acceptance.json`, `ui-targeted-browser/`, `ui-targeted-bdd-final.log`, `ui-dev-bdd.log`, `ui-native-zoom/summary.json`, `ui-native-zoom.log`, `ui-build.log`, `ui-typecheck-final.log`, `ui-tests-final.log` and `ui-live.log`. Earlier failing discovery runs are retained separately and are not acceptance evidence.

Review also repaired three existing recovery gaps: checking a saved snapshot preserves later browser reversions; reconciled suggestions preserve a later proposal form; and pending submissions remain visible across draft/review/release surfaces despite legacy storage-key ordering. Cross-page checks use the original operation route and preserve old envelopes. Issued secrets remain visible if recovery-metadata cleanup fails. Keyboard cancellation restores the invoking element, and touch sizing covers slotted dialog triggers.

The workspace-creation modal remains deliberately deferred. No backend product features or execution platform were added.
