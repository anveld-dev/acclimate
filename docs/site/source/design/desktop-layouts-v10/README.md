# Clearer search, review and release history

[Six generated concepts](comparison.html) · [Actual screens](screens.html) · [Prompts](prompts.json) · [Interaction coverage](states.md)

We tested six desktop directions with six reviewers. The current editor and navigation held up. The useful changes were smaller: one attached search control, less evaluation scaffolding, and a release history that keeps facts and actions closer together.

## What changed

**Published files:** the existing shadcn InputGroup joins search and submit. The shorter placeholder fits the file rail; the accessible description and hover/focus tooltip still explain that search covers paths and content. Typing stays local until Enter or Search submits it. Type filters, selected paths and Clear keep their existing URL behavior.

**Evaluation:** the setup disclosure already names the task, so its duplicate heading is gone. A new saved change goes straight to setup without an empty results panel. If older request pages remain, the no-matching-results explanation and Load older action still appear. Reported results, selected evidence, app-owned execution and deliberate release dialogs keep their existing behavior.

**Releases:** the existing records now sit within a 64rem working area. Expanded details align labels with their complete values, then stack on narrow screens. Reasons, full UTC timestamps, version identities, Inspect and Restore remain available. Restore still creates a new release through the existing confirmation.

Shared Mira controls provide the input, button, tooltip, disclosure and dialog behavior. The library's density rules now also cover InputGroup controls. No new dependency or product subsystem was added.

## What we rejected

| Direction | Decision |
| --- | --- |
| A · Sequential review | Borrow less repeated scaffolding; keep the current independent disclosures and order. |
| B · Secondary tools column | Reject: infrequent tools take width from paired evidence and file changes. |
| C · Bounded releases | Borrow the bounded reading area and aligned facts; keep actual stacked records. |
| D · Full-width ledger | Reject fixed columns that squeeze long reasons and identities. |
| E · Attached local search | Borrow the control association inside the existing file rail. |
| F · Search above workspace | Reject another horizontal band that separates filters from their file list. |

The generated images are exploration material. Their invented service-run evaluations, automatic releases, editable revision numbers, current-version Restore buttons, colored verdicts and published-entry mutations were rejected. None define the product contract.

## Review

All six accepted the final implementation after inspecting the generated images, debating the other five, and reviewing actual runtime captures: [task journey](reviews/editor.md), [information hierarchy](reviews/library.md), [workflow integrity](reviews/review.md), [interaction](reviews/interaction.md), [visual system](reviews/visual.md), [skeptic](reviews/skeptic.md).

No material objection or request for another layout round remains.

## Verification

Typecheck, production build and **143 console tests** pass. The current selected BDD run passes **20 scenarios and 94 steps**; the other 176 scenarios were not rerun.

| Evidence on final build `26b421e8…` | Result |
| --- | --- |
| [Focused workflows](../../../artifacts/desktop10-workflows/accepted/summary.json) | 5 checks, 39 captures: submitted search, rich release records, first evaluation, app handoff, selected evidence, dialogs and real pagination |
| [Native tooltip focus](../../../artifacts/desktop10-workflows/native-tooltip-focus/summary.json) | Tab opens help; Escape closes it while retaining focus. Three actual Chrome 200% captures. |
| [Desktop and overlays](../../../artifacts/desktop10-desktop/summary.json) | 46 captures, 28 checks across eight pages and desktop widths |
| [Core flows](../../../artifacts/desktop10-core/summary.json) | 58 captures, including editor, decisions, SDK setup and native zoom |
| [Expanded interactions](../../../artifacts/desktop10-interactions/summary.json) | 54 captures, 202 checks across forms, disclosures and dialogs |
| [Selected behavior run](../../../artifacts/desktop10-bdd/results.json) | 20 scenarios and 94 steps passed; partial-suite scope is explicit |

[Combined verification](../../../artifacts/desktop10-verified-summary.json) records the final build fingerprint, runtime evidence and live-service health. The focused runs leave saved content and release history unchanged. Synthetic comparison outcomes test the UI and provenance, not model quality. No paid model calls were made.

The final Search control measures 36×36px with a fine pointer and 44×44px with a coarse pointer, and stays inside its group at native 200%. [Coverage and diagnostic notes](states.md) distinguish accepted results from earlier failures and source-only review.

Generated with the built-in imagegen tool. All six PNGs are saved in [images](images/), with the exact [prompt set](prompts.json); the comparison and actual-screen galleries are self-contained HTML.

[The next library and change-form round](../desktop-layouts-v11/README.md) tightens task widths and fixes closed-draft discovery. This round remains the core search/evaluation/release decision record.
