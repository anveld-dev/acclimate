# Independent visual/interface review

Reviewer: visual and interface architecture. Baseline inspected: the real desktop draft, library, evaluation and connections screenshots and the 390px draft screenshot in `artifacts/shadcn-capture-final/screenshots`.

## Initial verdict

The baseline has made the editor usable on desktop, but it is still a stack of application headers around a workbench. A second round should change the composition, not merely shave padding. The most material problems are the mobile editor's late start, the evaluation page's weak evidence hierarchy, and collection pages that surround a tiny amount of content with large repeated enclosures.

The neutral palette and plain labeled sidebar are sound. Keep the common shadcn Mira vocabulary, dark primary actions, readable text and subtle separators. No decorative color, illustration, invented chart, or density for its own sake is needed.

## Concrete baseline findings

1. **Mobile draft spends half the viewport on orchestration.** At 390px, the top navigation occupies about 54px, title/channel row about 65px, tabs another 36px, draft controls about 182px, file selector about 44px and file header about 62px. Raw text begins near y=460. The title row and tabs are understandable, but all three stages and all three actions are simultaneously expanded above the task. The primary next action should occupy a compact sticky action row; workflow and secondary actions should have a named local menu or drawer. Keep the saved-versus-dirty meaning visible in a short status label.
2. **The desktop draft has two unrelated horizontal navigation bands.** Back to bundles and Refresh occupy the topmost 48px. Bundle identity/channel then occupy another row; tabs follow; Back to changes sits at the opposite edge of those tabs. The user reads backward links at different levels of the same page. Combine bundle scope into a single compact breadcrumb/identity row and put the local return link in the draft context, not in the global navigation lane.
3. **The draft action row does not establish one clear action hierarchy.** Draft state sits left, a stepper sits in the center, then Review changes, Save draft, and Evaluate saved generation 1 compete across the right. This also causes mobile stacking. Dirty means Save draft is primary; Continue to evaluation belongs after saving. The saved-generation route can remain available as a labeled secondary action with its generation provenance preserved.
4. **Editing chrome should look like a coordinated pane.** The entry header starts at x=453 but the text body starts at x=468; the tree has a slightly different inset and native-looking controls. A strong focus border wraps the whole textarea while the pane header has its own border. Use a single coherent file-pane boundary and consistent 12–16px content insets. Preserve a clear keyboard focus indicator without making the resting editor look permanently focused. The selected tree row is nearly full-width and readable; retain that strength.
5. **The file pane gives all controls equal width without useful grouping.** Add entry, Search files and type filter are three successive rows above four entries. This is acceptable for many files but consumes 150px of tree height for the baseline four. Put add beside a Files heading, then the search field, with type filtering secondary. Do not put Add entry in the global command row.
6. **Evaluation is vertically organized but visually unstructured.** Its main enclosure spans almost the entire 1200px canvas. A dense title/stepper/provenance row leads into a full-width sequence of accordion lines. Evaluation results, request details, publication prerequisites and publication escape route share similar visual weight. The useful object is the completed request and its evidence. Make that the primary central surface; stage/provenance belongs in a compact rail or header and publication belongs in a clearly separated next-action region. Avoid another nested card stack.
7. **The evaluation reading measure is too long.** Introductory instructions run across most of the page. Use a comfortable reading column for explanations and evidence detail, while allowing tables or raw output to use remaining width when necessary. Prefer a two-column desktop work area over arbitrarily huge paragraph width. Do not shrink text to fit more content.
8. **Library is framed as a large object card without enough object information to warrant it.** A roughly 87px-tall full-width card contains one name, generic Created content text, a channel and arrow. A 48–56px directory row with column alignment would communicate the same thing more efficiently and scale to real lists. Keep the title/action row close to the list. Large empty space is acceptable with one record; do not fill it with fake metrics.
9. **Connections has redundant nesting and context.** The page title is followed by a large Workspace connections accordion, a full workspace ID, a prose explanation, then a second bordered app record. The workspace is already selected in the sidebar. Move the explanatory content to a concise help disclosure; show the actionable connection rows directly. Keep a visible workspace cue where ambiguity requires it, with the full ID accessible through a labeled detail action. New connection belongs beside the connection list heading.
10. **Global typography needs fewer competing emphases.** Repeated 14px semibold headings, disclosure labels and action labels make every line feel equally important. Use a clear title/body/meta ladder: page titles around 20–22px, section or object names 14px medium/semibold, ordinary labels 14px, provenance 12–13px muted. Preserve 14px desktop monospace and 16px mobile monospace. The current page titles are already close to this target.
11. **Use shared alignment rules across routes.** Page titles at x=216, section content at x=233 and object text at x=250 are individually defensible, but repeated nested 16px padding makes Connections look recessed and Evaluation look like a document inside a document. Use one page gutter and one local pane inset. List rows and their heading should share their text alignment.

