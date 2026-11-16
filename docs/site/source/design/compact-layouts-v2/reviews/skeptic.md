# Skeptical newcomer review

Reviewer: product simplification / newcomer skepticism. Initial review, 2026-11-14. This is not approval of a future implementation.

## Evidence inspected

- Actual populated screenshots: `artifacts/shadcn-capture-final/screenshots/desktop-draft.png`, `desktop-library.png`, `desktop-sdk.png`, `desktop-members.png`, and `mobile390-draft.png`.
- Product boundaries in `docs/design/overview.md` and README.
- Existing compact-layout rationale and the shell, draft workspace, bundle library, members, and app-setup components.

The product is a place to maintain and deliver versioned instructions, skills, and approved reusable memory. Applications still run and evaluate agents. The interface must make editing, comparing, and publishing those files straightforward without implying hosted execution.

## Initial material objections

1. **Mobile authoring spends too much of the screen explaining the screen.** At 390px the editor begins around y444. Top bar, bundle/channel row, view tabs, draft status, workflow steps, actions, Files disclosure, and entry header precede the text. The user cannot meaningfully read and edit on the first screen. Reducing font size or the 44px touch targets is not an acceptable fix. Remove or combine redundant hierarchy and workflow chrome.
2. **The draft has two workflow descriptions competing with its actions.** “1. Edit draft → 2. Evaluate → 3. Publish” adds little when Save, Review changes, and evaluation are immediately beside it. It also risks suggesting a mandatory, entirely console-run pipeline. Preserve the real saved-snapshot and publication safeguards, but make the current next action clearer and keep a process explainer contextual.
3. **Saved-state labels expose mechanics before meaning.** “Generation 1 saved · Unsaved changes” is accurate but forces newcomers to reconcile two states. Prefer “Unsaved edits” with an explicitly secondary route such as “Evaluate saved draft” and enough context to identify its snapshot. Never silently evaluate browser edits or hide which saved snapshot will be used. Generation IDs still belong in history/details and wherever they disambiguate evaluation evidence.
4. **Channel scope needs a deliberate location.** A primary Channel selector at the top right can look like a global filter, editing target, or publish destination. Keep its scope visible when necessary, but bind the label to the bundle's delivery/release context and ensure changing it cannot silently discard edits. Do not duplicate it in multiple permanent bars.
5. **The setup page is correct but reads like a prerequisite document.** Ownership text, language controls, package sourcing, access instructions, environment caveats, then a collapsed recipe is substantial scanning before trying the integration. Keep the three concrete steps and real prerequisites, but tighten their prose and make their actionable material immediately identifiable. Do not invent a public package install command: current installation genuinely uses built artifacts.

## Things that should not be “fixed” by adding UI

- The library and members page contain one real item each. Their whitespace is not evidence that they need metrics, recent activity, onboarding cards, or oversized sample data. Use a coherent list/table and let the page be short.
- Existing navigation has just Bundles, Connections, and Members. Turning these into unexplained icons saves little at a high recognition cost. A narrow labeled rail or a plain labeled top navigation can work.
- A permanent inspector would make the authoring task narrower to show low-frequency metadata. Use explicit Details, History, or Review actions instead.
- “Memory” must remain approved shared files, not an invented chat-history browser. “Evaluate” must be a handoff to app-owned execution and evidence, not a Run agent button.
- Do not promote service IDs, hashes, generations, storage paths, or recovery internals to permanent hero text. Keep essential error/recovery states visible when they occur.
- Dense rows can be good; compressed typography and tiny ambiguous controls are not density improvements.

## Competing architecture preferences

**First preference: narrow labeled workspace rail, one bundle header, local workbench.** The rail contains workspace selection and the three real destinations. A single compact bundle/header row communicates bundle and channel, followed by local tabs. The draft combines status and primary actions in one toolbar; files and the selected entry share the remaining space. This is the least conceptual change and preserves recognition.

**Serious alternative: labeled top workspace navigation with bundle switcher, then local workbench.** This gives the editor more width and can remove redundant top/back context. It is compelling if the top row remains readable with long names and many workspaces, and if local tabs do not become a second crowded nav system. On narrow screens it still needs an explicit menu and Files selector.

I would reject a unified tree mixing members/connections with bundle files, an icon-only tool rail, a dashboard landing page before the bundles, or a three-column default. These solve visual composition more than the user's task.

## Minimum acceptance before approval

