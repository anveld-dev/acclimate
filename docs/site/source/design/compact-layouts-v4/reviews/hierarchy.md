# Information architecture review

Status: baseline audited; awaiting actual A–F concept PNGs. No concept ranking or implementation approval yet.

## Evidence inspected

Actual captures: `artifacts/layout3-capture-3/screenshots/{desktop,mobile390}-{content,draft,library}.png`. Source: `bundle-content.tsx`, `draft-workspace.tsx`, `bundle-library.tsx`, and `file-navigator.tsx`.

## Baseline findings

Material:

- Dirty saved drafts have two distinct objects: current browser content and saved generation 1. The status puts both in one low-emphasis sentence. Review changes compares browser content; Evaluate saved generation 1 targets the saved snapshot. Save is correctly primary while dirty. Preserve those targets and improve their legibility without implying execution happened.
- Mobile published-content heading takes three action rows and pushes the first content line to about y350 (body starts y330). The dirty draft is already more economical, with content body near y342. A shared hierarchy should make entry identity, state, and one primary task clear before secondary actions.
- Published Content and editable Draft use near-identical content chrome; a visible Published cue would make the mode easier to recognize.
- Mobile Files disclosure followed by a separate selected-entry heading repeats the selection context. At short effective viewports this fixed stack is expensive. Combining the picker trigger with selected identity is promising if it keeps a full recoverable path, count, type, entry actions, and a 44px target.
- Draft navigator says both Files (4) and 4 entries before the list. Remove repeated count, retaining a useful filtered result count. Draft search is live path filtering; published search explicitly submits path-or-text. Do not unify labels or controls in a way that lies about scope.

Optional:

- Root instruction directory is `/` in drafts and `Instructions` in published content. A consistent meaningful label reduces interpretation.
- Nested file paths truncate in the rail. Selected full path is already available; keep it recoverable. Replacing entries with basename-only tabs would worsen disambiguation.
- Sidebar cosmetics and the sparse one-bundle library do not establish material problems. A dashboard, invented metrics, or agent activity would add noise.

## Constraints for concepts and implementation

Desktop draft editor already starts at y156 and offers about 1006px width at 1440px viewport. A different navigation structure must earn its cost. Use readable 14px minimum text and at least 44px touch targets. Preserve shadcn interactions, dirty-route protection, accessible file selection, real state semantics, and full path recovery.

## Proposed measurable acceptance

1. At desktop 1440px, editor top does not move below baseline y156 without a demonstrated task benefit; retain at least baseline editor width or justify any loss.
2. At 390px and 320px, current entry, browser dirty state, and primary Save are visible with no horizontal page overflow. Secondary action labels identify scope; no ambiguous Evaluate-current implication.
3. Mobile published-content text starts materially earlier than y330, using grouping/removal of repetition rather than small type or targets.
4. At effective 640×328 (200% zoom), initial editor shows more usable text than baseline roughly 85px while ordinary page scrolling remains available.
5. Search results retain total context, full selected paths remain available, and a filtered-out selected entry is not presented as a matching result.
6. A saved generation never appears updated until a successful save, and no simulated evaluation/agent execution or results appear.

## Peer debate received

- Editor: retain search scope and full selected paths; compact basename tabs can lose identity. Current filtered-out selected draft entry remains visible, requiring careful communication.
- Accessibility: at effective 640×328, the four-layer scope/status/files/entry stack leaves about 85px of initial editor. Merge semantic duplication rather than shrink controls. The clean 320px evaluation CTA also wraps substantially.
- Workflow: Review changes compares browser text; Evaluate targets saved generation. Published mode deserves a visible cue, and saving is separate from channel release/execution.

Additional baseline images inspected: `native200-draft.png`, `mobile320-draft.png`, and `mobile390-draft-files.png`. The expanded mobile picker repeats the count three times (disclosure Files (4), internal Files (4), and 4 entries), so count duplication is materially expensive in that state. At 320px clean state, Continue to evaluation wraps to two lines. Native 200% confirms the initial editor body begins around CSS y248 in a 328px-high viewport. These are stronger compactness targets than restyling the desktop sidebar.

