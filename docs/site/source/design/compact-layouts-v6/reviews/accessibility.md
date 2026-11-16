# Accessibility and responsive interaction review

Scope: review only. This reviewer owns this document and makes no application changes, builds or tests. Evidence labels distinguish current source, actual captured render, reported assertions and proposed concept behavior. Concept images cannot prove keyboard operation or assistive-technology announcements.

## Final status — accepted build3

**Approve the implemented B desktop layout and the inspected responsive interaction changes. No material accessibility objection remains in this scope.** Definitive acceptance uses frozen build3 `173687e7d4abcc01962421a77d859f8108fa7cbc7c5474f45cad50e920d9bb6b`, with matching before/after whole-output fingerprints in the accepted run. Earlier build2 failures, diagnostic retries and first geometry estimates below are retained as review history and are superseded by this final evidence.

The final proof and limits are recorded in [Final build3 acceptance](#final-build3-acceptance). This is scoped UI/interaction approval, not screen-reader certification or a claim that unchanged comparison-table association and every rare branch were newly qualified.

## Desktop clarification and active review scope

The latest user clarification makes whole-desktop composition the design problem. The six replacement boards depict the same dirty Draft state at desktop, then must carry a coherent system across Content, Changes/evidence, Releases, App setup, Bundles, Connections and Members. The earlier comparison-specific audit below preceded that clarification; it remains a localized observation, not the governing layout direction. The superseded evidence-board prompts are archived separately and are not the six desktop candidates.

Review desktop at 1024, 1440 and 1920px, including expanded/collapsed global navigation and Files where each proposal supports them. Assess actual reading area, discoverability, keyboard order, full labels, overlays and resize handoff. A new desktop composition is allowed; do not freeze the existing sidebar/header geometry or force an icon rail. Mobile/zoom remains preservation and regression evidence.

## Current evidence and preserved baseline

Read the v5 state inventory, accessibility review, source `ComparisonEvidence`, `comparisonSummary`, shared Table/Disclosure and styles, plus summaries for final-standard-2, corrected final-native-2, navigation-final-2, core capture-2 and edges-final. The 181 captures are 58 core + 27 edge + 71 interaction (54 standard + 17 corrected native) + 25 navigation; these are representative states, not exhaustive combinations. The corrected native-2 captures supersede earlier incorrectly cropped exports.

Inspected actual final PNGs: core desktop selected evidence, core native200 Draft, standard mobile390 Add entry, desktop/mobile390 incomplete evidence, final mobile390 mismatched evidence, corrected short native200 evidenced publish and mobile320 singleton Sheet. Also inspected baseline-v3 phone incomplete evidence. The final incomplete-evidence screenshot is scrolled to comparison lookup/raw details and does not itself show the table; final mobile390 mismatched evidence does show the unchanged comparison with Candidate offscreen. Do not cite the incomplete capture as fresh visual proof that the table fits.

Preserve the already established system:

- Ordinary reading text remains at least 14px; coarse targets at least 44px; phone/touch source and inputs at least 16px. A `text-xs` class is already 14px here.
- Baseline desktop source begins at y156 with 1006px width at 1440px. Use those measurements to compare the new desktop compositions, not as a ban on rearrangement. Any chosen change must earn its area/clarity tradeoff at 1024/1440/1920. Real 200% uses a 640×328 CSS viewport with DPR2/full 1280px capture; baseline source starts at y205 with 123px initially visible. Accept ordinary vertical scrolling and test the genuine short viewport.
- The current coherent Dialog/AlertDialog/Popover/DropdownMenu/Sheet/Disclosure/Tooltip family, native selects, local field errors, full binding IDs, long touch workspace name, safe cancel/return focus and dirty-edit retention are preservation requirements.
- Tooltip remains supplementary hover/focus help. Workspace, saved versus browser state, case outcome, target, release identity and limitations must be available without hover. Do not recreate the v5 issues as claims about current source.

## Earlier comparison audit — before desktop clarification

**Observed render:** final-standard-2 390px mismatched evidence and baseline-v3 390px incomplete comparison show Case / repetition and Parent while Candidate starts offscreen in contained horizontal overflow. Desktop core selected evidence shows the three columns clearly. Current source retains this layout: `Table className="min-w-[32rem]"` inside the shared `overflow-x-auto` container.

**Source / proof boundary:** the native table supplies `th` column headings, but case labels are `td`, headings have no explicit `scope`, the scroll container has no explicit accessible name or tab stop, and repeated `Output / error` buttons have no side/case-specific explicit name. These facts justify stronger semantics and qualification; they do not establish that a browser cannot scroll or a screen reader cannot infer simple column association. The 181-state evidence did not add explicit table horizontal-keyboard or AT row/column association tests.

The summary function already retains every expected case plus unexpected returned pairs. Missing outcomes/grades remain missing; absent cost makes total unknown; zero is a legitimate known value. Complete inventory is explicitly not a win, statistical proof or release approval. These behaviors must survive any density work.

## Earlier comparison-specific responsive contract

Prefer a wide semantic comparison table and narrow paired reflow, keeping both Parent and Candidate visible within each case. This is a recommendation pending board review, not authorization for a new data model.

1. Give each case/repetition a row header or meaningful heading. Wide table uses explicit column headers and row associations. Narrow cells repeat visible Parent / Candidate labels and preserve heading relationships in the accessibility tree. A group of unrelated cards with only color or position distinguishing sides is insufficient.
2. Keep one interactive representation through resize when practical. Do not render two live focusable copies, remount by breakpoint, or reset expanded output. Preserve stable keys based on case/repetition and side. If architecture requires replacing a focused node, move focus to its equivalent persistent control and preserve open state, then prove the transition.
3. Each output/error trigger must have a distinguishable accessible name that includes side and case/repetition; visible short copy may remain concise. Retain existing Disclosure keyboard behavior, `aria-expanded`/controls, focus-visible treatment and hidden-descendant removal. Output reference/error can remain optional; outcome, grading status, missing/unknown and cost facts cannot depend on opening it.
4. Long case IDs, revisions, full comparison/request/candidate/parent IDs and output/error content must wrap or use an explicitly bounded inner code scroller. Never solve width by truncating a binding ID to hover-only text. Full identity may live in an existing labelled detail disclosure when the visible summary retains enough context; decision dialogs keep full binding identities visible.
5. At 320px/390px and real 640×328 native200, verify both sides, their labels and case association without page-wide horizontal overflow. If wide contained overflow remains at another breakpoint, expose an appropriately named reachable region when needed and prove keyboard access to the Candidate edge. Avoid unnecessary tab stops when there is no overflow.
6. Keep manual/evidenced release eligibility and mismatch/incomplete/unbound warnings outside optional raw details. Disabled release is explained visibly; success styling must not imply approval. Long content may add vertical height instead of reducing type or targets.

## State and proof map

| Family | Existing evidence to preserve | New comparison-specific proof required |
| --- | --- | --- |
| Collapsed page and optional details | Real v5 collapsed/editor, raw details, setup, history and recovery captures | Both sides and case heading remain meaningful with all output closed; comparison ID/detail disclosure retains values |
| Hover/focus | Real singleton Tooltip hover/keyboard/Escape, Actions/menu keyboard states | Focus ring and distinct output names for Parent and Candidate; no hover-only facts |
| Expanded output/error | Source supports optional output reference/error per outcome; not freshly shown in the inspected final comparison image | Open one/both sides, long output/error, missing side, move between controls, collapse and resume; retain open/focus state across wide↔narrow |
| Outcomes and inventory | Source covers expected plus unexpected rows; final assertions cover incomplete/mismatch release disable | Zero and unknown cost, missing outcome, missing grade, execution failure, extra returned pair, complete-unbound and mismatched candidate/parent remain legible |
| Overlays | Corrected native200 decision, restore/member/new-connection short views; phone menus/local errors/Sheet | No new comparison overlay family; preserve safe focus entry, Escape/return, reachable final actions and explicit full target |
| Responsive navigation/editor | Reported Sheet/Files resize focus, long identities, retained two-file edits; real source geometry | Compare changed editor budgets explicitly; reflow must not strand output focus in hidden markup |

Rare service/storage faults, native OS popup appearance, every role/read-only fixture and live model evaluation remain source-only or separate behavior-suite evidence. No new defect is inferred from their absence in screenshots.

## Desktop composition interaction contract

Inspected actual core desktop Draft, Content, selected evidence, Releases, App setup, Bundles, Connections and Members. Current route internals vary appropriately: editor/file rail, evidence ledger, release history, numbered setup document and administrative lists. Wide blank space on a short list is not by itself a defect or a reason to fabricate an inspector.

Current source has a 176px labelled workspace sidebar, 216px Files rail, a max-1600px main area, global navigation collapse at 1000px and Files picker at 899px. At 1024px both rails therefore remain visible; that breakpoint is meaningful desktop pressure, not proof that the layout fails. Existing global Sheet and Files resize handlers intentionally move focus away from hidden controls. The desktop rail currently has no user-collapse control, so a board introducing one proposes new UI state that must be implemented and proved, not an already observed state.

- Every collapse control needs a persistent accessible name, `aria-expanded` and controlled region. Closing navigation or Files cannot leave focus inside hidden content; when collapse occurs through resize or another control, retain focus on the same visible control or a deliberate persistent fallback. Reopening must retain meaningful selection, search/filter values and unsaved edits. Escape is not automatically a close command for an in-flow rail/disclosure.
- Prefer labelled global destinations at least in the expanded state. An optional collapsed rail must retain accessible link names, current-page indication and keyboard focus visibility. Supplementary Tooltip may reveal a short label on hover/focus and dismiss with Escape; it cannot be the sole way to discover workspace/channel scope or distinguish action purpose. Do not presume all users recognize icons, and do not force an icon-only global system merely to gain width.
- Separate global workspace scope, bundle route tabs, draft-wide actions, selected-file actions and source editing. These can move visually, but their accessible labels and logical reading order must remain coherent. A flat file list is not a tree widget: do not add `role=tree` and arrow-key obligations unless hierarchical navigation is actually supplied. Selected long file path remains available beyond truncated list entries.
- At 1024/1440/1920, open Add entry, Draft actions and selected-entry Actions; inspect menu anchor, focus/highlight/disabled states, full labels, available-height bounds, and Escape return. Avoid hover-revealed essential commands. Current shadcn menus already supply arrow/typeahead behavior; reuse it.
- Reuse existing bounded utility versus decision Dialog variants, Sheet, Popover and Disclosure rather than inventing desktop drawers for every secondary task. Account, workspace creation, entry actions, release/restore, connection creation/secret/revoke and member management must retain named title/description, active-dialog local error, focus containment, cancellation/return and full decision identities.
- Carry the desktop composition across all routes: file panes belong to Content/Draft; evaluation case evidence, release timeline, setup recipes, bundle list, connections and member lists need appropriate content reading area without empty fake file rails. Consistent global chrome does not require identical page internals.
- Any desktop inspector, new menu or collapsed state must have a task and truthful source-derived contents. No invented backend action, telemetry, automatic execution or release-approval result. Determine whether a new pane removes repetition or merely relocates it.

## Six boards and peer debate

Inspected actual replacement `images/a.png` through `f.png`; F was reopened separately after the tool omitted the sixth image from its first response. Repaired A was subsequently reopened and inspected with its complete header/scopes/actions; the archived clipped first A is superseded. All current physical images are 1586×992, so their drawn dimensions cannot establish measured 1440px browser geometry or prove 14px/44px targets. They depict layout and some drawn focus/hover states, not working keyboard controls.

Accessibility / responsive-interaction ranking: **B > C > D > A > E > F**. Approve B as a hierarchy donor, not as a literal rendered implementation.

| Board | Useful desktop composition | Limitation / required correction |
| --- | --- | --- |
| A — compact two rails | Repaired complete image supplies labelled workspace/global navigation, bundle/channel/routes, saved-versus-unsaved Draft state and distinct whole-Draft/local entry actions. Early searchable Files and utility footer offer a coherent low-state-cost comparator | Two persistent rails retain width cost at 1024px; compact rails must still handle long names and clear labels. It is a valid complete alternative, not disqualified by its superseded crop. No new collapse/mode benefit is shown. |
| B — workspace top bar | Strongest first-reading hierarchy: labelled workspace/global navigation, distinct bundle/channel/routes, Draft status/commands, then Files and local entry actions. No added mode. The global bar transfers naturally to administrative/list/setup/release routes without fake Files | Drawn four-band height is generous, not an earned compact result. Compress shared bands without shrinking labels. Prove long workspace/bundle/channel and command wrapping at 1024px; avoid far-right detached actions at 1920px. Drawn focus rings are not keyboard evidence. |
| C — contextual sidebar | One labelled rail makes workspace→bundle→entry hierarchy explicit and permits a high, broad source region. Real alternative to B, not just a spacing adjustment | Files appear below every global and bundle destination. Larger collections, long names and short desktop height need genuine sidebar scrolling/focus visibility; Account and selected item must remain reachable. No new tree semantics implied. |
| D — user-collapsed global rail | Credible optional compact mode: workspace identity remains in main scope; early Files rail; visible expand affordance and Connections tooltip. Optional collapse is not rejected for lacking persistent icon labels | Requires labelled expanded state, explicit accessible name/current-page indication on icons, hover and focus tooltip/Escape behavior, focus-safe collapse/resize and retained edits. Drawn tooltip and double-chevron do not prove these. Image changes bundle name to BDD bundle; preserve real source-derived scope, not generated copy. |
| E — right file map | Ordinary file selection remains visible/searchable and source begins near global navigation. Can retain one semantic navigation/editor tree without new mode | Right file map increases cross-canvas scanning and demands intentional source/tab order. The duplicate Instruction label adds noise. Selected full path must remain recoverable. Footer icons are not a reason to replace working disclosure semantics. |
| F — focus workspace | Broad raw source, explicit Files picker and Exit focus; saved generation and unsaved current state remain visible | Global navigation still occupies its own row while Menu and Exit focus add controls/state and ordinary Files becomes hidden. Width benefit is real as an exploration but mode cost is not earned by the image. Need explicit entry/exit, retained selected path/search/edits and focus return before adopting such a feature. |

### Debate with all five peers

Information and workflow independently preferred B/C/D and initially put F over E; I challenged that E retains ordinary file selection while F introduces mode/Menu/Exit focus despite keeping global navigation. Workflow accepted E over F; information also accepted E over F while retaining the concern about right-side scanning. This is a state-cost judgment, not an assertion that either DOM is already inaccessible.

Evaluation independently ranked B > C > D > E > F > A and emphasized immutable saved-generation continuity across Review/Evaluate/release. Systems initially reached the same order, adding named app/page navigation landmarks, active indication, source-order agreement, compressed B bands and no blanket migration of every page to a Sidebar primitive. After repaired A, systems ranked B > A > C > D > E > F and challenged rewarding new layouts over A’s lower state cost. I accepted A as a credible complete comparator; my C/D lead remains conditional on earned 1024px rail-width gains and proved sidebar/collapse behavior. Evaluation and information revised to B > C > D > A > E > F. C remains a real competitor until sidebar scroll/focus cost is assessed.

Skeptic ranked B > D > C > F > E > A and challenged any automatic veto of D's icon rail. I agreed: D is credible optional UI, and could outrank C if 1024px working-area gains and expanded-label/focus behavior are demonstrated. My C lead is narrow and based on visible labels and fewer new states, conditional on reachable Files. We agree that B's lower source start needs correction. After A was repaired, I reinspected it and removed the crop objection; all six current desktop concepts are valid review candidates.

Across the debate, B is the strongest hierarchy donor; the existing sidebar is not sacred. C offers the clearest one-rail alternative; D offers optional concentration with new-state qualification. No board authorizes new agent execution, auto-publication, fabricated results or tooltip-only critical scope.

### New 37-render desktop baseline

Read `artifacts/layout6-desktop-baseline/summary.json` and representative route JSON. Inspected actual 1024 dirty Draft, 1920 dirty Draft, 1440 keyboard Add entry and workspace keyboard Tooltip. The reported baseline passes 37 captures and current overlay assertions; it records no injected focus or DOM state, preserved dirty edits and unchanged release. This establishes the current family, not a chosen new-layout implementation.

Reported source geometry is 1024: y198 / width598; 1440: y156 / width1006; 1920: y156 / width1342. There is a capture discrepancy requiring reconciliation: actual 1024 dirty PNG visually starts source near y315 with blank main-area space above the header, while matching JSON says y198/scrollY0. The 1920 dirty PNG agrees with y156. I independently reported this to root; do not call the 1024 image exact geometry proof or infer an application regression from the mismatch.

The summary’s generic fine-pointer height-below-32 geometry flags include a 28px brand link and a 17px inline “Manage app credentials” prose link. These are not an automatic blanket requirement to turn every desktop text link into a 32px button. Evaluate actionable controls, separation and pointer/keyboard use in context; retain established coarse 44px behavior. The inspected 1024 dirty JSON lists ordinary navigation/action controls at 32–40px and file rows at 47–67px, with no small-reading-text entries.

## Scoped verdict and required implementation evidence

**Approve exploration based on B's labelled global/bundle/Draft/file hierarchy, with compact shared bands and route-appropriate internals.** C and D remain viable alternatives if measured desktop behavior earns them. This approval is for the design direction and six-way comparison only. No new browser implementation was inspected, and no fresh build or test was run by this reviewer.

Before claiming a chosen implementation approved, obtain actual 1024/1440/1920 desktop renders across Content, Draft/Changes/evidence, Releases, App setup, Bundles, Connections and Members. Compare source top, useful width/height, long labels and nearby action placement against baseline rather than declaring improvement from a generated PNG. Keep a bounded readable document on wide setup/evidence pages without forcing the editor to the same line length.

Exercise navigation/Files expanded and collapsed states actually offered by the choice; keyboard tab order and visible focus; long workspace/bundle/channel/path; Add entry/Draft actions/local Actions open and arrow navigation; hover/focus/Escape supplementary Tooltip; Account/entry/error/creation/release/restore/member/connection dialogs; dirty guards; collapse/resize while focus is inside navigation, Files, menu or editor; retained search/filter/selection/browser edits and exact saved-generation targets. Preserve 320/390px and genuine 640×328 native200 regressions, full decision IDs, explicit missing data and all v5 corrected overlay behavior.

Source-only rare faults and absent states stay labelled. The unchanged comparison's horizontal/AT qualification remains a localized earlier finding, not grounds to replace the desktop exploration with a phone-table-only patch.

## Actual B implementation review

Inspected current `shell.tsx`, `account-menu.tsx` and shared desktop/coarse styles, plus actual final PNGs: dirty Draft at 1024/1440/1920; 1024 Content/App setup; 1440 review/Bundles/Connections/Members; 1920 Releases; entry actions, Account, full-ID evidenced decision and keyboard workspace Tooltip. Also inspected native200 short evidenced decision, short manage-member and keyboard published Actions, plus mobile390 Add entry and mobile320 Connections. Source keeps named Main navigation, bundle navigation/current indicators, native controls, distinct Draft-wide versus entry actions and the existing Dialog/Sheet/Disclosure family.

The actual B source geometry agrees with the images: y197 and widths 774 / 1182 / 1502 at 1024 / 1440 / 1920. At 1440, 1182×648 gives about 12.6% more source area than baseline 1006×676, with source starting 41px lower and 28px less height. This is an explicit width/height tradeoff, not an unchanged-y156 claim. Labels remain readable and scope groups do not visibly collide in the inspected ordinary desktop states. No new focus mode, icon-only rail or metadata pane was introduced.

### Material issue raised before approval

`layout6-edges-final/summary.json` measures a real coarse-pointer regression at 1024px: new header brand/workspace-name links are 32px high and navigation links 33px, below the preserved 44px target. Current scoped desktop selectors outrank the generic coarse rules (`.workspace-desktop-header .workspace-brand`, `.workspace-header-switcher .workspace-switcher-name`, `.workspace-header-navigation .navigation-link`). Sent root the measured issue and selector cause; require corrected coarse rules and passing edge evidence. This differs from the earlier broad fine-pointer flag about a legitimate inline prose link.

The desktop-header→narrow resize focus path was also raised as a source/proof question: the existing effect handles open Sheet→desktop, while a focused desktop-header control can become hidden below 1001px. The prior sidebar had related behavior, so this is not asserted as a new reproduced regression. Obtain actual focus evidence or retain the precise qualification.

At this interim read, standard interactions report 54 states / 196 checks passed and corrected native reports 17 passed. The main desktop summary still reports a geometry threshold failure for 1440 clean Draft; the separate 4-state desktop-geometry run passes. Navigation is still finishing/failing harness qualification. Do not describe every suite as passed until final summaries supersede these interim results. Final scoped approval follows the corrected evidence.

Root confirmed the coarse issue and corrected selectors; this reviewer inspected the matching coarse header overrides in source. Root also added `desktopHeaderRef` resize handling for a focused hidden desktop header→visible Menu/main, and hidden closed Menu→main. The header landmark is now named Application, avoiding ambiguity with the actual Workspace chooser. These changes address the raised source causes; approval still awaits actual rebuilt coarse/focus evidence rather than source alone.

The earlier baseline capture discrepancy is resolved by `layout6-desktop-baseline-2`: this reviewer inspected its actual 1024 dirty PNG and JSON, now both show source y198/width598. The unsettled first baseline image is superseded. Desktop fine-pointer `acceptance-summary.json` now combines the original route/behavior run with the same-build 4-state geometry recheck, explicitly documents changing the unmeasured y192 budget to y200 (actual y197), and reports 41 captures; this is a documented area tradeoff, not a claim the original threshold passed. `layout6-navigation-final-2` reports 25 passing captures, while core `layout6-capture-final` reports 58. These are evidence for the frozen first B build; final rebuilt coarse/resize proof remains the outstanding gate.

### Rebuilt targeted evidence

The coarse regression is cleared in rebuilt evidence: `layout6-edges-final-2` reports all 27 captures passing, including long identities and existing Sheet/Files focus checks. This reviewer inspected actual `layout6-desktop-final-2/1024-coarse-desktop-topbar-focus.png` and its metrics; coarse header targets now retain 44px and fit without collision.

The new dedicated desktop-header breakpoint check reproduced the previously source-only focus concern. Account is keyboard-focused in actual `1024-account-before-resize-focus.png`; `keyboard-breakpoint-focus-failure.png` shows the narrow page after hiding the header, and the parent/systems report the real check fails to focus Open navigation. This is now a reproduced issue, not merely an inferred new regression. The first resize fix reads `document.activeElement` after CSS hiding, when the browser can already have reset it, so `header.contains(active)` misses ownership. Root was asked to retain the pre-hide focus region and rerun real keyboard input. Final whole-change approval remains withheld until that specific focus result passes; coarse correction and fine-pointer visual approval stand.

A later `layout6-desktop-focus-build2` diagnostic reports 3 passing states with fingerprint `e1ceb3…`; this reviewer inspected those three PNGs. Root explicitly confirmed that build still uses the earlier active-element resize handler, while the current source ownership-ref change has **not** yet been built. Therefore the later pass and earlier failure characterize timing/intermittence of the old build; neither proves the new source fix. Do not associate the diagnostic with the newer source ownership-ref fix. Final approval remains withheld pending an explicitly identified fresh build and its actual coarse/focus evidence.


## Final build3 acceptance

**The coarse-target and resize-focus blockers are resolved on the explicitly bound final build.** This reviewer read the accepted summary and stress results, inspected current ownership-tracking source and Account’s explicit return-focus ref, and inspected representative actual accepted PNGs. The accepted summary reports 46 captures, 28 passing checks, no failures, no geometry violations, no focus injection and equal `173687e7…` fingerprints before/in-run/after cleanup.

Actual final images inspected include coarse 1024px topbar and focused Account, 899px focused Menu, editor focus and retained text across resize, open Account dialog with focus still inside, Escape after its invoker becomes hidden, dirty Draft at 1024/1440/1920, and full-ID evidenced release. Additional final-build samples include native200 short evidenced release, mobile320 full-name Sheet and phone local invalid-package error. These show the intended visible result; assertions supply focus and exact state evidence that a still image cannot establish.

| Final evidence | Scoped result |
| --- | --- |
| `artifacts/layout6-desktop-accepted/summary.json` | 46 captures / 28 checks passed. Named labelled global and bundle navigation, current route states, menus/dialogs/Tooltip, 44px real coarse header controls, geometry and retained edits. Positive header→Menu→main resize handoff passes. Negative checks retain editor focus/unsaved text and open-modal focus; Escape with a hidden Account invoker falls back to visible main. |
| `artifacts/layout6-desktop-focus-stress-build3/summary.json` | Same build3; native keyboard reaches Account, then ten immediate 1024→899→1024 cycles pass all 20 Menu/main handoffs. No screenshot settling between resize and assertion; no focus injection. |
| `artifacts/layout6-interactions-build3-summary.json` | Fresh fixed-asset build3 runs: 54 standard + 17 corrected native + 25 navigation = 96 captures / 418 passing checks. This reviewer read their underlying summaries. Real short 640×328 native200 modal controls and full identities remain reachable; phone errors stay inside active Dialog; full touch workspace name remains visible. |
| `artifacts/layout6-edges-final-3/summary.json` | 27 passing captures. Long identities across 1024/900/768/600/390/320, Sheet/Files resize focus, two-file edit retention, repeated save/guard focus and exact saved candidate; no browser errors reported. |

The accepted layout earns its desktop tradeoff: at 1440px source is 1182×648 starting y197, compared with 1006×676 starting y156. It is 176px wider, 28px shorter and 41px lower, with about 12.6% more source area. At 1024 and 1920 the accepted source remains 774×516 and 1502×828 respectively. This is a measured choice, not a claim of unchanged geometry or a pass obtained by shrinking typography. Reading text remains 14px, coarse controls retain 44px, and touch source/inputs remain 16px.

Systems independently agrees that final build3 proof resolves both blockers. Information, workflow, evaluation and skeptic reviewed the same final evidence boundaries; earlier design disagreements about A/C/D remain valid alternatives, not unresolved material objections to B. The implementation keeps labelled global destinations, separate bundle scope, whole-Draft actions, local entry actions and existing bounded overlay primitives, with no added focus mode or forced icon rail.

Remaining limits are explicit and nonblocking for this desktop change: the unchanged wide evidence table has not received new horizontal-keyboard/AT association qualification; screenshots do not certify Safari or screen-reader behavior; native option-popup appearance is platform-owned; rare storage/service/permission and live evaluator branches are not all rendered. Missing outcomes/grades, unknown cost, complete≠win wording and full decision identities remain preserved. The full build3 BDD suite was still running when this reviewer issued approval, so its success is not claimed here. No application edit, build or test was run by this reviewer.
