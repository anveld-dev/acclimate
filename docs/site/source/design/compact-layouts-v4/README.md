# Compact file workspace

See the [fifth pass](../compact-layouts-v5/README.md) for the expanded interaction and shared-component system.

Six new imagegen concepts explore the same draft through different layouts. We kept the desktop workbench and borrowed the narrow file-switcher band. The [previous round](../compact-layouts-v3/README.md) still describes the review and setup pages.

[Compare concepts](comparison.html) · [Before and after](results.html) · [Exact prompts](prompts.json)

| Concept | Useful idea | What we rejected |
| --- | --- | --- |
| A · Layered workbench | Clear workspace, draft and file scopes | Oversized tree, extra state pills and exposed Remove |
| B · Workspace top bar | More document width | Two navigation bands, hidden evaluation target, file-scoped appearance of Save |
| C · Contextual rail | One place to browse | Repeated bundle navigation and files buried below navigation |
| D · Right collection | Document emphasis | Reversed file-to-document scan without a useful space gain |
| E · File switcher | Files and selected identity share a narrow band | Hidden desktop rail and a popup covering source |
| F · Bottom workflow | Higher source start | Draft status and Save too far from the initial task context |

These are built-in imagegen sketches. Their invented controls, missing actions and state styling were reviewed rather than copied.

## What changed

On narrow screens, the named Files control shares the selected-entry band. Opening it puts the file list in normal flow; it never covers source. Selection, collapse and resizing retain the existing focus behavior and browser edits. Repeated file counts are gone.

Published content keeps Edit entry visible. Copy and Download live in a shadcn Actions popover, with keyboard access, copy-failure feedback and focus return. Published state is visible beside the file name. Draft Save remains outside file actions, and evaluation still names the exact saved generation.

Menu and the parent destination have visible labels on phones. Full selected paths remain readable; directory labels can wrap instead of relying on hover. At 320px, some labels still wrap to preserve text and touch targets.

## Measured space

These are source-box positions from the same disposable fixture, with initial scroll reset. Smaller top values mean more content is visible.

| Surface | Before | After |
| --- | ---: | ---: |
| Desktop draft | 156px | 156px |
| 390px phone draft | 333px | 288px |
| 320px phone draft | 369px | 350px |
| Native 200% draft | 243px | 205px |
| 390px published content | 330px | 228px |
| Native 200% published content | 198px | 156px |

Desktop source width stays 1006px. At native 200%, the initial draft source box grows from 85px to 123px visible height. Text stays at least 14px; coarse-pointer controls stay at least 44px. [Exact geometry](../../../artifacts/layout4-geometry.json).

## Independent review

All six reviewers inspected every generated image, debated each other, then approved the actual responsive implementation with no material objections. Rankings differed; the narrow hybrid earned agreement.

- [Hierarchy](reviews/hierarchy.md)
- [Editor](reviews/editor.md)
- [Accessibility](reviews/accessibility.md)
- [Workflow](reviews/workflow.md)
- [Visual design](reviews/visual.md)
- [Skeptical newcomer](reviews/skeptic.md)

## Validation

Typecheck, production build and all 140 console tests pass. The [main suite](../../../artifacts/layout4-capture-2/screenshots/summary.json) passes 58 states; the [edge suite](../../../artifacts/layout4-edges-final/summary.json) adds 27. Checks cover keyboard file selection, resizing, edit retention, guarded navigation, actual clipboard denial, downloaded-byte equality, long paths and native zoom. The [full behavior suite](../../../artifacts/layout4-full-final/verified-summary.json) passes all 153 behaviors, 196 scenarios and 929 steps across 17 features, with none failed or skipped. [Verification notes](../../../artifacts/layout4-verification.md).

The local app uses PostgreSQL and Keycloak. Tests use disposable PostgreSQL with fixture identity/model providers. No paid agent-model calls ran.