## Actual six-image review

I directly inspected all six actual PNGs (`a.png` through `f.png`); E and F were opened separately after the first tool response's image limit. These judgments concern the pixels, not just their prompts. None earns wholesale implementation approval.

| Desktop composition rank | Concept | Useful evidence | Material objection |
| --- | --- | --- | --- |
| 1 | A | Familiar separate workspace/file scopes; browser-versus-saved distinction and exact saved evaluation target visible | Browser/saved pills resemble an interactive view switch; “older” is unsupported. Tree adds depth for four entries, Add entry omitted, destructive actions unnecessarily expanded. |
| 2 | D | Draft-wide state and actions stay distinct from file actions | Right file rail moves selection across the source without demonstrated benefit. Add entry omitted. No reason to adopt this relocation. |
| 3 | B | Wider source from removing global rail; plain file list remains understandable | Two global header bands consume height. Draft-wide Save/review are embedded beside file identity and editable kind, making their scope ambiguous. Evaluate hidden under unlabeled ellipsis. |
| 4 | E | Files trigger and selected filename share one band, a strong narrow-layout extraction | Desktop hidden list adds a switch step; open popup masks source and repeats Files count. Add omitted; source has artificial blank left gutter. |
| 5 | F | Text begins higher; file actions and draft actions have separate locations | Dirty state and Save are detached at the bottom, after source in reading order. No short-viewport/keyboard evidence earns that trade. |
| 6 | C | A single broad rail can make the editor wide | Actual image duplicates bundle views in top and side navigation, repeats bundle name, pushes file search deep below global navigation, and mislabels support-file type. |

This is a desktop-composition ranking. E is first for a bounded responsive principle. A is first only as a familiar skeleton, not as a literal target.

## Bounded hybrid recommendation

Keep the existing desktop workspace and file rails. Borrow A's clear distinction between current browser edits and saved generation as plain truthful status text, without segmented controls, “older,” or an extra status row. Keep Save primary while dirty and keep Evaluate saved generation 1 exact wherever exposed. Keep entry operations in the existing named Entry actions dialog.

Below the current narrow breakpoint, borrow E's combined Files/selected-entry band to remove the separate 44px Files row. Use the existing in-flow disclosure rather than a source-covering overlay. Preserve a named file picker, count, selected identity, full path recovery, separate Entry actions target, and DOM/tab order matching visual order. Wrap genuinely long paths rather than reduce text size or crowd targets. Remove redundant internal count/header when the picker is expanded.

For published content, retain a visible Edit entry primary action; group Copy and Download in a named secondary menu/dialog so the title/type/actions need at most two rows at 390px. Add a concise Published cue within existing metadata. The change must retain the explicit path-or-content submitted search; draft's live path filter remains separately labeled.

## Debate and resolution

All five peers inspected the actual images and independently converge on the A/current desktop plus E narrow-band hybrid. We directly challenged each other rather than accepting full images:

- Editor challenged A's state pills as a fake view switch and B's bundle actions in the file header. Agreed: use plain state and preserve scope boundaries.
- Accessibility ranks E's narrow principle highest and requires actual native-200% and long-path renders, plus visual/tab order consistency. Agreed: no source-covering popup or bottom action bar without proof.
- Workflow ranks B last because a file-scoped perception of Save is a larger error than the width gain. Agreed on semantics; my desktop rank is less severe because the primary hierarchy is still visible, but B contributes no chosen implementation.
- Visual ranks B over D, arguing D's right rail imposes a second scan edge. I rank D above B because bundle/file action scope is clearer. Neither shell relocation is chosen; the disagreement has no implementation consequence.
- Skeptic rejects C's duplicate bundle navigation and flags E's desktop switch cost. Agreed: preserve desktop rails and extract E only below the narrow breakpoint.

## Implementation approval status