- At 1440×900, editor text starts no lower than the existing y252 baseline, and the editing area does not get narrower than 650px or shorter than 360px. The redesign should produce a demonstrable task-space gain, not merely different ornament.
- At 390px, aim for the text to start by y340, leaving roughly half of an 844px screen for actual content. No horizontal page scrolling; selected file and Files control remain identifiable. A clearly justified small variance is preferable to cramming controls.
- Visible UI text is at least 14px; editor text remains 14px desktop / 16px touch. Interactive touch areas are at least 44px. Full paths must be available without hover.
- The user can identify workspace, bundle, selected file, saved/unsaved state, and the primary next action without opening a disclosure. Do not repeat those facts in every bar.
- The common tasks remain visible or live under a clearly named menu: add/import, change file, edit, review changes, save, evaluate the saved snapshot, inspect history, and publish after review. Menus must not replace all concrete action labels with an ellipsis.
- Editing, saving, dirty-navigation protection, snapshot-specific evaluation, explicit publication review, error and unknown-outcome recovery must still work. Simplifying presentation must not weaken their semantics.
- Inspect real populated library, draft, app setup, members, mobile, long names/paths, and 200% zoom. Generated mockups cannot establish acceptance.
- An implementation receives approval only after inspecting its actual screenshots and behavior. An attractive concept or agreement among peers is insufficient evidence.

## Six actual concept images

Viewed all six raster outputs, not only their prompts. Ranking: **A > B > C > D > E > F**.

| Concept | Useful exact part | Objection / disposition |
| --- | --- | --- |
| A | Single bundle/channel/tabs row; separate compact draft bar; always visible file list; quiet utility footer | Preferred base. Its single desktop context row must break deliberately for long names and 200% zoom rather than shrink type or push tabs offscreen. Copy still overstates generation machinery. |
| B | Labeled global top navigation; broad file/editor workbench | Credible competing architecture, but it restores an extra horizontal navigation layer and deeper editor start. Do not change all navigation only to recover width that the existing editor already has. |
| C | Earlier editor and explicitly separated global top navigation | Bundle destinations and draft files compete in a long local rail. Many files would push useful navigation out of view. Borrow explicit group separation, not the mixed rail. |
| D | Files picker shares a row with selected file, useful at narrow widths | Hiding the entire file list by default on desktop creates a discoverability cost with little need. Good narrow-screen adaptation, weak desktop default. |
| E | An intentionally opened review state can explain a change | Permanent third column narrows source and comparison into wrapped paragraphs. The depicted saved-draft-vs-browser label does not match the current component's published-parent-vs-browser comparison; do not implement this invented semantic label. |
| F | Small named Import / History / Details utilities | Accordion documents make access to the next file depend on the first file's length. The source begins much later, and generic Markdown badges erase meaningful instruction/skill/memory kinds. Reject as authoring architecture. |

All six images show only drafts. They provide no evidence that the library, setup, evaluation, and releases become clearer automatically. No concept can establish working responsive behavior.

## Peer debate and decisions

I challenged the workflow reviewer on jargon, duplicate status, action overload, and whether the permanent stepper actually helps. We agree to remove the stepper while preserving always-visible saved/unsaved semantics. The reviewer made a sound objection to shortening the dirty-state evaluation action too aggressively: a label may be encountered alone by a screen reader or separated from status by responsive wrapping. **I accept retaining “Evaluate saved generation N” on the dirty route when it is necessary to disambiguate the saved target.** Prefer shortening redundant neighboring prose before deleting that identity. “Evaluate saved draft” is acceptable only with one unambiguous saved identity in the same robust context; “Evaluate” alone is not.

I challenged the visual reviewer against a new dashboard, metrics, decorative context, or architectural changes made only to fill empty collection pages. They agree collections should remain simple aligned rows and rank the concepts identically. They challenged removal of workflow chrome if saved-versus-browser state becomes hidden; I accept that constraint. They propose completed request/evidence first on evaluation pages. I support that hierarchy conditionally, with pending/failed/new-request paths discoverable and the selected request clearly bound to its evidence.

The workflow reviewer correctly notes that a compact draft does not settle the evaluation and release hierarchy. We agree on a compact single-column evidence flow: one selected saved draft/version identity; concise request/result rows; selected request's evidence immediately below; deliberate publish action with a genuine blocked-state reason if relevant. Other history and provenance can be secondary. Do not add a permanent evidence rail or scoreboards. Do not label the action “Run evaluation,” since applications own execution.

I would block publication UI that omits the bundle, channel, specific candidate, or intended action, hides material missing/stale evidence, or presents manual publication as the default. A required reason remains where the real workflow requires it. The existing missing-outcome safeguards must remain available when needed.

## Recommended hybrid

Use **A's labeled rail + one context row + compact workbench**, retain the visible file list at wide widths, and use **D's clearly labeled Files picker at narrow widths**. Remove the permanent edit/evaluate/publish stepper. Keep one explicit saved identity, dominant dirty state, and the necessary exact-snapshot evaluation label. Preserve meaningful file kinds and named Entry actions. Keep Import, History, and Details secondary, without expanding a permanent inspector. Use responsive wrapping based on actual names and control widths; do not try to force A's generated one-line header at every desktop size.

