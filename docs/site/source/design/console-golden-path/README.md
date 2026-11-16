# Console cleanup and golden paths

[Latest pass: headers, members and Keycloakify sign-in](headers-members-auth.md)

[AgentRun findings](../../research/console-golden-path/agentrun.md) · [RRSI findings](../../research/console-golden-path/rrsi.md) · [Syntax library research](../../research/console-golden-path/syntax.md)

The console should help people edit content, check a change, and ship it. Setup should get an application fetching that content without asking it to adopt another agent runtime.

## What changed

- Back has its own line above the bundle title. Tabs stay below the title and channel.
- File-type filters are gone. Search and the folder tree remain; counts live at the rail bottom.
- Add and Import share the file toolbar as named icon actions. Draft metadata and snapshot history open from Details.
- Shiki highlights source, snippets, JSON, version previews and diffs. CodeMirror 6 handles real editing, selection and undo. Large or unknown sources remain readable without highlighting.
- App setup leads with install, private access and a short working delivery check. Optional reporting has its own complete example.
- Changes uses compact queues; Releases leads with the current revision and reason. Technical IDs stay in details.

## What the references actually support

AgentRun favors contextual handoffs and readable changes. Its frontend is useful evidence for hierarchy, but it still uses plain editors in several places. Syntax highlighting is our improvement, not an upstream parity claim.

RRSI is a research loop rather than a web UI. Its useful sequence is hypothesis → bounded edit → measurement → keep or accept. A completed evaluation is not automatically an accepted change or a production release. We keep app-owned execution and explicit publication.

SDK distribution still uses a source-built tarball or wheel. The setup page says that plainly; it does not imply npm or PyPI publication.

## Verification

The browser checks cover real service records, native input, dialogs, copy and saved bytes. The editor’s public read-only handle lets host integrations and tests read full virtualized documents without scraping partial visible lines. Saves are checked against the service payload.

The frozen build passed typechecking, the production build and all 176 console tests. Browser evidence from that same build:

| Check | Result |
| --- | --- |
| [Source and SDK checks](../../../artifacts/golden-path-v3-focused/summary.json) | Exact copy/save bytes, native paste and undo, safe highlighting, and both copied TypeScript/Python delivery recipes run against the service. |
| [Desktop layouts](../../../artifacts/golden-path-v3-desktop/summary.json) | 46 captured states across 1024, 1440 and 1920px; keyboard, coarse-pointer controls and overlays. |
| [Interaction states](../../../artifacts/golden-path-v3-interactions/summary.json) | 54 captured states, including menus, tooltips, dialogs, validation and narrow layouts. |
| [Core workflows and zoom](../../../artifacts/golden-path-v3-core/summary.json) | 58 states; actual 200% browser zoom, long names, file navigation, release review and setup. |
| [Example workspace](../../../artifacts/golden-path-v3-examples-retry/summary.json) | 14 views of persisted application data, including both setup recipes. |

[Selected BDD results](../../../artifacts/golden-path-v3-bdd-retry/consolidated.md) account for 61 browser scenarios across the original run and a seven-case final rerun. All five original failures pass after updating checks for the changed UI. The report keeps both runs and their build hashes; it does not claim the full 198-scenario suite ran.

The service checks use disposable PostgreSQL and real OIDC sign-in. Example workspace screenshots are read-only. Simulated evaluation records are labeled as examples; none of these checks call a model. Upstream scripts and tests were not run. These checks do not establish broad assistive-technology or IME compatibility.
