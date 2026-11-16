# Product and workflow review

Status: workflow approved after inspecting final implementation capture 2; no material workflow objections remain.

## Evidence

Inspected actual `artifacts/layout3-capture-3/screenshots/desktop-draft.png`, `mobile390-draft.png`, `desktop-content.png`, `mobile390-content.png`, `native200-draft.png`, `desktop-saved-review-first-request.png`, and `desktop-library.png`, together with `draft-workspace.tsx`, `bundle-content.tsx`, `bundle-library.tsx`, `improvement-workspace.tsx`, `review-next-step.ts`, and the durable-drafts architecture contract. This is a product/workflow review, not a test run.

## First real issues

1. The draft screen contains two simultaneous truths: generation 1 is saved, and the browser contains later unsaved changes. They appear in one quiet status sentence while Review changes, Save draft, and Evaluate saved generation 1 occupy one desktop toolbar. The labels are truthful, but the target distinction requires careful reading. Dirty browser content should lead the status and Save should stay the primary action. Evaluation must continue to name the saved generation explicitly while browser content is dirty.
2. Published Content and the editable Draft use nearly identical file/editor chrome. The Content tab identifies a location but provides no visible Published cue. The hidden search label and download accessible name contain that distinction; a sighted operator should have it too. A small published-state cue at the existing content heading would help without a new introductory panel.
3. Mobile hides Review changes and saved-generation evaluation under the generic Draft actions button while Save remains direct. This is compact and honest, but a concept should improve action findability without adding another full-width action tier above the document. The file switcher and entry action row already consume substantial vertical space.
4. The library is already a clear bundle list with a single creation action. Preserve this restraint: the sparse example is not evidence that it needs metric cards, execution status, a new workflow system, or a more elaborate creation funnel.

## Required workflow invariants

- Review changes compares the bound published parent with current browser content. It is not a review of only saved generation 1.
- Save draft writes a new immutable snapshot and increments the durable generation. It does not publish or start a model evaluation.
- An evaluation link while dirty targets the exact last saved generation and snapshot. Do not shorten it to a bare Evaluate action or silently include the browser edits.
- Clean saved state may make Continue to evaluation primary. Preserve existing focus handoff from Save only when Save owned focus.
- The content service freezes configuration and records evidence; the installed app runs its evaluator. Never imply hosted execution, infer a live run from stale app reports, or invent outcomes.
- Published channel, bundle, and workspace scope remain discernible. Do not use a more compact switcher that silently drops scope.
- Base-changed, compatibility, pending-write, and related-operation warnings remain visible. Do not let a compact fixed-height container clip them.
- Retain explicit release review, the comparison binding, expected generation/revision checks, and the unevaluated reason path. Editing or publishing shared memory does not approve delivery.
- Keep 14px minimum readable text and 44px touch targets. Gain space from arrangement and repeated chrome, not compressed controls.

## Peer debate before concepts

Hierarchy, editor, visual, accessibility, and skeptic reviewers agree that the dirty browser state must be separate from the saved generation and that Save applies to the whole draft. Skeptic challenged whether a Published cue would add clutter; resolved recommendation is inline in existing metadata, with no new row or introductory card. Accessibility and visual reviewers identify merging mobile file selection with selected-entry identity as a promising way to recover vertical space while preserving target sizes. Any bottom workflow bar must prove its visibility in the actual long-document, phone-keyboard, and zoom layout; a concept cannot establish that.

## Concept review

Inspected all six actual PNG concepts (`images/a.png` through `images/f.png`), not only their prompts. Workflow ranking: **A > E > D > F > C > B**. No concept earns wholesale approval.

