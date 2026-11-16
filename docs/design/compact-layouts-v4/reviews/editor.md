# Editor and developer workflow review

Status: final implementation approved after actual capture 2 review. No remaining material editor or developer workflow objection.

## Baseline evidence

Inspected actual capture-3 desktop and mobile390 PNGs for draft, content and library, plus `DraftWorkspace`, `FileNavigator` and `BundleContent` source. Desktop draft already starts source at y156 with roughly 1006px of width. Compactness must improve task orientation without spending this useful source area. Capture geometry confirms mobile draft source starts at y333.39 (the initial visual estimate was around y342); published content at y330.39.

Concrete existing issues:

- Published and draft content use the same mostly generic file shell. Published mode is inferred from the Content tab and Edit entry action; draft mode adds a toolbar. Keep an explicit Published / Draft distinction wherever navigation is reduced.
- The library's single row says “Created content” and stable, but gives little evidence for choosing the intended bundle. Preserve bundle and channel identity when entering the editor; do not invent counts or activity data to fill this space.
- The file rail truncates `skills/review/referen…` under checks.md, so duplicate basenames need their full selected path preserved in the editor header. A basename-only tab is insufficient. Skill package titles deliberately abbreviate `SKILL.md`; this is not a filesystem tree today.
- Draft filtering is live path matching; published searching matches path or body and submits explicitly. A single generic search concept can misrepresent behavior. Draft filtering can hide the still-selected file from the rail while its content remains displayed. Result counts and active path should explain that state, especially when Files is collapsed.
- On phone, Files count is the closed picker label; current path appears only below it. Selected path must remain visible without reopening the picker. Existing focus transfer and selection-after-commit behavior should survive a layout change.
- Draft source is a real Markdown textarea. The browser may contain edits beyond the saved generation. Save draft applies to the draft payload; Entry actions applies only to the selected file; Evaluate saved generation N targets the durable snapshot. These three action scopes must not merge into a generic Save/Run strip.
- Published mobile content spends several header rows on kind, copy, download and edit. It can recover reading space by grouping secondary actions, while keeping Edit entry named and preserving access to copy/download.

## Bounded acceptance

1. Keep desktop source at least baseline width and no lower than y156 for the same fixture; editor text remains 16px, ordinary readable text at least 14px and coarse-pointer targets at least 44px.
2. Bundle, channel, Published/Draft state, selected full path, saved generation and browser dirty state remain inspectable in the immediate editor context. IDs/history may stay in details.
3. Save draft is the primary action while dirty. Evaluation is explicitly “saved generation N”; saving does not imply publication or native execution. Published Edit entry clearly opens/creates a draft.
4. File search states its actual scope. A no-match or filtered-out selection preserves recoverable navigation, with clear filters available; no fake semantic search or fabricated hierarchy.
5. On phones, source is never blocked by permanent file navigation, and collapsed navigation exposes selected identity. Keyboard opening, choosing and returning to source remains predictable.
6. The implementation retains plain Markdown editing, dirty-route protection, exact saved-generation targeting, package rename constraints and action scoping. Fresh images are evidence for layout only, not proof these behaviors work.

## Peer discussion

Sent hierarchy reviewer the search-scope and filtered-out-selection concerns, and agreed that Save dominance and explicit saved-generation targeting are necessary. Await actual image renders before judging which alternative preserves these conditions.

Accessibility, hierarchy, visual and workflow reviewers agree that desktop source geometry should be preserved. Inspected the actual mobile open Files picker, Entry actions dialog and native200 draft after discussion: the expanded picker repeats the count in toggle, heading and result meta. A narrow combined selected-file/Files band can recover one row, provided Files remains a named 44px target, selected full path wraps and Entry actions stays separately scoped. Existing Entry actions dialog already explains that rename/type/remove affect the entry and stay in the draft until saved; preserve that explanation.

## Actual generated-image assessment

Opened each `images/a.png` through `images/f.png` separately, including E and F after the first tool output limit. These are desktop concept pictures, not evidence of responsive behavior or working controls. None warrants wholesale adoption.

For retaining a credible desktop editor skeleton, A ranks ahead of D, E, F, C and B. For a bounded narrow-layout improvement, E is first because Files and selected identity share one row. These are different questions; choosing A's whole shell for a mobile problem would be unjustified.

| Image | Useful actual evidence | Material objections |
| --- | --- | --- |
| A | Draft-wide toolbar stays separate from entry and source; browser edits and saved generation are visually distinguished. | Segmented Browser edits / Saved older reads as an unimplemented source-mode switch. “Older” overstates what is known. Expanded folder tree spends rail space, Add entry disappears, and Remove becomes a permanently prominent action. |
| B | Flat file list is familiar and source gets horizontal room. | Save and draft state appear inside the AGENTS.md heading, suggesting file-only persistence. Evaluation is concealed in an ellipsis. Kind dropdown beside filename makes frequent editing controls dominate; a second global top row spends height. |
| C | File navigation sits in one large left region and full relative paths can be read. | Bundle tabs are duplicated in rail and top header; files are pushed far below global navigation. Entry actions are expanded, Add disappears and support-file type is invented. |
| D | Honest draft-wide toolbar remains above selected entry. | Moving the file rail right creates travel and a different scan pattern without an observed task gain. Width and vertical space are still spent on expanded entry actions; Add disappears. |
| E | Files trigger and selected filename share a band; this is the clearest donor for the real mobile/zoom duplicate-row problem. | Floating picker covers source and even makes source appear indented to avoid it. Hiding desktop files hurts switching. Retain the baseline in-flow picker, full selected path and separate Entry actions instead. |
| F | Source starts early; draft-wide toolbar is visibly separate from entry. | Critical dirty state and Save are detached below source; on long content this costs scan/reach, and on phones a bottom bar competes with the keyboard. Radio-like current/saved markers imply unsupported mode switching. |

