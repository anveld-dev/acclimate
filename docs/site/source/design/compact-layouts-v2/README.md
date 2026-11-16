# Compact layout, second pass

See the [third pass](../compact-layouts-v3/README.md) for the newer review and SDK setup work.

This round starts from the current shadcn app. The goal is more useful space and clearer task scope, while keeping readable text and real controls.

Six fresh images were generated with the built-in imagegen tool. [Compare the concepts](comparison.html), [read the exact prompts](prompts.json), or open the [saved images](images/).

| Concept | What we keep | What we leave out |
| --- | --- | --- |
| A · Integrated scope | One bundle header, clear bundle/file action boundary | A compulsory single row at every width |
| B · App bar | More working width as a useful comparison | A second global navigation redesign |
| C · Contextual left column | Clear group labels | Bundle links pushing files down the page |
| D · Document focus | Named Files picker on narrow screens | Hiding the desktop file map by default |
| E · Review inspector | An explicit comparison baseline | Permanent inspector and its incorrect saved-vs-browser label |
| F · Inline collection | Simple collection rows for directory pages | File selection tied to the length of the open document |

## The debate

All six reviewers ranked A first. They challenged each other directly on navigation scope, action discovery, saved-state truth, touch sizing and file access. The individual notes retain their disagreements and acceptance criteria:

- [Hierarchy](reviews/hierarchy.md)
- [Editor](reviews/editor.md)
- [Workflow](reviews/workflow.md)
- [Accessibility](reviews/accessibility.md)
- [Visual design](reviews/visual.md)
- [Skeptical newcomer](reviews/skeptic.md)

The most useful correction came from the editor and workflow reviewers: the existing diff compares the published parent with current browser content. E's generated “saved draft versus browser draft” label is wrong. We preserve the real comparison and name it clearly.

## What changes

The app keeps its labeled sidebar. Bundle identity, channel, view links, parent return and refresh share one scope region. It wraps on narrow screens instead of shrinking the text or truncating long names into unreadable columns.

The draft keeps one state/action bar. Save is primary while editing; Continue to evaluation becomes primary once saved. Narrow layouts use a named Draft actions menu for secondary actions, including the exact saved generation when evaluating older content. Raw Markdown, full selected paths and entry actions stay separate from bundle-wide actions.

Files remain visible on desktop and use a picker on narrow screens. Selecting a file closes that picker and restores focus after the selection commits. A blocked navigation or a rename inside a dialog doesn't count as a file choice.

Evaluation results come before another request's setup. Reported evidence is prominent after selection; manual release remains a separate, reason-required decision. The app still runs its own evaluator. This layout does not introduce hosted execution, new grading behavior or invented results.

Directory pages use compact real rows. Setup keeps the concrete install, access and delivery-check steps, with optional details nearby. The shared shadcn controls, readable 14px task text, 16px touch editor and 44px touch targets remain the base.

## Validation

All six independent reviewers approve the implemented design with no remaining material objections. Their notes include the actual desktop, phone, zoom, selected-evidence and release-dialog review, rather than approval based on the generated images alone.

The [before/after gallery](results.html) shows real persisted fixtures. Desktop editing starts at y156 with 1006px width, compared with y252 and 966px before. The 390px phone editor starts at y333, compared with y444. At native 200% zoom, the source is visible in the initial viewport with document and editor scroll offsets at zero.

Typecheck, the production build and all 134 console tests pass. The 27-state [extended edge suite](../../../artifacts/layout2-edges-final/summary.json) passes long bundle/path/channel values at six widths, responsive keyboard focus, multi-file edit retention, both Save focus handoffs and guarded saved-generation navigation. The [clean full behavior run](../../../artifacts/layout2-full-final/verified-summary.json) passes all 153 behaviors, 196 scenarios and 929 steps, with none skipped. The [main layout suite](../../../artifacts/layout2-capture-final-2/screenshots/summary.json) adds 35 states, for 62 captured states across the two suites. [Full verification notes](../../../artifacts/layout2-verification.md) retain earlier failures and fixes.

The app keeps PostgreSQL, Keycloak and real persisted content. Layout fixtures use disposable databases and fixture identity/model providers; they don't claim hosted capacity, live-provider qualification or model quality. No paid agent-model calls ran.
