# One interaction system

The [desktop layout pass](../compact-layouts-v6/README.md) supersedes this page’s desktop sidebar and geometry. Its shared interaction work remains in use.

This pass covers what happens after you open something: menus, disclosures, forms, dialogs, tooltips, validation and recovery. It builds on the [compact file workspace](../compact-layouts-v4/README.md).

[Six design boards](comparison.html) · [Browse real states](states.html) · [Exact prompts](prompts.json) · [Coverage map](state-inventory.md)

## The design choice

Six reviewers inspected all six imagegen boards and debated their differences. We kept D’s full decision facts and stacked phone actions, plus A/E’s compact utility forms. We rejected new drawers, inline settings that consume source space, invented navigation, mixed file/draft menus, and identities available only through tooltips.

All six approve the rendered changes with no material objections. Their [navigation](reviews/navigation.md), [editor](reviews/editor.md), [release](reviews/release.md), [admin](reviews/admin.md), [accessibility](reviews/accessibility.md) and [component-system](reviews/systems.md) reviews separate observed behavior from source-only limits.

## What changed

The existing shadcn library now handles contextual dialog width, wrapping actions, viewport gutters, bounded popovers and focus return. Utility forms stay compact; longer decisions get room for their full target and reason. Phone visual order matches keyboard order. Closing a controlled dialog returns to its invoking control, with a main-content fallback when that control is unavailable.

Menus have readable widths and 44px coarse-pointer targets. Form errors appear beside their fields. Draft import needs one disclosure, not two. New connection fields use the same grouping as other forms. Revoke and Restore show their exact targets; workspace IDs have persistent syntax help. Setup lists required settings once and puts extra private-directory guidance in details.

Mobile headings no longer collide with actions. A long workspace name has a secondary hover/focus tooltip on desktop and wraps visibly in touch navigation. Essential release facts remain visible in the dialog.

No new package, navigation structure or agent-execution feature was added. Desktop editing still starts at y156 with 1006px width; the earlier phone and zoom space gains remain.

## Evidence

Typecheck, production build and all 140 console tests pass. The final browser runs pass **181 captured states**:

| Suite | Captures | What it adds |
| --- | ---: | --- |
| [Core flows](../../../artifacts/layout5-capture-2/screenshots/summary.json) | 58 | Editing, setup, evaluation and deliberate release |
| [Responsive edges](../../../artifacts/layout5-edges-final/summary.json) | 27 | Long identities, resize focus, edit retention and guards |
| [Expanded interactions](../../../artifacts/layout5-states-final-inventory/summary.json) | 71 | Menus, local errors, dialogs, exact targets and short native zoom |
| [Navigation states](../../../artifacts/layout5-navigation-final-2/summary.json) | 25 | Hover/focus tooltips, account, creation, adoption review and persisted recovery |

The interaction and navigation suites include 418 passing assertions. Credential screenshots are masked. Native screenshots use the actual full Chrome compositor at 200% zoom; earlier incorrect crops are explicitly superseded.

The [full behavior suite](../../../artifacts/layout5-full-final/verified-summary.json) passes all 153 behaviors, 196 scenarios and 929 steps across 17 features, with none failed or skipped. [Verification notes](../../../artifacts/layout5-verification.md). The [coverage map](state-inventory.md) names unrendered branches, including rare service/storage failures and platform-native popup appearance. The local app uses PostgreSQL and Keycloak; disposable test fixtures make no paid model calls.
