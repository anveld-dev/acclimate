# Skeptical newcomer and simplification review

Status: baseline, all six actual concepts, implementation source, and actual capture 2 inspected. **No material objections to the implemented layout.**

I inspected the desktop and mobile390 published Content, dirty generation-1 Draft, and Library screenshots in `artifacts/layout3-capture-3/screenshots`, plus `bundle-content.tsx`, `draft-workspace.tsx`, `file-navigator.tsx`, and relevant CSS.

## Material findings

- Published Content on mobile spends three rows on filename, type/Copy/Download, and Edit entry. In the observed image, the document begins around y350. Read-only browsing should not require a taller action surface than editing. Preserve a visible Edit entry action; group secondary Copy and Download into a clearly named entry-actions surface or otherwise fit a compact header without shrinking touch targets.
- The browser contains unsaved changes while generation 1 is saved. The baseline does communicate this in one status sentence and names the secondary target `Evaluate saved generation 1`. Every concept must retain both facts. A generic `Evaluate` label would imply the unsaved text participates and would be materially misleading.
- The selected file's full path must remain available when the basename is ambiguous. File-list ellipsis is acceptable if selection exposes the complete path. Do not treat all truncation as a defect or force a wide rail merely to display every directory.
- Additional inspected evidence: `native200-draft.png` leaves only about 85 CSS px of visible source below the stacked scope, draft toolbar, Files row, and selected-entry row at a 640×328 effective viewport. Integrating the compact Files control with selected identity has a real task benefit; shrinking typography or touch targets would not be an acceptable substitute.
- `mobile390-draft-files.png` repeats Files (4) in the disclosure, internal heading, and an additional 4 entries label. In the open picker that repetition consumes vertical space and becomes a material compactness issue. Keep one count in that state.

## Simplification constraints

- The desktop draft is already excellent at its primary task: content starts at y156 and has roughly 1006 px usable width. A novelty-driven shell or permanent right panel must justify every pixel it takes from that surface.
- The library's single bundle and quiet whitespace correctly represent the available data. Do not add summary metrics, empty sections, dashboard cards, or a suggested execution flow to make it appear fuller.
- The file picker is a legitimate scope control, not redundant chrome. It can be compact, but the current file and switch-file action must remain distinct and discoverable.
- Repeated file count and muted type metadata are low-priority visual preferences unless they force wrapping or push content down. They do not justify broad markup churn by themselves.
- A `Published` cue could help a newcomer understand Content, but it should use existing header space and must not create another phone row. Tabs and a channel selector do not by themselves teach the saved-versus-published model.

## Debate so far

Hierarchy and workflow reviewers agree that sparse Library is appropriate, the desktop editor should be protected, phone published actions are excessive, and the saved-generation target cannot become a generic evaluation action. I challenged the need for extra state badges or global navigation changes without evidence; compactness is not a requirement to compress every label or fill every blank area.

## Actual A–F image critique

I inspected `images/a.png` through `images/f.png` as actual raster images. E and F were inspected separately after the initial tool response reached its image limit. The ranking below concerns useful implementation ingredients, not whole designs: **A > E > F > D > C > B**. No generated image is approved literally.

| Image | Useful evidence | Objection to literal adoption |
| --- | --- | --- |
| A | Familiar hierarchy, top draft-wide action band, explicit saved target | Large invented tree costs space; Add entry is absent; Edit path/Edit kind/Remove are promoted into permanent chrome. Dirty/saved segments resemble a control. `Older` adds an unnecessary interpretation. |
| B | Labeled global navigation can retain meaning without a sidebar | Save sits in AGENTS.md heading and appears file-scoped. Evaluation is hidden behind an unlabeled ellipsis. Multiple scope/state chips crowd one selected-file row. |
| C | A wider source is possible without two permanent sidebars | Bundle navigation is duplicated in both sidebar and top. Files appear far below the navigation, reducing available list space. This creates a larger redesign without solving the phone problem. |
| D | File and draft action scopes remain visually separate | Right-side file rail narrows the editor and changes a familiar selection location without an evidenced benefit. Expanded entry mutations remain unnecessary chrome. |
| E | Files trigger and selected identity can share one compact band | Repeats Files count; no Add entry; overlay obscures source while source is artificially indented to make the mock look clear. A persistent desktop rail should not be removed for this task. Extract the merged band only at narrow widths. |
| F | Moving a band can visibly increase source height | Bottom-only state and Save detach the draft target from the initial reading position and add keyboard/zoom travel. Radio-like state circles imply selection. Do not transplant the bottom workflow. |