## Architectural directions worth comparing

These are distinct compositions, not six treatments of the same card.

- **Compact workbench.** Keep labeled global sidebar. One bundle context row, compact local tabs and a single draft command strip. File tree and editor fill the remaining area. Mobile turns the file tree into a sheet and secondary draft actions into a named menu. This is the least disruptive and strongest default.
- **Top-shell workbench.** Put app navigation and workspace in a compact top shell, then give the bundle editor the full viewport width below. Use a small bundle strip and independent file pane. Gains width, but must demonstrate real global navigation reachability at 200% zoom.
- **Context rail.** Keep global sidebar narrow and place bundle views in a second compact rail above a genuine work surface. Do not mix global navigation and editable files into one unlabelled tree. Worth testing if frequent switching between Content, Changes and Releases is central.
- **Document focus.** Start from a full-width editor with a labeled file switcher. File navigator opens as an explicit pane. Favorable on touch or narrow laptops, less good for frequent file comparison; desktop must show current full path without hover.
- **Stage-and-evidence workspace.** Evaluation gets a small vertical stage rail and a main evidence/request surface, with provenance visible at the top and Publish as a distinct next-action area. Draft can share the shell without permanently carrying an inactive inspector. This direction is the strongest evaluation-specific architecture.
- **Collection-and-detail workspace.** Bundles and Connections use aligned directory rows and an optional adjacent details pane. The editor still gets its own workbench. This removes oversized nested enclosures without pretending all routes need the same content structure.

## What would block my approval

- At 390px the first editable text remains below roughly y=380 with no compelling required content above it, or important actions require horizontal scrolling.
- Desktop still presents multiple scope headers and a second full navigation layer above the work area without a clear role for each.
- Evaluation still makes the user hunt through equally weighted disclosure rows to find completed results and the next required evidence review.
- Connections still nests a record in a large accordion/card solely to restate the selected workspace.
- Text is made smaller to achieve compactness, full paths depend on hover, or controls become ambiguous icons.
- Generated concepts invent features or their visual polish is used as evidence of an implemented behavior.

## Acceptable tradeoffs and non-blocking preferences

A single-record list will leave empty space; that is fine. Retaining the labeled left sidebar is reasonable. I prefer separators to cards for collections, but a coherent single list enclosure is acceptable. A compact horizontal step indicator is fine on desktop if its provenance and action rows do not compete. A subtle olive selected-file tint is acceptable. No need to add a right inspector unless an actual user task justifies its permanent space.

## Review status

Initial review only. I have not yet reviewed fresh generated variants, peer objections or the new implementation. Prior-round approval claims do not count as evidence for this round.

## Fresh image review and debate

Inspected all six actual generated PNGs, A through F; F was reopened separately after the first tool output exceeded its image budget. Ranking: **A > B > C > D > E > F**. The ranking concerns the actual composition in each image, not the prompts or the accuracy of generated copy.

