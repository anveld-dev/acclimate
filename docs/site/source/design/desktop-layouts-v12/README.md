# Overall desktop navigation

[Six concepts](comparison.html) · [Measured comparison](results.html) · [Exact prompts](prompts.json) · [Experiment inputs](experiments/manifest.json) · [Current implementation](../desktop-layouts-v11/README.md)

This round challenges the whole desktop shell: workspace navigation, bundle/channel context, task commands and file selection. All six concepts use the same product tasks. Their invented entry commands, admin destinations and illustrated space claims are excluded.

## Independent views

Reviewers ranked the six images against the actual app before hearing the others' preferences. There was no common winner.

| Reviewer | Initial order, strongest first |
| --- | --- |
| [Information hierarchy](reviews/library.md) | D, C, B, A, current, E, F |
| [Task journey](reviews/editor.md) | current, A, E, B, C, D, F |
| [Workflow integrity](reviews/review.md) | current, A, C, B, E, F, D |
| [Interaction](reviews/interaction.md) | current, A, C, B, E, D, F |
| [Visual system](reviews/visual.md) | C, current, A, E, B, D, F |
| [Skeptic](reviews/skeptic.md) | current, A, B, D, C, E, F |

The disagreement produced a useful test. C gives labelled workspace navigation its own axis. D combines workspace, bundle and files in one rail, replacing the existing file rail rather than adding a third column. Both might gain source height. They also consume width or push frequent file controls below more navigation.

## What we measured

The real app is compared with isolated C and D style overlays. These use its existing shadcn controls, event handlers, API records and React tree. No nodes, content, focus or storage are moved or fabricated. Overlays are removed between modes.

- Matched desktop sizes, including short windows and a coarse pointer.
- Long workspace, bundle and channel names with 24 actual files.
- Source position, width and visible area; file search position, usable rows and scroll regions.
- Selecting files 3 and 20, search, kind filter, Add entry, Back, workspace navigation, Refresh and utilities.
- Real incomplete paired evidence and expanded file changes.
- Narrow and native 200% fallback, where the existing inline Files picker stays separate from the global navigation sheet.

The prototypes preserve the application's touch-target floor. A style-only helper gives the source its recovered header height, so the comparison does not strand that space as a blank gap. D's duplicate Account heading was removed before authoritative measurement.

These are geometry experiments, **not shipping qualification**. They do not establish a new sidebar's reading order, production focus model or accessibility. The 1024px retained-sidebar case is stress evidence, not a mandated shipping breakpoint. Native 200% falls back to the existing layout. Any rejected result applies to the tested variant, not every possible sidebar.

The application build remains `0f5464d8…`. The [frozen manifest](experiments/manifest.json) pins the exact prototype inputs separately from that build. Earlier pre-correction captures stay diagnostic.

## Decision: retain the current layout

All six reviewers accept keeping the current shadcn shell. The initial D-first and C-first reviewers changed their recommendations after inspecting the experiments; their original rankings and disagreements remain in their reviews. No production layout change is justified by this round.

| At 1440×900 | Current | C · labelled sidebar | D · combined rail |
| --- | ---: | ---: | ---: |
| Measured source width × height | 1182×648| 1002×655| 1134×738|
| Visible source area | 765,936px²| 656,310px²| 836,892px²|
| Initially visible complete file rows | 6 | 7 | 0 |

D's source gain is real: about 9.3% at900px height. Its file area gets only 108px, while its controls and three initial rows need 273px. Keeping the existing one-line workspace name and full-name Tooltip improves that to 160px; at 700px height it still reaches zero, and actual Search/type-filter clicks fail. This rejects the tested allocation, not every future combined rail.

C makes global navigation clearer and keeps evidence readable, but loses 180px of editor width. Its measured height gain depends on the experiment's source/utility-footer policy and is not the architecture's maximum possible gain. The reviewers did not find that trade worthwhile for frequent file work.

The current app keeps direct workspace destinations, a separate bundle/channel context and a persistent file list. The existing task-specific reading widths, controls and hidden-state behavior stay intact.

## Evidence and limits

[Findings](../../../artifacts/desktop12-experiment/findings.md) and [reconciled records](../../../artifacts/desktop12-experiment/reconciliation.json) index 58 captures: 36 main, 6 corrected visibility, 10 name-sensitivity/reach and 6 corrected narrow/zoom. All six narrow contracts and corrected menu/utility checks pass. Loaded incomplete evidence and expanded file changes remain readable in both alternatives.

Earlier detector mistakes—clipping a fixed element against its old ancestor, reading a now-hidden trigger after opening a modal, a wrong Sheet title and missing hidden-row bounds—are explicitly classified as harness artifacts. They are not evidence of product failures. Native click failures in D's zero-height rail are separate actual results.

Saved content, drafts, channel versions/promotions and evaluation records stay unchanged. The production build stays `0f5464d8…`; there were no saves, publications, provider calls or model calls during browser interaction. Prototype styles remain isolated under this directory and are not loaded by the application.

[Final verification](../../../artifacts/desktop12-verified-summary.json) records reviewer decisions, input fingerprints and live-service health.

Generated with built-in imagegen using the current draft screen as a [product/style reference](reference.json). All six PNGs are saved in [images](images/); both the exact prompts and individual reviews are linked above.
