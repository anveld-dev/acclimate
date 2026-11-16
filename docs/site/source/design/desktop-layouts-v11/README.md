# Library and change forms

[Six concepts](comparison.html) · [Actual screens](screens.html) · [Exact prompts](prompts.json) · [Interaction coverage](states.md)

Six reviewers compared stacked and split Changes lists, linear and split suggestion forms, and directory/inline creation versus cards/modals. They kept the existing library and inline creation. The useful changes were tighter task widths and readable, complete record details.

## What changed

**Changes index:** a 64rem working area brings records and their actions closer together. Open drafts remain scoped to the selected channel; suggestions still span all channels. Expanded details now align labels with full draft, base and snapshot IDs. Refresh, errors, disclosure state and pagination remain separate for the two lists.

**Suggestion form:** a 48rem working area includes its notices and recovery controls. Long editable paths and consent text wrap. The order stays hypothesis → editable paths → evidence → whole-bundle disclosure → explicit consent → request. Allowed paths limit edits; the provider still reads the whole selected parent bundle and authorized evidence. Private session memory stays with the app.

**Closed drafts:** the existing “Include published and discarded drafts” control could not work because the server requested only open drafts. The console now requests all statuses on each page and applies the existing local filter. If a loaded page has only closed drafts and older pages remain, it says that no open drafts are on the loaded pages and keeps Load more available.

These changes reuse the current shadcn Mira buttons, checkboxes, labels, fields, disclosures and dialogs. The detail layout shares the existing release-field rules. No new dependency or execution subsystem was added.

## What we kept and rejected

| Concept | Decision |
| --- | --- |
| A · Bounded stacked Changes | Borrow the working width and aligned details. Keep the two actual scopes and existing panels. |
| B · Split Changes queues | Reject narrow columns, duplicated scope labels and invented draft statuses. |
| C · Bounded linear suggestion | Borrow the form width. Keep recovery visible, with no fictional extra disclosures. |
| D · Editable-path side panel | Reject a new reading order, skinny path list, fake counters and provider setup controls. |
| E · Directory and inline creation | Retain the actual simple directory and focused inline form; skip the generated sidecar. |
| F · Cards and creation modal | Reject repeated card facts and stacked modal/import flows. |

Creating a bundle still publishes its initial content immediately, with the existing source preview, fixed compatibility target, explicit summary and import confirmation. Creating a draft and requesting a suggestion remain separate tasks.

## Review and evidence

All six accepted the final implementation after inspecting all six images, debating the other five and reviewing actual runtime evidence: [information hierarchy](reviews/library.md), [task journey](reviews/editor.md), [workflow integrity](reviews/review.md), [interaction](reviews/interaction.md), [visual system](reviews/visual.md), [skeptic](reviews/skeptic.md).

No material objection or request for another layout round remains.

## Verification

Typecheck, production build and **144 console tests** pass, including the scoped closed-draft pagination regression. The selected BDD run passes **20 scenarios and 94 steps**; the other 176 scenarios were not rerun.

| Current evidence on build `0f5464d8…` | Result |
| --- | --- |
| [Focused workflows](../../../artifacts/desktop11-workflows/accepted/summary.json) | 5 checks, 25 captures: library, all creation sources, import confirmation, true closed-first-page pagination, consent and write scope, read-only and actual Chrome 200% |
| [Coarse keyboard supplement](../../../artifacts/desktop11-workflows/coarse-proposal/summary.json) | Actual Tab/Space toggles path and consent on/off; wrapped touch labels meet 44px height without clipping. Three captures; no submission. |
| [Desktop and overlays](../../../artifacts/desktop11-desktop/summary.json) | 46 captures, 28 checks; existing editor width and broader navigation remain intact |
| [Core flows](../../../artifacts/desktop11-core/summary.json) | 58 captures, including editing, evaluation, release decisions and SDK setup |
| [Expanded interactions](../../../artifacts/desktop11-interactions/summary.json) | 54 captures, 202 checks across disclosures, forms and dialogs |
| [Selected behaviors](../../../artifacts/desktop11-bdd/results.json) | 20 scenarios and 94 steps pass; partial-suite scope remains explicit |

The focused run uses private PostgreSQL, real service APIs and OIDC/TLS. Existing records stay unchanged apart from one explicitly tested new bundle publication and one consented suggestion. Four localhost synthetic-provider requests establish returned states and the full-parent/read versus selected-path/write contract; no paid model calls were made. [Coverage limits and diagnostic notes](states.md) distinguish this from external provider or model-quality qualification.

[Combined verification](../../../artifacts/desktop11-verified-summary.json) records the final build fingerprint, runtime reports, reviewer decisions and live-service health.

Generated with built-in imagegen; the six PNGs are saved in [images](images/) and the exact prompt set is linked above. Both galleries are self-contained HTML.

[The holistic desktop comparison](../desktop-layouts-v12/README.md) tests two bolder shells and retains this implementation.