Not approved yet. Concepts provide direction; actual implementation renders must satisfy the measurable acceptance above. In particular, no approval based on desktop appearance alone: inspect narrow dirty/clean/published states, expanded picker, long paths, native 200%, and the true saved-generation evaluation target.

## Actual implementation review, capture 1

Inspected actual PNGs for desktop draft/content/library, 390px draft/content/library, 320px clean draft/long scope/navigation drawer, native 200% draft/content, expanded Files picker, Draft actions menu, and Entry actions dialog. Read implementation in `file-navigator.tsx`, `bundle-content.tsx`, `draft-workspace.tsx`, and relevant styles. No application edits or test/build runs performed by this reviewer.

The bounded hybrid is actually implemented: desktop rails preserved; narrow Files trigger shares selected-entry space when closed; expanded picker remains in flow; no source-covering file popup or component remount introduced; primary draft state/actions remain before source; published mode explicitly labeled, direct Edit entry retained, Copy/Download grouped under accessible Content actions. Entry operations stay in a named dialog. Expanded file picker contains one Files count rather than three. Exact Evaluate saved generation 1 target remains in the narrow Draft actions menu.

Exact saved capture JSON measurements:

| State | Baseline source top | Capture 1 source top | Gain |
| --- | ---: | ---: | ---: |
| Desktop draft | 156 | 156 | 0, width preserved at 1006 |
| 390px dirty draft | 333.39 | 314.39 | 19px |
| 390px published | 330.39 | 227.69 | 102.70px |
| 320px clean draft | 368.58 | 349.58 | 19px |
| Native 200% draft | 243 | 205 | 38px |
| Native 200% published | 198 | 156 | 42px |

At native 200%, the initial draft source area increases from 85px to 123px, a material improvement. Long paths wrap without hiding identity; short screens retain truthful browser-versus-saved state and primary task access. Scope of saving remains draft-wide rather than placed inside a file-only toolbar.

No material hierarchy blocker found in capture 1. Files count wrapping and a directory slash orphan are polish observations already being addressed by the implementation owner; final approval awaits capture 2 confirmation of those small changes and the 390px single-band improvement.

## Final actual-render decision, capture 2

**Approved for information architecture. No material objection remains.** This approval follows direct inspection of capture 2 desktop draft, 390px dirty draft/published content, 320px clean draft/long-scope content, native 200% draft/content, and expanded narrow picker, together with the capture 1 interaction states and relevant source inspection above.

The actual 390px dirty draft now has a single selected-entry band: Files (4), current entry, type, and accessible Entry actions. The count no longer wraps unnecessarily. Exact source top improves from baseline 333.39px to 288.39px, a 45px gain. Published content remains at 227.69px versus 330.39px baseline (102.70px gain). Native 200% maintains the 38px draft improvement, with 123px initially visible rather than 85px. Desktop editor retains y156 and 1006px width. Capture 2 JSON records no small reading text or small touch targets in these key states.

At 320px, the selected-entry band deliberately wraps while keeping type and actions available; the long full path deliberately consumes lines rather than hiding identity. These are acceptable content-driven costs. The clean Continue to evaluation button still wraps at 320px; it remains readable and preserves a truthful destination, so shortening it is optional rather than a release blocker.

Final approval is for the bounded implemented hybrid, not the generator's omissions or inventions. No folder tree, duplicate navigation, bottom dirty-state bar, source-covering file popup, unsupported “older” state, or fake execution/results was adopted. Draft-versus-file action scope, published mode, full path recovery, and saved-generation evaluation target remain clear.

Additional verification evidence read after approval: `artifacts/layout4-edges-final/summary.json` reports 27 passing edge states with no failures/browser errors: long identities at 1024/900/768/600/390/320 widths, responsive focus recovery, and mobile multi-file edits/save/dirty-guard behavior. Exact candidate retained; release and evaluation request counts unchanged; zero paid model calls. This supports the hierarchy's full-path recovery, truthful operation scope, and absence of invented execution. I read this evidence; I did not run these checks.
