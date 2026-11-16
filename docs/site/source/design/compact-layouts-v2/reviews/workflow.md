# Workflow review — compact layouts v2

Reviewer: independent product/workflow review. Baseline inspected: desktop-draft, desktop-evaluation, desktop-releases and desktop-sdk screenshots under artifacts/shadcn-capture-final/screenshots; matching DraftWorkspace, ImprovementWorkspace, BundleReleases and SdkSetup components. This review does not change the app.

## Product model to retain

Acclimate stores, versions and delivers context bundles. The consuming app runs its own agent, tools and evaluations. Browser edits, a saved immutable generation, a reported evaluation and a channel release are four distinct states. A compact UI must clarify those states through information hierarchy instead of repeating explanatory paragraphs.

## Material redundancies

1. The draft toolbar puts a Draft heading, saved/unsaved sentence, three-step progress indicator, Review changes, Save draft and Evaluate saved generation on one row. The action hierarchy and precise save state matter; the progress indicator duplicates the navigation and does not help edit the file. Drop the inline stepper first. Keep one concise state: “Generation 1 · Unsaved changes” or “Generation 1 · Saved”. Preserve the saved identity in the evaluation action when edits exist.
2. The evaluation screen repeats its stage in the title, stepper and “2. Evaluate in your app” header. “Generation 1 saved · Saved snapshot” repeats the same fact. One header can identify “Generation 1” and the saved version, plus channel/parent revision in secondary metadata. Local section headings should identify tasks or objects: Evaluation requests, Evidence, Release.
3. Candidate, parent, revision and digest are useful provenance but do not all need persistent text rows. Show the short identity, channel and generation in the main summary, and full immutable IDs and digest in one details disclosure. Keep a stale-parent warning outside that disclosure.
4. Evaluation result rows repeat “Results available”, “last reported completed”, timestamps and “Updated” before any evidence action. Use one status with a timestamp and one request identifier. Keep “Inspect evidence” beside that result rather than separated by paragraphs.
5. Releases repeats the current revision in a header badge, row heading and Current badge. The row heading plus Current badge is sufficient; channel belongs in the shared bundle selection. Release details repeat evaluation support already described by the badge/body; keep provenance fields and the actual manual reason.
6. Setup repeats API URL outside and inside its environment disclosure. Show it once alongside the actionable environment configuration. “Choose your language” can be the accessible name of a compact ToggleGroup without a redundant prose label. Avoid turning installation instructions into several cards.

## Workflow risks and required acceptance criteria

### Editing and saving

- Unsaved browser edits remain explicitly visible while evaluating the previously saved generation. The UI must not imply that the visible editor content is the evaluated snapshot.
- Save is the dominant action while dirty; evaluation becomes dominant when a draft has been saved with no local edits. “Review changes” is a view toggle, visually weaker than mutation actions.
- Continuing to evaluation preserves navigation guards for unsaved edits, and names the saved generation when relevant.
- Reload/discard stays separate from saving and clearly identifies the saved draft baseline.
- Unconfirmed submissions and operation recovery remain visible and continue blocking conflicting writes. Do not hide them in generic details merely to save vertical space.

### Evaluating a saved generation

- The first request form is immediately discoverable; later request creation can be collapsed.
- The primary request action says “Create evaluation request”. Nothing says “Run evaluation” as if the console executes the workload.
- The handoff says “Run in your app” beside the copyable recipe/command. A short persistent boundary sentence is sufficient; do not repeat it in every section.
- A result is labelled as externally reported. Queued/running/completed/interrupted labels reflect real stored states. Neither a request nor a copied command is a successful evaluation.
- Result/evidence review remains bound to the exact candidate and current parent. A stale parent or mismatched comparison shows an actionable warning and disables evidenced publication.
- Existing comparisons, incomplete results and all known active requests remain reachable; compacting presentation must not limit history or silently omit active work.

### Releasing

- Evidence inspection and publication are separate deliberate actions. A completed result is not automatic release approval.
- The final release dialog names target channel, saved generation/version, parent revision, and chosen evidence or manual reason.
- “Publish without evaluation” is available as a secondary manual path with a required reason. Its semantics must not be relabelled as “Approve” or “Skip” without explanation.
- Publishing identifies the future channel resolution effect. Existing pinned jobs remain pinned.
- History distinguishes manual release from evidence-backed release. Restoring creates a new manual release with its own reason; it does not claim the old evaluation applies to a new decision.

### App setup

- Install, access and delivery check remain an understandable sequence, with language selection switching real commands.
- Users can discover package source/build instructions, the scoped credential destination, required private environment and directories, and the delivery recipe without a long accordion hunt.
- Copying/running the delivery recipe is not marked as “connected” or “success” without actual reported evidence.
- The delivery check makes no model calls; runtime agents remain owned by the app.

## Design directions to debate

Prefer a thin shared bundle header, compact local state/action bar and one main work surface. Retain left file navigation for editing because it is a functional navigator, not a second sidebar decoration. A dense single-column evidence page is credible if state, request and release sections have clear boundaries. Use the released shadcn Button, Badge, Table, Tabs, ToggleGroup, Dialog and Disclosure patterns; avoid bespoke status strips and decorative cards.

