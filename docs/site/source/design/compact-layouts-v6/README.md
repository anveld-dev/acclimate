# A desktop workspace with room to work

The [next desktop pass](../desktop-layouts-v7/README.md) refines long-name allocation and path wrapping while retaining this interaction system.

[Six generated layouts](comparison.html) · [Real screens](screens.html) · [Exact prompts](prompts.json) · [Interaction coverage](state-inventory.md)

We compared six desktop layouts: a tighter two-rail workbench, a top bar, a contextual sidebar, an optional collapsed rail, a right-side file map, and a focus mode. Six reviewers debated the actual images. Everyone picked **B’s top bar** first; their second choices differed. The [reviews](reviews/information.md) preserve those disagreements.

## The choice

Put workspace navigation in one labelled top bar. Keep bundle navigation below it and file navigation beside the source. This removes a permanent global rail without hiding frequent actions behind icons or another mode.

We took B’s hierarchy, with A’s quieter control density. Generated labels, paths and capabilities are suggestions, not product facts. The implementation retains the actual routes, file identities, saved-generation evaluation and deliberate release decisions.

The top bar scrolls with long pages; it does not reserve a permanent strip over the work.

The existing shadcn library supplies buttons, native selects, tooltips, menus, disclosures and dialogs. Account gets a compact presentation in the top bar. The same components and handlers still serve the mobile navigation sheet. No new UI dependency or execution feature is needed.

## Desktop tradeoff

A top bar spends some height to reclaim width. The workbench’s two scope bands are tighter, while text stays at least 14px. The working canvas can grow to 1760px on wide screens. Below 1180px, redundant navigation icons disappear while their labels stay visible. At 1000px and below, the existing navigation sheet takes over. Touch targets remain 44px.

The browser checks compare actual source area at 1024, 1440 and 1920px. They also cover the other pages, so editor gains cannot excuse broken workspace or admin navigation.

| Fine-pointer desktop width | Before: source width × height | After: source width × height | Area gained |
| --- | --- | --- | --- |
| 1024px | 598 × 544 | 774 × 516 | 22.8% |
| 1440px | 1006 × 676 | 1182 × 648 | 12.6% |
| 1920px | 1342 × 856 | 1502 × 828 | 8.3% |

At 1440px and 1920px, source starts 41px lower. At 1024px, the bundle header no longer wraps, so source starts 1px higher. This is a measured width/height tradeoff, not a claim that every dimension got smaller.

## Verification

Typecheck, production build and all 140 console tests pass. The final UI evidence includes **227 viewport captures**, plus ten repeated resize cycles with all 20 focus handoffs passing.

| Evidence | Result |
| --- | --- |
| [Desktop and overlay checks](../../../artifacts/layout6-desktop-accepted/summary.json) | 46 captures, 28 checks; three desktop widths, all eight pages, touch targets, editor/modal focus and closing behavior |
| [Expanded interactions and navigation](../../../artifacts/layout6-interactions-build3-summary.json) | 96 captures, 418 checks; menus, disclosures, forms, dialogs, tooltips and real native 200% zoom |
| [Responsive edges](../../../artifacts/layout6-edges-final-3/summary.json) | 27 captures; long names, narrow layouts, retained edits and resize focus |
| [Core flows](../../../artifacts/layout6-capture-accepted-2/summary.json) | 58 captures; editing, setup, evaluation handoff and deliberate release |
| [Repeated focus handoffs](../../../artifacts/layout6-desktop-focus-stress-build3/summary.json) | Ten immediate cycles in both directions, without screenshot settling or injected focus |

All accepted runtime evidence uses the same frozen build (`173687e7…`) with private PostgreSQL, identity fixtures and TLS. The local app is running at [localhost:3443](https://localhost:3443/w/acclimate/bundles). No paid model calls were made.

The [full behavior run](../../../artifacts/layout6-full-final-3/verified-summary.json) passes all **153 behaviors, 196 scenarios and 929 steps** across 17 features, with none failed or skipped. [Combined verification](../../../artifacts/layout6-verified-summary.json). The [coverage map](state-inventory.md) records narrower limits; these checks do not establish every rare failure or assistive-technology combination.

The first desktop baseline screenshots lagged the compositor after scrolling. They are superseded by `artifacts/layout6-desktop-baseline-2`: screenshots and before/after geometry now agree. The test waits for fonts, animations and compositor settlement, captures the native viewport, and checks that capture did not move it. No DOM state or focus is injected.