| Concept | Workflow assessment | Keep or reject |
| --- | --- | --- |
| A, Layered workbench | Best desktop continuity: draft-wide actions remain above the source, separate from entry actions; browser edits and saved evaluation target are explicit. | Keep scope separation and stronger dirty signal. Reject state segments that look like a new mode switch, unnecessary “older” wording, expanded folder-tree bulk, and always-exposed Remove. |
| E, File switcher canvas | Strongest narrow-layout donor: named Files control and visible selected identity share one band. Bundle-wide Save remains above it. | Adapt the shared band to phone/zoom; preserve persistent desktop rail. Reject overlaying source and the mockup's displaced source indentation. Keep exact file paths available. |
| D, Document with right collection | Draft actions and selected-entry operations remain distinct. | Right placement adds no workflow benefit and requires relearning file switching; do not move the rail merely for novelty. Reject exposed Remove. |
| F, Bottom workflow bar | Clearly distinguishes file actions from draft actions and explicitly names saved generation. | Reject moving dirty state and Save after the document. Initial source visibility does not establish reachability with long text, zoom, or the phone keyboard. The radio-like current/saved markers imply a nonexistent selectable state. |
| C, Single contextual rail | Bundle actions stay separate from selected-file actions. | Reject duplicate bundle navigation in both rail and header, file list buried below workspace/bundle navigation, and wrong generated file-kind claims. |
| B, Workspace top bar | More document width, but Save appears inside AGENTS.md's heading beside its kind. | Reject ambiguous file-scoped Save perception, hidden evaluation target behind an ellipsis, and global-navigation churn without demonstrated workflow gain. |

Recommended implementation: retain the existing desktop workbench and top draft-wide workflow, adapt E's shared file-selector/identity band only where the rail is collapsed, emphasize plain Unsaved changes before Saved generation 1, and group secondary published-content actions without adding another row. This is a bounded hybrid based on actual concepts and actual baseline weaknesses, not a copy of an image.

Peer debate: editor and hierarchy reviewers independently reject B's Save placement, C's duplicated navigation, and F's detached workflow state. They favor E's narrow combined band and A's existing top workflow structure. Accessibility and visual reviewers must assess the actual 44px controls, long paths, and source visibility; the PNGs cannot prove these.

## Rendered-UI approval

**Approved for capture 1.** Inspected actual `artifacts/layout4-capture-1/screenshots` images: desktop Draft/Content, phone Draft/Content, 320px clean Draft and long scope/path, native 200% Draft, expanded Files, Draft actions menu, saved-review first request, and both evidence-backed and unevaluated release dialogs. Also read their geometry and capture summary (`passed: true`, 58 states). These are actual rendered UI observations, not concept approval.

- Save stays above the source in the draft-wide toolbar. The dirty Draft actions menu still says Evaluate saved generation 1. Clean state directly offers Continue to evaluation. No generated execution or publication action was introduced into editing.
- Published is visible inline beside the selected content identity. Edit entry remains direct; Copy/Download are secondary under a named Actions control. The file-selector band saves space without merging whole-draft Save into entry operations.
- Selected-file identity and full long path remain visible. Expanding Files exposes search/type/add and actual entries; it does not replace the editor with a new workflow system.
- Desktop editor remains at y156 and width1006. Capture geometry reports phone Content y227.7 and native-200% Draft y205. The workflow benefit is less intervening chrome while preserving the real state and action targets.
- Saved review still says the evaluation runs in your app. Both release dialogs still identify the bundle, stable channel/revision, published parent, candidate/generation, and either selected evidence or the explicit unevaluated reason. The irreversible decision remains a distinct confirmation.

The narrow Files (4) label wraps and the selected-entry menu shortens to Actions. Their placement and named controls retain understandable scope; these are not workflow blockers. Review is limited to the observed UI and source; no app edits, builds, or tests were run by this reviewer. Root owns behavioral verification and the full BDD run.


## Final capture 2 re-check

**Approved.** Inspected the actual capture 2 phone Draft/Content, native-200% Draft/Content, phone Draft actions, 320px clean Draft, and 320px long scope/path images. The final Files label fits on one line. At 390px the selected-file controls now share one band; whole-draft Save remains in the separate toolbar above it. The dirty menu still names Evaluate saved generation 1, clean state still offers Continue to evaluation, and the published view visibly labels Published beside the selected entry with Edit entry direct. The long selected path wraps in full and the source remains readable.

Capture 2 geometry reports phone Draft source y288.4, phone Content y227.7, and native-200% Draft y205. Its main capture summary passes all 58 states. No new workflow objection arose from the final spacing/path changes. The earlier capture 1 approval of app-owned evaluation and release confirmations remains applicable because those flows were unchanged. No app edits or retests were performed by this reviewer; the full BDD run was still owned by root at this re-check.
