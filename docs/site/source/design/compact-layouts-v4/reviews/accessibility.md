# Accessibility and responsive review

Reviewer: accessibility / responsive. Baseline inspected: `artifacts/layout3-capture-3/screenshots` desktop draft, 390 draft/files/navigation, 320 draft/long scope, native 200% draft/evaluation, and their metric JSON; relevant CSS, draft workspace and file navigator source. No application changes or test runs by this reviewer.

## Initial findings

The baseline has meaningful protections worth retaining: 14px reading text, 16px touch source, 44px coarse-pointer controls, visible focus rings, named file picker, selected-file focus return after committed navigation and reflow, and state-aware save/evaluation actions. At 320px the JSON reports no small reading text or small targets. Ordinary vertical scrolling is not a failure.

1. **200% zoom loses useful task visibility through stacked chrome.** Native200 draft is an effective 640×328 CSS viewport. The editor starts at y243, leaving about 85px, roughly three source lines. Scope/header, toolbar, Files toggle and separate active-entry header consume nearly three quarters of the viewport. This is a practical task visibility concern, not a claim that vertical scrolling violates WCAG. Merge the Files selector and active file identity into one named row at narrow effective widths, retaining a visible selected filename and explicit picker affordance. Reclaim duplicated labels before reducing control height or text.
2. **Mobile wayfinding is icon-only despite available context.** At ≤600px `.bundle-scope-return-label`, `.workspace-menu-label`, and `.bundle-channel-label` are visually hidden. The menu and back controls retain accessible names, but two unexplained icons plus `stable` increase recognition work. Keep short visible text such as Menu / Changes; evaluate the channel label as scope, rather than removing it automatically to meet a density target.
3. **The opened mobile file picker repeats information.** `Files (4)` toggle, `Files (4)` heading and `4 entries` are simultaneously visible. Remove duplicate count labels; keep search, add entry and selected file context. A popover or sheet alternative must preserve keyboard return focus and cannot depend on hover for full paths.
4. **320px clean-state CTA wraps.** `Continue to evaluation` is 160.5px wide and 55.2px tall, growing the toolbar before source begins at y368.6. A concise destination label can preserve a 44px target while avoiding the second line. Dirty state must still visibly identify that evaluation uses a saved generation if offered alongside unsaved edits.
5. **Long paths are intentionally readable.** The long-scope screenshot wraps full selected paths and does not overflow. Keep this behavior for the selected entry, even if list rows truncate. Do not gain density by making the active path available only in a tooltip.

## Comparison criteria for six images

Each concept must be inspected before ranking. Prefer compact grouping that retains visible workspace/bundle/channel, dirty-vs-saved state, selected entry, labeled navigation and a clear save action. Small image type is not evidence of 14px implementation text, nor is an attractive mock evidence of keyboard behavior. At native200 a useful part of the task should remain visible after header reflow. Real-render acceptance requires screenshots and measured source geometry, not mock approval.

All-six comparison appears below. Final rendered verdict requires implementation evidence.

## Initial peer debate

- **Hierarchy:** agreed that the saved-generation / browser-edit distinction needs stronger organization; challenged any grouping that buries scope or keyboard discovery. We agree duplicate file counts are expendable, whereas full selected-entry identity is not.
- **Editor:** independently confirmed committed-selection/reflow focus handling. A merged band must keep a named, independently focusable Files control and selected-file-scoped Entry actions. Long selected paths remain readable without hover.
- **Workflow:** asked to preserve visible dirty state and saved evaluation scope when reducing the toolbar; shortening the clean CTA is acceptable only if its destination remains clear.
- **Visual:** agrees to use role-based grouping, not micro type or ambiguous icons. Clarified that native200's first text glyph is below the textarea box top, so screenshot approval must inspect actual source visibility.
- **Skeptic:** agreed to merging Files/identity only if long paths do not force opaque disclosure; asked for the exact native200 screenshot and metadata, which were supplied. We explicitly distinguish task visibility from a blanket prohibition on scrolling.

## Six actual generated image comparison

Inspected every actual PNG `images/a.png` through `f.png` before ranking (E/F were viewed separately after the initial image response hit its display limit). These are desktop concepts, not responsive or keyboard evidence. Accessibility extraction ranking: **E > A > D > B > F > C**. No literal concept is approved.

| Concept | Useful idea | Concrete objection |
| --- | --- | --- |
| A | Explicit browser edits versus saved generation; visible text scope/navigation | Segments look interactive, `older` adds an assumption, nested tree increases navigation work, Add entry absent from image |
| B | Flat, readable file rail and compact editor heading | Bundle-wide Save appears in entry heading; ellipsis obscures saved-generation evaluation; top global navigation adds another horizontal band |
| C | Source receives more horizontal room | Repeats bundle navigation top and left; mixes global/workspace/bundle/file hierarchy in one rail; no narrow or zoom proof |
| D | Readable text and explicit top draft actions | Moving file rail to right adds unfamiliar focus/reading sequence without demonstrated task gain; source remains narrowed |
| E | Named Files trigger plus visible selected identity in one band—the best bounded narrow-screen extraction | Literal popover obscures source and image invents a large left source gutter; Add entry not shown; does not establish keyboard or mobile behavior |
| F | Source starts high | Dirty state and Save are detached below editor; their visibility at short 200% viewport is unproven. Apparent circles beside status can look like controls |