Direct debate with hierarchy and workflow reviewers refined the recommendation: A contributes semantic separation only, expressed as plain text rather than segments; E contributes a narrow Files/selected-identity row only. They agree B's entry-level Save placement is misleading, F's footer is a poor place for critical draft state, and no full generated shell should replace the baseline. Accessibility, visual and skeptic peers challenged narrow width: at 320px the full path may need genuine extra height, so a promised 44px saving cannot justify truncation or overlap. Files must remain its own named 44px control, Entry actions its own scope, and selected identity flexible. Accessibility also requires actual Tab/resize/expanded-body evidence before accepting any absolute-positioned implementation. All three accepted the bounded direction with those conditions.

Proposed implementation boundary: preserve desktop rail/source dimensions and top draft-wide actions, lead dirty state clearly while naming saved-generation targets, merge the narrow collapsed Files and selected-file rows without an overlay, remove redundant compact picker counts, and group published secondary actions to shorten its phone header. Preserve full paths and all existing Add/import/entry actions. No new execution, generation, publication or tree behavior is authorized by an image.

## Implementation review, capture 1

Inspected actual desktop draft/content, mobile390 draft/content/open picker/draft actions/Entry actions, mobile320 draft/long path, and native200 draft, plus the source and capture summary. Desktop draft source remains y156 and 1006px wide. Native200 source starts y205 with 123px visible rather than the baseline 85px. Published phone source starts y227.7. Draft phone source starts y314.4; the combined band still wraps at 390px in this capture, so its 19px improvement is smaller than the intended one-row saving.

The real implementation retains plain Markdown source and independent draft-wide Save, review and saved-generation evaluation. Entry actions keeps its scoped dialog description; the short visible Actions label has an explicit Entry actions accessible name. Published content now says Published; Edit entry stays visible while a named Content actions popover contains the real copy/download operations. The picker opens in flow rather than covering source, closes only after committed selection, and preserves focus transfer and browser edits.

Capture summary records 58 states passing, including keyboard selection, source edits preserved, resize focus return, Entry actions/rename/edit/save/evaluation, exact published-text download, clipboard failure fallback and Escape focus restoration. This is runtime evidence from the capture harness, alongside source review; no native execution is claimed. Baseline draft/published search-scope differences remain a separate preexisting issue, not a blocker for this bounded layout change.

Pending capture 2: Files(4) should fit together, ordinary directory separators should avoid an orphan trailing s/, and the 390px draft band should fit where possible. Long paths must remain fully readable even when genuine extra height is necessary. No other material editor objection identified.


## Final implementation verdict, capture 2

Approved. Reopened actual capture 2 desktop draft, mobile390 draft/content/open picker, mobile320 draft/long path, and native200 draft; reviewed its 58-state passing summary with no failures and the current FileNavigator/action source. Files(4) fits in its 44px target. At 390px the selected-file band now fits in one row, starts source at y288.39 and recovers 45px against the precise y333.39 baseline. At 320px the band wraps honestly and recovers 19px (y349.58 versus 368.58). Published 390px starts source 102.70px earlier. Desktop source remains y156/1006px and native200 retains 123px visible source.

The long selected path remains complete without horizontal overflow or tooltip dependence. The rail's wrapped ending s/ is cosmetic and does not justify widening it or sacrificing source. The in-flow open picker exposes Add entry and live path search; the selected file and its Actions remain identifiable below it. Real Markdown, retained browser edits, entry-scoped changes, draft-wide Save, saved-generation evaluation and published Copy/Download remain intact. The capture summary confirms keyboard open/selection, hidden closed controls, selection/resize focus restoration, rename/edit/save/evaluation, Escape restoration and clipboard fallback/download text checks. The earlier preexisting search-scope inconsistency remains documented, with no new blocker introduced.

Also reviewed the final 27-state edge summary: full channel/path identities at six widths from 1024 to 320, responsive focus restoration, two-file browser edits retained across navigation, first/second Save focus, keep-editing and Escape guards, and exact saved-candidate targeting pass. No browser errors, evaluation request change, release mutation or paid model calls were recorded in that verification fixture.

Direct final peer exchange with visual/workflow reviewers agrees the implemented gains are material on phone/zoom and desktop source is preserved. This approval covers the reviewed layout change and evidenced editor behavior, not a claim of native execution or broad publication testing. Full BDD completion remains the parent task's validation responsibility.