## Debate and direction

I sent the above critiques directly to hierarchy, editor, accessibility, workflow, and visual reviewers. Our rankings differ for complete desktop concepts, but the shared bounded direction is sound: protect the current desktop editor, use E's combined compact Files/selected-file band only at narrow widths, simplify repeated open-picker metadata, and consolidate published Copy/Download under a named entry action surface while keeping Edit entry visible.

I explicitly challenged state emphasis as a mandatory semantic repair: the existing sentence is already truthful. Improving scan priority can be accomplished with foreground/bold Unsaved changes in the same band. A new badge row, fake segmented control, `older` qualifier, or generic Evaluate label would be unjustified. Workflow and visual reviewers agreed.

Implementation conditions: Files and Entry actions must remain separate named targets rather than nested buttons; selected full path must remain available; the browser edit guard and picker selection focus behavior must survive; the actual phone/zoom render must demonstrate the claimed space recovery without shrinking text or controls.

## Actual implementation verdict

**No material objections.** I reviewed implementation source in `bundle-content.tsx`, `draft-workspace.tsx`, `file-navigator.tsx`, and `styles.css`, actual capture 1, and the final `artifacts/layout4-capture-2/screenshots` images: desktop draft, mobile390 draft and Content, mobile320 draft and long scope, native200 draft. I also read capture 2's 58-state summary. I did not run a separate build or test suite.

The final implementation earns its changes through actual task visibility. Desktop draft retains source y156 and width 1006. Mobile390 draft source begins at y288.4, with one visible Files/selected-file/action band; published Content begins at y227.7 instead of the baseline's roughly y330. At native 200% zoom the draft source begins at y205 instead of y243, increasing initially visible source from 85 to 123 CSS px. Fonts and control targets retain readable sizes.

The merged picker is not the concept's overlay: Files remains a distinct named button, its body opens in document flow, and the selected file's actions remain separate. The file picker keeps one unfiltered count. The desktop source and quiet single-bundle library retain their useful shape. Published Edit entry stays visible, Copy/Download are accessible through Actions, and Published identifies the read-only surface without a new introductory region. Save remains draft-wide; the truthful dirty/saved sentence and exact saved-generation evaluation target remain intact.

The capture summary reports successful selection close/focus restoration, resize focus handoff, preservation of unsaved source, keyboard access to entry/published actions, clipboard-permission fallback, matching downloaded source bytes, and unchanged evaluation/release behavior. This supports the implementation's interaction claims; the geometry improvement is visible directly in the screenshots. I also read `artifacts/layout4-edges-final/summary.json`: its 27-state pass reports long identities across 1024–320 px, responsive focus restoration, preservation of two file edits, save/dialog focus, and an exact saved evaluation candidate without release or request mutations.

The 320 px render still wraps the selected-file metadata, and the full long path uses several lines. That is an honest width tradeoff, not a material defect: names and paths remain visible and the source remains readable. The desktop rail's occasional mid-segment directory wrap is a nonblocking polish preference. It does not justify expanding the rail or another iteration once required checks pass.

This approval applies to the bounded implementation, not any complete generated mock. No dashboard, metrics, execution feature, permanent second panel, bottom-only Save, or misleading interactive status treatment was introduced.