- **A:** Best default. It removes the standalone back/refresh band and places bundle/channel/views in one scope region. The command row and files/editor region are legible. The row must not be implemented as an impossible `nowrap` constraint. The image still spends three file-pane rows on add/search/filter; group Add with Files and treat filtering as secondary if needed.
- **B:** Strong alternate architecture because top navigation releases editor width and leaves file navigation visible. It wastes vertical space between scope, command and workbench regions in the generated output. Borrow its clean alignment and source width; do not undertake a global-shell rewrite solely because the render looks wide.
- **C:** Early source position and full path visibility are strengths. Mixing bundle destinations and draft files in one long rail ties file discoverability to the height of unrelated navigation. A long title/channel or shorter viewport pushes files down. Use separate labeled navigation regions if borrowing anything from C.
- **D:** Good constrained-width fallback. A Files disclosure creates a broad source surface. Bad desktop default while there is enough room for the full file pane: known neighboring files disappear and switching becomes an extra action. Retain visible file navigation at normal desktop width.
- **E:** Useful explicit review mode. The before/after source and browser-versus-saved wording make the review's scope clear. Do not keep that inspector open by default; three columns produce excessive code wrapping. Below the fit breakpoint it must replace or stack the work surface with clear Close review navigation and focus handling.
- **F:** Reject as default editor architecture. The polished collection shares a toolbar elegantly, but the source begins substantially lower and other files follow the height of the active document. A long document makes file switching expensive. This is a reading/list pattern applied to a workbench task.

### Exact implementation hierarchy

1. Keep the labeled global sidebar at comfortable desktop widths. Collapse global navigation before crushing source or bundle identity.
2. Use one **scope region**: immediate-parent return, bundle identity, labeled channel, and four local views. At wide widths it can be one row. At constrained widths title/channel may wrap and local views may occupy their own row. A single region does not require a single physical line.
3. Use one draft command region. Desktop: short Draft, saved generation and dirty state; Review changes; primary Save draft when dirty; explicit Evaluate saved generation N secondary route. The editor does not need an inline stage stepper.
4. Use one coordinated workbench with a file pane, selected full path/entry actions header, source and named footer utilities. Align section edges; use one pane inset. Keep ordinary 14px desktop UI and monospace text; 16px touch source.
5. On touch, use a compact global return/menu row; wrapping bundle/channel; local views; short visible Draft/saved-generation/dirty context with Save; Files disclosure plus selected-path and Entry actions context; then source. Secondary draft actions may use a named More draft actions menu if workflow review accepts it. Do not simply allow all desktop buttons to wrap into the original tall controls stack.
6. Evaluation should use compact provenance, selected request state, its evidence/Inspect evidence action, then distinct publication next action with current state reason. Other requests/history can be secondary. Pending, failed and create-request paths must remain discoverable; do not imply evidence always exists. The source screenshot's equal-weight accordion stack is a real hierarchy issue, not a request for page symmetry.
7. Library and Connections use aligned records with one enclosure at most. Do not add metrics, activity or decorative cards to fill the naturally empty single-record view.

### Substantive peer challenges and responses

- **Hierarchy:** Challenged A's single-line promise at 1024–1180px and long names. I accept the challenge: preserve one scope region while allowing multiple lines and earlier sidebar collapse. I challenged C's mixed tall rail; hierarchy changed its ranking to A > B > C > D > E > F after that and editor's similar critique.
- **Accessibility:** I challenged natural reflow alone because it can technically pass while reproducing the baseline's y460 source start. Accessibility accepts the exact compact mobile composition provided Save, generation and dirty status remain visible, More draft actions is a named 44px real menu with full action labels and keyboard/focus behavior, and full paths remain available without hover. This is conditional guidance, not implementation approval. We both require actual 390/320 and 200% captures, allowing legitimate long-name growth.
- **Skeptic:** I challenged deleting workflow chrome without preserving browser-versus-saved provenance. Skeptic agrees the stepper can disappear but the saved generation and dirty distinction must remain visible. Skeptic supports evidence-first evaluation if selected request identity stays coherent and pending/failed/new-request paths stay discoverable. We agree no filler cards on sparse collections.
- **Workflow:** Requested explicit review of the proposed secondary-action menu; accessibility acceptance is not a substitute for workflow acceptance. Awaiting response.

No final approval: actual responsive implementation, state variants and evidence-first evaluation remain to be inspected.

Workflow response resolves the menu condition: dirty/new draft keeps visible Save and full saved-generation route in More draft actions with guards preserved; **saved/clean draft replaces Save with visible primary Continue to evaluation**. Do not leave a disabled Save in the prime position while hiding the actual next step. Review changes may remain secondary. I accept this stronger state-dependent action hierarchy; no additional row is necessary.

## Real implementation review, capture 3

