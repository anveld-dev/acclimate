# Compact layout exploration

This first pass is historical. See the [second pass](../compact-layouts-v2/README.md) for the compact shell/editor and the [third pass](../compact-layouts-v3/README.md) for review and SDK setup.

The old draft screen starts its text editor around 655px down. The redesign should make editing the main event, with readable controls and less repeated context.

Six imagegen concepts are available in [the comparison](comparison.html). The [prompt set](prompts.json) records how they were generated with the built-in image tool.

| Concept | Useful part | Main drawback |
| --- | --- | --- |
| A · Unified editor | Clear scope hierarchy and compact draft bar | Generated image duplicates Add entry |
| B · Top navigation | Gives the editor more width | Requires a wider global navigation change |
| C · Document focus | Useful file picker on narrow screens | Hides file structure as a desktop default |
| D · Review inspector | Makes snapshot provenance clear | Permanent inspector takes too much editing width |
| E · Combined navigation | Uses one left column | Mixes app, bundle and file navigation |
| F · Workbench | Groups authoring and footer utilities | Generated image repeats context and Review changes |

## Direction

Four reviewers ranked A first; two preferred B. All accept A’s hierarchy with F’s unified workbench if the implementation meets the width and responsive constraints below. We keep the labeled app sidebar, tighten it, and collapse it earlier. We borrow C’s on-demand file navigation only on narrow screens.

The implementation keeps raw Markdown editing. Rendered prose, invented counts and duplicate controls in generated images are not product requirements.

- One compact bundle/channel row and one set of view tabs.
- One draft status/action bar. Add entry belongs with files; Review changes appears once.
- A compact selected-file header with the full path and labeled Entry actions.
- Import, history and metadata stay in named secondary controls.
- Saved: Continue to evaluation is primary. Dirty: Save draft is primary, with Evaluate saved generation N as a secondary guarded route.
- Pending outcomes, compatibility blockers and recovery actions stay visible when relevant.

## Acceptance

At 1440×900, text should start above 300px, with at least 650px editor width and 360px usable height. Keep 14px desktop editor text, 32–36px desktop controls and 44px touch targets. Touch editors use 16px text. Four baseline files should be visible without scrolling the file pane.

At 200% zoom and 390px touch width, navigation and file selection remain reachable without horizontal page scrolling. Full paths must be available without hover. Keyboard flow, dirty guards, saved-snapshot evaluation, explicit publication review and uncertain-operation recovery remain intact.

The same compact bundle context applies to evaluation, releases and app setup. Setup still exposes ownership, language, installation prerequisites, private credentials and the delivery-check command.

## Review result

All six reviewers approved the implemented layout after inspecting populated desktop, mobile and 200% zoom pages. Hierarchy, editor usability, workflow, accessibility, visual design and skeptical newcomer review found no remaining material design objections. The two reviewers who preferred B accepted A+F after seeing the actual editing space.

The measured desktop editor starts at 252px, with 966px width and 608px height. The reference started around 655px. Four entries remain visible in the file pane. Keyboard checks exercised selection, renaming, editing, saving and navigation to evaluation against persisted data.

Touch-target checks also cover navigation, SDK links and the multiple-workspace selector. The validation reports distinguish screenshot-harness corrections from product CSS fixes.

## Verification

The [before/after gallery](results.html) shows the implemented desktop, phone and 200% zoom layouts. These are real pages backed by disposable PostgreSQL fixtures, not mock screens. The user's workspace was left alone.

- Typecheck, production build and all 134 console tests pass.
- [Layout checks](../../../artifacts/compact-capture-11/screenshots/summary.json) pass across eight routes and 26 captured states, including touch targets, tab clipping and keyboard editing.
- [Runtime checks](../../../artifacts/compact-runtime.json) confirm the local app, its built assets and anonymous sign-in screen load.
- The [clean full behavior run](../../../artifacts/compact-full-final/README.md) passes all 153 behaviors, 196 scenarios and 929 steps, with none skipped.

The first full run caught stale status assertions and a real Members-page bug: refreshing access erased a successful update message. The fix keeps that acknowledgment for the same verified user and workspace while clearing it on identity changes or denied access. Targeted recovery and membership reruns pass. The original failing run remains in the artifacts.

No paid model calls or upstream research scripts were run. These checks cover the local production build and disposable test stack; they don't establish hosted deployment capacity or general accessibility conformance.
