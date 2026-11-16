# Visual and product design review

## Baseline audit — actual current renders

Reviewed `artifacts/layout3-capture-3/screenshots/desktop-{draft,content,library}.png`, `mobile390-{draft,content}.png`, and the current `styles.css` / `draft-workspace.tsx` implementation. No application changes or test runs performed by this reviewer.

The current desktop draft is already an efficient workbench: the source begins at y156, the editing column is about 1006px wide at1440px, and the 176px workspace rail leaves generous usable content. The olive selection, plain surfaces, and readable14px controls suit this task. Preserve those strengths; an extra card layer or smaller typography would make this worse.

The main visual hierarchy concern is the competing context. Bundle scope, channel, product tabs, draft status, three action boxes, file controls, selected-file metadata and editor all appear in successive shallow ruled bands. The eye must parse several similarly weighted labels to identify the current state. `Generation1 saved · Unsaved changes` uses one continuous neutral sentence for two different facts. Save is correctly dark, but the much wider evaluate button remains unusually prominent beside it despite evaluating the saved snapshot. Emphasize the current unsaved editing condition within the existing band, while retaining the exact target in the evaluation action. The current copy is factually explicit; this is a scan-priority improvement, not evidence of a semantic bug. It does not justify an extra status row or a cluster of badges.

The desktop file navigator is readable but rhythm is inconsistent: a Files heading and Add entry, then search, then type filter, then the repeated4entries, then47px-ish rows. Current source uses a216px file column and40px minimum file buttons with two readable text lines. Do not shave row text or hit targets. The count repetition and search/filter grouping are better targets than row compression. Keep full paths available: the long checks.md directory is truncated even in the current desktop screenshot.

Mobile shows the more material opportunity. At390px the read-only content header wraps the kind badge, Copy, Download and Edit into three rows; actual text begins around y350. Draft text begins around y360 after bundle navigation, status/actions, Files disclosure, and selected-file header. Reorganizing those controls by role should recover a meaningful row without reducing the44px coarse-pointer targets or16px source text. The current mobile title and channel are understandable; replacing them with an unlabeled icon rail would be a regression.

The library has one compact, clearly actionable bundle row. Its empty canvas reflects one bundle, not a need for a dashboard. Preserve a simple list and a clear New bundle action. A larger card or summary modules would add decoration without improving consumption.

## Initial direction

Prefer a quiet editor-led workbench with one clear current action, a distinct but small saved-snapshot context, explicit scope, and compact grouped secondary commands. Reuse the existing shadcn Mira controls and olive selection. Desktop first-source y156 and width1006 are benchmarks, not whitespace to spend casually. A responsive design should reduce mobile header rows by moving secondary tools into an explicit menu; it should not hide scope, save state, or the identity of the selected file.

## Peer challenges before image selection

Hierarchy/editor peers agree the existing source width and top edge are strong constraints, and selected full path must survive because package titles and truncated directories can otherwise be ambiguous. Accessibility clarified the native200 render: editor box begins y243CSS in an effective640×328 viewport, leaving85px of editor and about61px after its text padding; a desktop-only sketch cannot establish improvement. Workflow recommends merging the mobile file selector and selected identity rather than compressing controls. Skeptic correctly challenged treating the neutral status sentence as a proven bug: emphasis can help without adding height or badges. I accept that correction.

## Image review

Inspected all six actual PNGs (`images/a.png` through `f.png`) individually. Ranking the salvageable architectural ideas, rather than accepting any image literally: **A > B > E > C > D > F**. This differs from peers and is not a consensus ranking.

| Concept | What the actual image establishes | Decision |
| --- | --- | --- |
| A — layered workbench | Familiar labeled workspace rail, distinct bundle scope, distinct draft-wide actions and file identity. It preserves the clearest operation scopes. | Best desktop base. Reject generated nested tree, expanded Edit path/Edit kind/Remove controls, and state segments that resemble clickable tabs. The extra `older` label should not be inferred from visual styling. |
| B — workspace top bar | Labeled global navigation plausibly recovers horizontal space. However two full horizontal context bands precede a selected-file header that also contains whole-draft Save; evaluation is hidden behind an ellipsis. | Interesting alternate shell, unnecessary churn here. Recovering width does not justify ambiguous file-versus-draft action scope or hidden saved-target evaluation. |
| E — file switcher canvas | A named Files trigger and selected-file identity fit one logical toolbar. The open picker obscures the editor and the source is artificially inset to accommodate it. | Best narrow-screen donor only. Keep existing in-flow mobile picker; do not copy desktop overlay or forced source gutter. |
| C — contextual rail | Broad source but a very wide mixed workspace/bundle/file rail. The actual image duplicates the full bundle navigation in the rail and header. | Reject complete architecture. Removing duplication could make a different idea, but it would still mix scopes and spend width without evidence. |
| D — right file panel | Source begins near workspace navigation, but the almost300px file panel remains far right and source is still low. It exposes the same unnecessary destructive tools as A. | Reject: file selection moves across the reading field without a demonstrated source-width or top-edge gain. |
| F — bottom workflow bar | Highest visible source and quiet upper editor. Current unsaved state, saved generation and Save all live below the full document. | Reject despite visual airiness. Zoom/mobile and long documents can conceal the entire task state; keyboard and visual reading order separate the decision from its target. |

