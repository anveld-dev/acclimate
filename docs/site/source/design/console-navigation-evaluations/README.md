# Navigation and evaluation workspace

[Evaluation review](review-evaluation.md)

The desktop shell uses a 64px icon rail. Main destinations sit at the top, Workspaces sits near the bottom, and Account is last. Hover or keyboard focus shows each icon’s name. The workspace menu includes the current selection and workspace creation. Narrow screens retain the labeled navigation sheet.

Bundle headers have two bands: Back, title and channel first; tabs second. The channel uses the shared shadcn Select, with the existing guarded navigation rules.

Evaluations pair a compact run history with selected evidence. Setup and app handoff remain available without burying the result in configuration text. The service records requests and results; the application still runs its evaluator.

The reward chart compares observed means over the same scored, gradeable pairs. Valid graded task failures stay included. Missing grades, execution failures, denominator and reported cost stay visible; incomplete evidence is explicitly partial. Rewards can be negative or larger than one, so the chart uses a signed reward axis rather than a percentage.

The original layout review used three bundles, four drafts, six evaluation requests and four bound comparisons. The archived captures identify their simulated inputs.

All new surfaces reuse the existing shadcn components. The shared [file tree](../file-tree/README.md), pending-write recovery, release gates and account behavior remain in place.

The integrated code passes typecheck and all 163 console tests, including 10 checks for signed rewards, zero scores, missing data and gradeable task failures. The selected navigation/access BDD run passes 20 scenarios and 97 steps. It covers the icon tooltips, bottom controls, workspace guards and channel selection with real keyboard and pointer input.

Example-data captures cover improved, regressed, incomplete, zero-score task failure and no-selected-evidence states, plus content, changes, workspace selection and account details. All simulated evidence stays labeled. Final build `f62d9ff8…` passes all three browser suites: 46 desktop states, 58 compact/touch/native-zoom states and 54 interaction states. The same 20 BDD scenarios and 97 steps pass again on that build. The source editor retains a 640px desktop height floor; narrow spacing gives 116px of initial source visibility at actual 200% browser zoom without shrinking targets or text.

[Verification](verification.json) · [Desktop](../../../artifacts/navigation-evaluation-verified-desktop/summary.json) · [Touch and zoom](../../../artifacts/navigation-evaluation-verified-core/summary.json) · [Menus and dialogs](../../../artifacts/navigation-evaluation-verified-interactions/summary.json) · [BDD](../../../artifacts/navigation-evaluation-verified-bdd/coverage.md) · [Populated example screens](../../../artifacts/production-redesign-final-examples/summary.json)

The example screenshots pin the preceding build; the last change only tightens narrow-screen spacing. Earlier diagnostic failures were resolved: the narrow tab gap and source spacing were fixed; tooltip/dialog tests now wait for actual closing/unmount and native autofocus before changing input modes. Comparison tests wait for the selected result and use a genuinely different candidate to verify the mismatch gate. No claim of broad assistive-technology or provider-quality qualification is made.


Refresh buttons have been removed. Read-only pages update in the background every 15 seconds and when the window regains focus. Reads pause while the page is hidden, a control is being edited, a dialog is open, or the reader has scrolled down. Draft editors keep their local text; draft/suggestion lists and evaluation status use their own background reads.