The preferred extraction is **baseline desktop plus E's narrow selector/identity grouping**, retaining the existing in-flow picker and focus behavior. Keep Entry actions a distinct control, retain full selected path wrapping, and retain source alignment. A's state distinction may inform plain text, without adopting apparent segmented controls. Published Copy/Download under named Actions with visible Edit entry is reasonable, provided the group is keyboard accessible and named for its contents.

## Image-based peer debate and implementation challenge

All five peers received the image comparison. Hierarchy/editor/skeptic support E's narrow band but reject its literal overlay; visual ranks A/B higher for desktop architecture and agrees the E band is the useful narrow extraction. We agree F's airy source does not prove a usable save/state location at native200. The ranking difference is deliberate: this review penalizes B's hidden evaluation scope and file-scoped appearance of Save more heavily, while recognizing D has little demonstrated benefit.

Root proposed preserving the existing DOM/state and positioning the persistent Files trigger at a reserved left inset of the closed selected-entry heading. That is acceptable for verification: DOM focus order remains Files → expanded body → selected heading → source, rather than creating duplicated controls or remounting the editor on resize. Specific risks to inspect:

- At 320px, a roughly 96px Files inset plus filename and roughly 110px Entry actions will likely wrap. Accept the true height; do not force a 44px saving through hidden identity or small text.
- Long paths must wrap below/beside the reserved trigger without painting underneath it.
- An open picker needs space for the trigger before search/list content; it must remain in normal document flow.
- Returning to desktop must reset trigger positioning, heading inset and picker padding.
- The Files target must remain separate from filename and Entry actions; do not overlay an invisible click surface across the heading.

Final actual-render verdict is recorded below after capture2 inspection.

## Final actual-render verdict

**Accept the bounded implementation in `artifacts/layout4-capture-2/screenshots`, with the limits below.** I inspected the implemented CSS and component changes, actual desktop draft/content, 390 draft/content/open Files, 320 draft/long scope, and native200 draft/content PNGs; read the complete capture summary and scanned every capture JSON for small reading text, small targets and horizontal overflow. This is an assessment of the implementation evidence, not approval inferred from the generated concepts.

| Matched state | Baseline source top | Implemented source top | Useful gain |
| --- | ---: | ---: | ---: |
| Desktop draft | 156px | 156px | Same 1006px source width and 676px visible source |
| 390px draft | 333.39px | 288.39px | 45px more initial source |
| 320px draft | 368.58px | 349.58px | 19px; honest two-row header retained |
| Native 200% draft, 640×328 CSS viewport | 243px | 205px | 38px; initially visible source box grows 85px → 123px |
| 390px published content | 330.39px | 227.69px | 102.70px; Edit entry remains visible |
| 320px long title/path published content | 443.17px | 388.47px | 54.70px; full path still wraps |

The closed narrow band has separate visible Files and Actions controls. Files is 92×44px in the measured 390 state, with no text wrapping. The open picker remains in flow with Add entry/search/filter/list visible and only one Files/count caption. Source is not covered. Menu and Changes/Bundles now have visible text. Desktop retains its file rail and main source geometry. The 320 layout wraps the entry tools rather than crushing source type or truncating the active path.

All captured metric records report no small reading text, small targets or horizontal overflow. The summary reports all 58 states passed, no browser errors, keyboard-open/Escape-focus return for published actions, committed file selection close/focus return, resize focus return, unsaved source preservation, actual download bytes matching published text, and a denied clipboard permission fallback with selectable source. Those reported browser checks support the code inspection; this reviewer did not independently run the browser or test suite.

Remaining limits are explicit:

- Native200 is materially better but still has only 123px of initial source box in a 328px-high CSS viewport. It is improved task visibility, not a claim that the whole document should fit without scrolling.
- 320px gains 19px rather than a universal one-row/44px saving. Its clean evaluation button still wraps, retaining the earlier nonblocking compactness opportunity.
- The full selected long path is readable and does not overlap Files, but existing `break-all` can split words midword in its narrower text column. I suggested `word-break: normal` plus the existing anywhere overflow wrapping as a readability refinement; this is not a hidden-path or overflow failure.
- The channel label remains visually hidden on small phones; `stable` has its programmatic Channel label. Menu and return navigation now carry visible text, which addresses the most consequential icon-only wayfinding issue.

No accessibility blocker found in the bounded change from the inspected evidence. Retain these responsive and focus checks if the band or path layout changes again.

I additionally inspected `artifacts/layout4-edges-final/summary.json`, the 320px long draft, 600px/900px long published entry, and focused narrow file-rail reflow screenshots, and scanned all edge JSON metrics. The 27 extra states pass without browser errors or small-target/reading-text/overflow reports. The summary covers long bundle/path/channel identities at 1024, 900, 768, 600, 390 and 320px; sheet Escape/resize focus; file resize focus; two-file edits; repeated Save focus; and dirty-navigation Keep editing/Escape focus. The screenshot focus ring lands on the named Files control after narrowing. Long identity growth remains honest wrapping, with no overlap of Files and selected identity. The midword path wrapping refinement above remains explicitly nonblocking and outside the frozen patch. Final verdict remains accept the bounded implementation; no additional change requested.