### Direct peer debate and retained disagreement

Hierarchy ranks D above B because D preserves bundle-operation scope; I rank B above D as an architectural exploration because its labeled shell can recover width, while D's right-side list adds no clear visual gain. Editor/workflow agree B's actual selected-file Save grouping must not ship. This disagreement does not change the selected bounded hybrid. Accessibility prioritizes E as a narrow-screen principle and warns a combined band cannot honestly promise a44px gain at320px; I agree. Skeptic ranks F higher specifically as a useful source-height experiment, while also disqualifying bottom-only state; I retain F last for current-state discoverability despite its cleaner upper canvas. No ranking is an implementation endorsement.

### Selected hybrid and visual conditions

Retain the disciplined existing desktop/A workbench and use E only for a narrow Files-plus-selected-identity band. Keep one current action, exact saved-generation evaluation wording, and a plain emphasized current unsaved state within existing height. Preserve readable full selected path, distinct Entry actions, and in-flow expansion. A long path or320px viewport may legitimately wrap; do not force the selected name into an unrecognizable sliver or shrink type to claim a universal row saving. Group published secondary Copy/Download commands while keeping Edit immediately visible. No new cards, tabs, tree model, destructive buttons, fixed bottom workflow bar, or desktop picker is justified by these images.

## Responsive implementation review

Inspected actual `artifacts/layout4-capture-1` desktop draft/content/library, mobile390 draft/content/expanded files/draft actions, mobile320 draft/long-scope, and native200 draft/content PNGs, with matching JSON geometry. No material visual blocker in this capture. This is a visual review; screenshots do not establish all keyboard interactions.

| Source box | Before (layout3 capture3) | Capture1 | Change |
| --- | --- | --- | --- |
| Desktop draft top / width | y156 /1006px | y156 /1006px | Preserved |
|390px draft top |333.39px |314.39px |19px earlier |
|390px published content top |330.39px |227.69px |102.70px earlier |
| Native200 draft top |243px |205px |38px earlier |
| Native200 published top |198px |156px |42px earlier |
|320px draft top |368.58px |349.58px |19px earlier |

The published header now makes Edit immediate and groups secondary commands quietly, with a clear inline Published cue. The merged narrow Files/selected identity saves space without shrinking source or hiding full long paths. Draft390 still wraps kind and entry Actions to a second line, so its gain is modest; do not claim a universal44px improvement. Long320 scope/path growth is honest and readable. Expanded Files is in-flow and its repeated counts have been removed. Desktop remains an editor-led surface, and the library appropriately remains a quiet single-row list.

One nonblocking visual polish request: the88px mobile Files trigger wraps `Files (4)` across two lines despite a short label. Fit that label on one line with internal padding/gap or a small width adjustment, retaining44px touch height and readable type. The full desktop checks directory now wraps a terminal `s/` onto an orphan line; full availability is valuable, and this is cosmetic rather than a reason to truncate identity. Pending any final polish recapture before final unconditional approval.

## Final visual approval — capture2

**Approved. No remaining material visual or product-design objection.** Inspected actual capture2 desktop draft/content,390px draft/content and expanded Files,320px draft and long scope/path, and native200 draft/content. Files now stays on one line without smaller text. At390px the draft identity, kind and Actions fit one clear band, giving an editor top of288.39px versus333.39px baseline:45px recovered. Published content remains102.70px earlier; native200 draft/content remain38px/42px earlier. Desktop draft stays y156 and1006px wide. At320px draft still wraps honestly and gains19px, rather than forcing an unreadable single row. Long titles and full paths remain visible with legitimate growth.

The remaining desktop directory orphan line is cosmetic and is preferable to losing the full path. It does not block approval or justify widening the rail. The final result uses the useful structural principles of A and E while rejecting their generated mistakes; it preserves the quiet library and shadcn Mira/olive language. Interaction/testing evidence is owned by the implementation and accessibility reviews; this reviewer performed visual inspection and JSON geometry comparison only.
