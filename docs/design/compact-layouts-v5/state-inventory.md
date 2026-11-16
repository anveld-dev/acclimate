# Interaction coverage

We audited every control family used by the app, including closed, open, hover, focus, disabled, validation and recovery paths. The six [reviews](README.md#the-design-choice) retain the page-level source inventories. Installed components that the app does not use are not missing product states.

The 181 captures are representative rendered states, not every possible combination of permissions, data and network failures. The full BDD suite supplies separate behavior evidence.

| Area | Rendered or exercised | Source-only or narrower limits |
| --- | --- | --- |
| Navigation | Closed/open Sheet, route selection, resize focus, full long touch name | Every role/search/no-channel combination was not newly rendered |
| Tooltip | Singleton name closed, pointer hover, keyboard focus, Escape | No tooltip is the only source of decision facts |
| Account | Menu, identity details, clipboard denial, Escape return, native zoom top/bottom | Every sign-out failure response was not visually replayed |
| Published files | Closed/open picker, hover/focused Actions, copy denial, exact download bytes | Native file-download UI appearance is platform-owned |
| Draft actions | Saved/current distinction, open menu, guarded navigation, retained edits | Prehydration timing and every pending-operation race remain separate tests/source review |
| Entry settings | Local package error with field association, kind changes, menu sizing, bounded form | Last-entry removal and every vanished-invoker success path lack a new screenshot |
| Import/history/details | Single import disclosure, expanded history/details; creation file/JSON previews | Every import byte/schema error and native file chooser appearance was not rendered |
| Setup | Language controls, private settings, recipes, IDs, copy actions, optional details | Browser-native title hints are not claimed as screenshot evidence |
| Evaluation | Requested/running handoff, incomplete/unbound or mismatched evidence, disabled release | New horizontal-table keyboard/AT qualification and live-model quality are outside this pass |
| Release | Evidenced/manual decisions, full identity/reason, Restore, Escape return, phone and short zoom | Every foreign/forgotten/closed operation and network-fault visual permutation was not replayed |
| Connections | New/selected app, precise revoke review, masked one-time secret, field grouping, focus return | Rare permission/expiry/storage failures remain source-reviewed or existing BDD cases |
| Members | Lookup error, verified identity, role/removal controls, last-admin explanation, focus return | Every concurrent membership/permission change was not visually replayed |
| Workspace/bundle creation | ID syntax, all source choices, preview/settings, adoption review, real persisted creation | Adoption was reviewed without submitting it; every backend adoption outcome was not executed |
| Recovery | App-written pending creation, reload retention, forgotten body, close, exact single publication | Exact retry execution and all storage-failure permutations are explicitly unexecuted here |

## Proof boundaries

[Expanded interaction inventory](../../../artifacts/layout5-states-final-inventory/summary.json): 71 states and 287 passing assertions. [Navigation inventory](../../../artifacts/layout5-navigation-final-2/README.md): 25 states and 131 passing assertions. Core and edge suites add 85 captures.

All new states run through the real app with disposable PostgreSQL, service, identity fixtures and TLS. Screenshot masking protects even fixture credentials. Tests do not inject application focus or DOM state to manufacture success.

The first expanded-state native images were cropped incorrectly. Final native evidence comes only from `layout5-states-final-native-2`, `layout5-navigation-final-2` and the core native captures. Their CSS viewport, device-pixel ratio and physical PNG dimensions are checked together.