I would reject an alternative that collapses the entire evaluation flow into a “Publish” button menu, a wizard that forces evaluation for a manual release, or a dashboard that fabricates scores/run health. I would also reject a split-pane design that permanently occupies half the page with mostly empty provenance. Compactness should remove duplicate labels and excess padding before it hides decision-making information.

## Review disposition

Initial findings ready. Candidate images and implemented renders still require review. No final acceptance is implied by this baseline review.

## Six-image review and peer debate

All six generated PNGs inspected directly, followed by prompts.json. Ranking for workflow: **A > B > C > D > F > E**. This is a draft-workflow ranking, not an implementation acceptance.

- **A — strongest base.** Clear app/sidebar, bundle strip and draft/file scope. Save remains dominant. Retain the readable file navigator, remove separate parent-return chrome, and use one compact scope row. The generated strip is crowded and uses more width for tabs than real long bundle names will permit; real code needs deliberate wrapping.
- **B — credible wider canvas.** Full-width application bar frees file/source width, but two horizontal navigation scopes plus draft actions add height. It should not be chosen solely because the screenshot scales the type larger; neither the actual source starting position nor command size matches the intended 14px/32–36px specification.
- **C — usable but scope-heavy.** Grouped left navigation can work, and it shows all files, but bundle navigation dominates the top of a contextual pane. Selecting a file is then farther from draft actions than in A. Avoid moving scope/selection controls solely to reduce header height.
- **D — good mobile/focus adaptation.** Named selected file and Files (4) control remain visible. A closed picker sacrifices cross-file scanning; do not make it the desktop default merely to reclaim an already wide editor. It is appropriate below a responsive width breakpoint.
- **F — honest bundle-wide actions, weaker repeated editing.** Collapsed file rows below a large source editor make file selection position depend on the selected document length. Generated “Markdown” badges incorrectly replace actual instruction/skill/memory kinds. Repeated container borders do not improve workflow.
- **E — reject literal adoption.** The saved-vs-browser before/after inspector is an invented change to the current Review changes behavior. Current code compares the published parent (`base`) to browser `payload`, not last saved `saved` to browser payload. Its inspector narrows source and its line wrapping makes detailed review harder. Optional review is useful; this particular right inspector neither preserves existing semantics nor earns its width.

### Peer challenges and resolution

Sent the editor a material challenge on E's saved/browser baseline. The editor independently found the same mismatch. We agree to keep the published-parent diff and name that baseline; no new dual-diff workflow and no permanent inspector. Bundle Save remains above the selected-file toolbar, because it saves all edited files. Selecting files keeps the complete browser payload and closes the mobile picker without treating selection as a discard/navigation event.

Sent the skeptic a challenge that all six images depict draft editing and therefore cannot validate an evidence-first evaluation page or release dialog. A compact shell alone is insufficient. In reply to the skeptic's suggestion to shorten the dirty action, the always-visible minimum is “Generation N · Unsaved edits” plus an explicitly saved evaluation target. “Evaluate saved draft” is acceptable only with generation immediately adjacent; “Evaluate saved generation N” is safer when actions wrap. Repeated full IDs, progress labels and saved/snapshot synonyms should be removed before this important distinction. On mobile, prefer a two-line, at least 44px action over ambiguous “Evaluate”. Preserve the route dirty guard on navigation to saved evaluation.

## Exact hybrid and evidence-first implementation direction

**A shell + persistent desktop file navigator + D-style mobile file picker + existing full-width diff toggle.** Keep shadcn primitives. Draft state/actions are one local toolbar. No stepper, no permanent inspector, no new workflow modes. Main source must remain raw editable Markdown, not a rendered article.

For ImprovementWorkspace, use one full-width review surface with this order:

1. **Saved change header:** “Generation N” and a short immutable candidate ID; target channel and current/base revision appear once. Keep “Back to draft” as a secondary action. Put full IDs/digest/raw object in one details disclosure. Stale parent and compatibility issues stay visible outside details.
2. **Evidence section first when available:** show the selected real comparison and existing ComparisonEvidence. The header says which request/candidate it belongs to. Keep mismatch/incomplete warnings and release disabling exactly as today. Do not create score cards or summarize success from an incomplete comparison.
3. **Evaluation requests:** compact rows with Request ID, one externally reported state, one updated timestamp and Inspect evidence action when a comparison exists. First request creation remains open when there are no candidate requests. With existing results, “Create another request” is a secondary disclosure. Put frozen config, request IDs, copy handoff/command, and interrupt details inside the respective request. One persistent sentence says “Create a request, run it in your app, then inspect the reported evidence.” Do not duplicate that sentence per row.
4. **Release decision:** enabled “Review release with this evidence” follows the selected valid comparison. A separate collapsed “Publish without evaluation” path retains required manual reason. Final dialog retains channel, candidate, generation, parent revision, evidence/manual support and explicit final publish action. Preserve stale-generation/base/revision checks and operation recovery. Evidence-first presentation changes order and hierarchy, not the trust or execution model.