Inspected actual `artifacts/layout2-capture-3/screenshots` images: desktop draft, evaluation, connections and library; mobile390 draft, evaluation and SDK; mobile320 long scope/path. The conclusions below concern those eight captures. Focus recovery, native 200% zoom and final clean/new state captures remain pending, so this is not final signoff.

### Findings resolved

- Desktop source begins at y156 and fills a coordinated pane rather than sitting below stacked application headers. The compact scope region retains a readable title/channel and local views. Sidebar and file pane retain labels; source is comfortably wide.
- Mobile source starts around y333, materially above the baseline near y460, while preserving saved-generation/dirty status, visible Save and a named Draft actions control. The 16px source has a usable measure. No cosmetic small text was used to achieve the improvement.
- Files heading and Add entry now share a row. Four baseline files are immediately visible. Search/filter remain accessible without dominating the file pane.
- Library is a clean record row. Connections removes the nested workspace enclosure and moves explanation/workspace details to a named disclosure. The selected app is now the clear list object. Empty space is honest and does not require filler.
- Completed evaluation request and Inspect evidence appear before new-request utilities. The hierarchy is considerably clearer than the baseline. Mobile wraps request identity/state/time without horizontal overflow.
- At 320px, the long bundle name receives a full-width heading and wraps into three readable lines. The long full path wraps, is available without hover, and does not force horizontal page scrolling. Legitimate growth from real scope/path data is acceptable.
- SDK install/configure/delivery steps use clear headings and comfortable body measure; the language toggle and Copy recipe are visibly usable touch controls.

### Minor concrete refinements

1. The evaluation header now says only **Generation 1 saved**, losing the stage name that the removed stepper/header previously provided. Prefer a compact explicit heading such as **Evaluate saved generation 1**. This communicates the current task without adding a row. The Evaluation results heading does eventually orient the user, so this is a polish request rather than a material layout block.
2. Connections still puts **Refresh connections** and global **Refresh** adjacent at the top. Their apparent scopes overlap. Consolidate if they perform the same relevant user task, or keep only the route-specific refresh in this context. This is a small residual hierarchy issue, not a reason to reopen the architecture.
3. The desktop editor's strong olive focus border is still visually prominent. It is acceptable if this is actual keyboard focus in the capture; do not render the focused styling permanently at rest. This remains a non-blocking verification detail.

### Conditional verdict

No material visual objection remains in these eight capture-3 layouts. The earlier architectural concerns are substantively resolved. Final signoff is conditional on the final responsive/zoom evidence and state/focus checks; I have not inferred those outcomes from static images.

## Final visual verdict, capture 5

**Approved: no material visual or interface-composition objections remain in the reviewed implementation.** This verdict is based on real implementation evidence, not the generated concepts.

For the final pass I inspected capture-5 desktop evaluation and Connections, mobile390 draft, mobile320 long scope/path, native200 draft, mobile320 focused tab, desktop selected evidence, and both manual and evidenced release dialogs. I also read the capture summary: 35 states passed with no reported capture failures or browser errors. The final broader behavior run is outside this visual verdict and must be reported independently.

Both minor capture-3 requests are resolved. **Review saved change** now gives evaluation an explicit task heading while **Generation 1 saved** remains adjacent as provenance. Connections now has one clearly scoped **Refresh connections** action. These fixes improve orientation without adding navigation rows.

The 200% native screenshot shows the source's first lines in the initial viewport, readable scope/actions and a coherent responsive layout. The 320px focused-tab capture shows a visible inset focus ring that stays within the tab region. Its clean draft state gives **Continue to evaluation** the primary position and keeps generation/readiness text visible; it does not strand a disabled Save above a hidden next step. The long bundle/path capture retains readable wrapping without horizontal page overflow.

Selected evidence is a clear primary section with candidate/request identity, actual inventory and a Parent/Candidate table, followed by the explicit review-release action. The evidence dialog names selected evidence and uses **Publish with selected evidence**; the manual dialog states that no evaluation supports the release and uses **Publish without evaluation**. Their final-action labels keep the two routes visually and semantically distinct. The dialogs preserve readable details and a visible Back to review action.

The implementation retains the strongest parts of A, uses file disclosure where width requires it, avoids a permanent review inspector and avoids F's document-height-dependent file navigation. The architectural objections raised in this review have been addressed; further cosmetic densification is unnecessary.
