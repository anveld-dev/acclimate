# Information hierarchy review

## Evidence and material issue

Read the current shell, bundle route, content, draft workspace, file navigator, shared components and CSS; inspected all eight v6 desktop page captures, Add entry, Entry actions, both publication confirmations, and the accepted long-name 1024px captures. The existing hierarchy is sound: account/workspace controls, workspace navigation, bundle/channel/views, whole-draft commands, then file selection and entry commands have distinct scopes. Review, Releases and App setup do not need an editor-shaped sidebar. Connections and Members remain workspace pages.

One concrete defect earns refinement: at 1024px the long bundle title occupies roughly 210px and five lines beside a roughly 490px channel selector. Tabs wrap beneath it. Source confirms a fixed 220px title basis that cannot grow. This is avoidable allocation overhead, not a reason to replace the shell.

## Six actual alternatives

Inspected A–F PNGs and their exact prompts. Visual ranking: **C, A, E, B, F, D**. Implementation preference puts B before E because A/C solve allocation without changing the native selector.

- **C:** Best compact relationship: wide identity, then channel/views, then existing local bands. Its single-line long title is optimistic; retain honest wrapping and the current Draft label.
- **A:** Strongest truthful wrapping model. Two identity lines are preferable to a skinny five-line column. Borrow this fallback with C’s quieter strip.
- **E:** Readable title/channel allocation, but multiline selector implies unnecessary primitive replacement; the extra path band also spends height.
- **B:** Clear scopes, but balanced columns and stacked Channel label preserve competition and add height/divider emphasis.
- **F:** Earlier source start does not establish larger usable area. Moving unsaved status and saved-generation evaluation below source and expandable utilities weakens the temporal cue.
- **D:** Parent bundle navigation consumes the file column before Files; evidence tables also lose width. This combines different scopes without an earned benefit.

All generated leading `/AGENTS.md` paths are rejected. Generated typography and omitted labels are not requirements.

## Debate and decision

Debated all five peers. Systems/workflow favor C>A>B>E; evaluation agrees with my visual E>B; accessibility/skeptic prefer A>C because A visibly admits wrapping. I accept their objection to treating C’s single line as narrow-screen proof, and their implementation objection to E. Everyone supports targeted A/C allocation over new navigation modes or merged draft/file bands.

The implementation earns acceptance independently of ranking: intrinsic grouped flex gives identity room before channel/views, retaining the native picker and ordinary one-row density. It needs neither title-length heuristics nor a new mode. No further visual generation round is warranted for this hierarchy.

## Runtime disposition

**Approve the observed composition on build `837fea…`.** Inspected new actual captures in `artifacts/desktop7-desktop` (all eight 1440px pages, Entry actions and evidenced decision) and `desktop7-scope` (long 1024px fine/coarse, long 1440px, ordinary 1440px, App setup and Releases). Full title/channel remain visible. Matched coarse 1024px source moves from y=438 to y=352; ordinary source stays y=197. The two local draft/file bands remain distinct, with saved-generation wording intact. Slash-boundary file wrapping removes the stranded `s/` without hiding paths.

The 46/27/21 capture summaries report passing checks; this is a hierarchy review of those actual states, not independent execution or complete interaction/accessibility qualification. Platform-native popups, rare faults and unrendered permission combinations remain outside my visual evidence. No app edits or tests run by me.