When a selected comparison comes from Inspect evidence, render evidence before setup and request history so users see what they asked to inspect. When none is selected, the same slot gives a brief instruction and the request rows provide the next action; no empty “metrics” surface. The manual path remains reachable without requiring an evaluation.

### Outstanding material checks

Need actual rendered evaluation, manual release, evidence-backed release, mobile dirty draft and long bundle-name states. Screenshots alone cannot prove operation recovery or stale-target guards; inspect retained code paths and run relevant existing behavioral checks. No final approval before those checks.

### Mobile action debate resolution

Visual and accessibility proposed a named, at least 44px “More draft actions” menu to avoid three stacked action rows. Workflow conditionally accepts it while dirty: keep Save visible, show saved generation plus Unsaved edits, put Review changes and full “Evaluate saved generation N” in the menu, and retain the dirty route guard. When clean/saved, the visible primary must become Continue to evaluation; the next workflow step should not stay hidden behind More. Accessibility additionally requires an announced save result and stable focus when that primary changes. This provides compactness without concealing the task progression.

Skeptic confirmed the evidence page should be one compact column, no permanent evidence rail, one selected version identity and explicit result rows. Release review must include bundle, channel, candidate and the intended publish action, and cannot bury missing/stale evidence or make manual publishing the default. These are material acceptance conditions shared by both reviewers.

## Real implementation review — capture 3

Inspected the actual desktop-evaluation, mobile390-evaluation, desktop-releases, mobile390-releases, desktop-sdk, mobile390-sdk and desktop-draft PNGs in artifacts/layout2-capture-3/screenshots, plus current ImprovementWorkspace and draft review code. This supersedes any implication that the generated images validate these pages.

**No material workflow objection in the shown states.** Desktop and mobile evaluation clearly identify “Generation 1 saved”, keep the app-run boundary in one sentence, show the externally reported result with Inspect evidence before another-request setup, and keep the manual release route secondary. The reduction in duplicate title/status/stepper text makes the next action easier to find. The absence of a permanent candidate hash is acceptable here because this is a specific saved-change route, the generation is visible, and the immutable identity remains in Saved snapshot details and the final decision dialog.

The parent's refinement is correct: render the selected real comparison first only when one exists; do not create an empty Evidence box in advance of result inspection. Comparison lookup is a secondary manual lookup below results. Current code retains the exact candidate/parent completeness checks, stale-parent warning, pending-operation and related-operation blocking, and the distinct deliberate review-release action. ComparisonEvidence still presents incomplete/missing outcomes and unknown cost honestly.

The release dialog code retains bundle, target channel/revision, published parent, candidate/generation and selected comparison or explicit unsupported/manual reason. Final buttons are explicit “Publish with selected evidence” or “Publish without evaluation”. The manual reason remains required before review. History renders current/manual support clearly; restoring still describes a new manual decision.

The SDK captures retain an understandable install → scoped access → delivery-check sequence, private environment discovery, real package-source instructions and “no model calls” boundary. There is no fabricated connected/success state. Desktop dirty draft keeps Save dominant, exact saved-generation evaluation secondary and all-file scope above the selected file. Current browser diff is explicitly labelled against published parent, preserving the pre-existing meaning.

### Outstanding acceptance evidence

The seven reviewed images do not show selected evidence, manual final-release dialog or evidence-backed final-release dialog. Their retained code looks correct, but actual renders remain necessary for the final visual decision. Final zoom reset, dirty-menu confirmation focus, clean/save-to-evaluation focus behavior and required existing behavioral tests remain pending. This review accepts the shown workflow hierarchy only; it is not final implementation approval and does not claim those missing checks passed.

## Final workflow verdict — capture 5

**Approved from the workflow review perspective. Happy with the implemented result; no material workflow objections remain.**

Inspected the seven exact capture-5 renders: desktop-selected-evidence, desktop-evidenced-release-dialog, desktop-manual-release-dialog, desktop-evaluation, mobile390-evaluation, native200-draft and native200-sdk. Also read screenshots/summary.json and exit.json. The explicit “Review saved change” heading now names the page's purpose while keeping generation identity nearby.

The selected evidence view shows the real bound request, candidate, parent/candidate outcomes and expected-pair inventory before request history. It does not turn completion into approval. The two real release dialogs preserve the same bundle, channel, revision, published parent, candidate and generation; the evidenced path names its selected comparison, while the manual path states that no evaluation supports it and displays the required reason. Their final actions explicitly match that distinction. No publication was performed during capture, and releaseUnchanged is true in the keyboard result.

Native 200% draft and SDK renders reflow visibly and remain readable; the corresponding recorded scrollY is zero. The final capture reports 35 states, no failures, no browser errors and exit code 0, with keyboard save/evaluation navigation, disclosures and collapsed-edits preservation passing. Parent reports the dirty-menu cancellation/payload/focus and first-save Continue-focus checks passed, plus 11 focused BDD scenarios. The broader 196-scenario run was still underway at this review; its outcome belongs to the parent's final validation and is not represented here as passed.

This final verdict supersedes earlier requests for missing evidence/dialog renders: those states are now observed. It does not authorize an actual release or claim evaluation efficacy beyond the displayed recorded evidence.