## Review state

### Actual implementation: capture 3

Independently viewed every desktop route (draft, content, library, connections, evaluation, releases, setup, members), their 390px counterparts, the 390px draft-action menu, and the 320px draft, long-scope/full-path, and open navigation screenshots in `artifacts/layout2-capture-3/screenshots/`. Also read draft measurements rather than estimating only from image proportions.

**Conditional verdict: no material layout or product-scope objection remains in the inspected implementation.** Final completion still depends on the corrected dirty-menu cancellation/focus behavior and honest native 200% zoom evidence reported as pending by the implementer. This statement does not independently certify unobserved behavior or zoom.

The actual implementation resolves the largest initial objections:

- Desktop editor begins at y156, measures 1006×676, and keeps all four files visible. The earlier real baseline was y252 / 966×608; this is a material task-space gain with readable text.
- At 390px the editor begins at y333.4 and measures 364×620. The primary Save action and clearly named Draft actions menu replace the repeated workflow/action layers. The menu explicitly names “Evaluate saved generation 1,” retaining exact saved-state semantics.
- The bundle title, channel, local destinations, and back route occupy one scope region. There is no separate generic context band or process stepper. The full long 320px bundle title wraps instead of truncating or overlapping tabs; its selected full path remains readable without hover.
- Labeled workspace navigation remains recognizable. The 320px saved-state continuation wraps to two lines without squeezing its touch target. Omitting the kind pill there is acceptable: file icon/path and Entry actions retain the necessary identity and editable type. The 390px kind label remains visible.
- The library and members page remain honest short collections. No metrics, filler activity, agent-execution controls, or expanded product promises were introduced.
- Setup retains three concrete steps, actual build-artifact requirements, private credential handling, and delivery-check commands, while trimming repeated ownership prose. Its language controls are legible and reachable.
- Evaluation results precede creation of another request. “Inspect evidence” is a concrete action. “Publish without evaluation” remains a secondary named disclosure; no blank decision card or misleading Run evaluation button occupies the page.
- Release history uses plain revision/current/manual-release labels and an explicit Inspect action. The current screenshot is not evidence of a publish-dialog interaction, so workflow behavior still needs its relevant verification.

Two remaining observations are nonblocking polish: desktop Connections exposes both “Refresh connections” and generic “Refresh”; and the 390px library description wraps over four lines beside New bundle. Neither prevents task discovery, weakens state semantics, or justifies more architecture. Do not trade readable text or touch targets to erase them.

The draft JSON reports no sub-14px visible reading text and no undersized touch controls at 390px. I inspected the rendered appearance and measurements, not a comprehensive accessibility audit. The final zoom/focus evidence remains the only pending review condition from my perspective.

### Final verdict: capture 5

**Approved from the skeptical newcomer/product-simplification perspective. No material objections remain in the inspected final interface.** This supersedes the conditional capture-3 verdict.

I independently inspected capture 5's 390px draft, native 200% draft, native 200% setup/evaluation/library, final Connections page, selected reported evidence, and both manual and evidence-backed release dialogs. I read the final capture summary and the focus assertions in `scripts/testing/compact_console.py`.

The native zoom evidence is now honest: 1280×657 screenshot pixels, 640×328 CSS viewport, document scroll zero and editor scroll zero. The editor starts at CSS y243; its first source lines are visible immediately. It does not pretend that all content fits in the small zoomed viewport. Setup, review, and library wrap without clipping their primary identity/actions. The review page now says “Review saved change” beside its saved generation, clarifying the activity instead of relying on a generation number as the title.

The selected evidence is explicitly bound to candidate/request/attempt and shows the paired results before “Review release with this evidence.” Both release dialogs name bundle, target channel/current revision, published parent, and exact candidate/generation. The manual path plainly says no evaluation supports the release and displays its reason. The evidence path names the selected evidence. Back to review remains available. This addresses my initial publication-context conditions without adding fake certainty or automatic execution.

The capture runner now asserts that dirty-menu evaluation followed by Keep editing preserves the text and returns focus to the persistent Draft actions trigger; first save focuses the remounted Continue to evaluation link; Sheet Escape and destination-main focus also receive checks. The final summary reports 35 captured states, no failures, no browser errors, retained release state, and zero paid model calls. That is appropriate evidence for the previously pending focus conditions; it is not a claim of a comprehensive accessibility audit or hosted deployment qualification.

The duplicate Connections refresh action is gone. No extra product features, dashboard metrics, execution promises, or permanent inspectors have crept into the final layout. Remaining opportunities, such as shortening the library's narrow-screen description, are optional polish and do not prevent approval. The separately ongoing full behavior run must still finish before the implementer claims the whole change is verified; my interface verdict does not claim its result in advance.
