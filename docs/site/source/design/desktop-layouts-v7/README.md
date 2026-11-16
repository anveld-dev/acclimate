# Make long identities fit

The [broader desktop pass](../desktop-layouts-v8/README.md) builds on this header work and refines the library, import task and evidence view.

[Six new concepts](comparison.html) · [Actual before/after](result.html) · [Prompts](prompts.json) · [State coverage](states.md)

The current desktop layout survived a fresh challenge. Six independent reviewers could reject every concept or request more rounds. We kept its navigation, task order and controls, then borrowed A/C’s idea: give bundle identity and channel/navigation their own flexible groups. No whole generated screen was copied.

Long names now get room instead of squeezing the title into a fixed 220px column. Short names still fit on one row. Paths prefer breaks after `/`, keeping directory names together when they fit. Their characters and copied values stay unchanged.

The implementation reuses the current shadcn Mira library: NativeSelect, Button, Dialog, Disclosure, Tooltip and the existing shared file helpers. No new dependency, picker, sidebar, sticky action bar or product state was added.

## What improved

In the matched 1024px coarse-pointer case, the draft source starts at **352px instead of 438px**. Published content moves from **381.3px to 295.3px**. Both reclaim **86px** without hiding the full bundle/channel names or shrinking type and targets.

The ordinary 1440px editor stays **1182 × 648px**, starting at **197px**. This pass improves the awkward case rather than spending ordinary working space.

## What we rejected

The balanced-column concept reserved too much channel space. A custom wrapped selector did not earn replacing the native control. The contextual sidebar buried files beneath parent navigation; the bottom bar added sticky/zoom costs and moved draft state away from the work. Reviewers disagreed about which sketch looked best, but judged the implemented result separately.

All six support the observed result, with no material objection remaining: [hierarchy](reviews/hierarchy.md), [workflow](reviews/workflow.md), [components](reviews/systems.md), [accessibility](reviews/accessibility.md), [evaluation](reviews/evaluation.md), [skeptic](reviews/skeptic.md). None requested another image round after inspecting it.

## Checks

Typecheck, production build and all **140 console tests** pass. [Combined verification](../../../artifacts/desktop7-verified-summary.json). The frozen build is `837fea…`.

| Current evidence | Result |
| --- | --- |
| [Desktop and open states](../../../artifacts/desktop7-desktop/summary.json) | 46 captures, 28 checks; eight pages, hover/focus/menus/dialogs and resize ownership |
| [Long identities and scope](../../../artifacts/desktop7-scope/summary.json) | 21 captures; fine/coarse desktop, all four bundle views, full identities and keyboard navigation |
| [Path wrapping](../../../artifacts/desktop7-scope/ordinary-rail/summary.json) | Exact text and slash boundaries verified; ordinary density unchanged |
| [Responsive edges](../../../artifacts/desktop7-edges/summary.json) | 27 captures; long names, retained edits, navigation and narrow layouts |
| [Core flows and native zoom](../../../artifacts/desktop7-core/summary.json) | 58 captures; native Chrome 200%, editing, setup and deliberate evaluation/release |
| [Expanded interactions](../../../artifacts/desktop7-interactions/summary.json) | 54 captures, 196 checks; disclosures, forms, local errors and decision facts |
| [Navigation behavior](../../../artifacts/desktop7-navigation-bdd/results.json) | 13 scenarios and 61 steps pass; this was a selected run |

Tests use private PostgreSQL, identity fixtures and TLS. No paid model calls were made. The [coverage notes](states.md) distinguish actual captures from unchanged source-reviewed behavior and remaining limits.
