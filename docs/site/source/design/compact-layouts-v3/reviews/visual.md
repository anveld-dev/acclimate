# Visual/interface review

## Evidence inspected

Read the six final v2 captures in `artifacts/layout2-capture-final-2/screenshots`: desktop evaluation, SDK, library and connections; 390px evaluation and SDK. Inspected `improvement-workspace.tsx`, `sdk-setup.tsx`, the shared `ui/disclosure.tsx`, and the corresponding rules in `styles.css`.

This review does not assume that empty screen space is a defect. The library and connections list have a clear page heading, one primary creation action and a compact truthful row. They are already successful quiet surfaces. The current editor is already 156px on desktop and approximately 333px on a phone; shrinking it or adding new framing is outside this proposal.

## Material findings

1. **The evaluation page gives the same visual authority to the saved-change identity, results, another-request form, lookup and manual publishing.** In the desktop capture, six adjacent ruled regions read as an index of settings. In the phone capture, similarly weighted labels and section spacing require scanning the whole document to discover the next decision. The issue is the hierarchy and grouping, not the size of the text.
2. **Utilities consume full section boundaries.** `Saved snapshot details`, `Comparison lookup and details` and `What publishing changes` each receive generous vertical territory even while closed. They are valid capabilities, but their framing competes with evidence inspection. Moving utility disclosures into a shared footer or compact related group can reduce the wall of equal rows without hiding the current result or reducing touch targets.
3. **The request summary is a single inline sentence carrying identity, provenance/status and exact time.** At 390px it wraps unpredictably, then its evidence action occupies a second row. A deliberately composed summary with status on the first line and request/time metadata on a quieter second line would make the existing truthful information easier to read. Preserve the explicit `App reported` wording; do not visually turn it into an Acclimate verification badge.
4. **SDK setup spends too much sequential space explaining prerequisites before the user reaches the runnable check.** On the phone, the third step begins near 700px. Keep the three real steps, but tighten the prose structure and place detailed prerequisites next to their relevant disclosure. Do not reduce body copy below 14px or remove the private-environment guidance. The delivery recipe can remain collapsed; its copy action must remain visible.

## Optional refinements

- Differentiate the primary section heading from disclosure labels through weight, spacing and position; increasing every heading would recreate bulk.
- A single outer border remains acceptable. Removing it is a visual preference unless the internal rules are also reorganized. Merely dropping border radius does not solve the hierarchy.
- Keep the existing sidebar and bundle tab conventions. Changing them would add evaluation scope without addressing the page's content structure.
- Keep list views sparse. Do not invent counts, health scores, decorative badges, status histories or onboarding panels to fill the desktop.

## Concrete alternative architectures

### A. Review document with one task band — preferred baseline

Top: saved-change identity, muted generation metadata and Back to draft. Next: current evaluation outcome summary and its visible Inspect evidence action. Below: create another request as a disclosure adjacent to that outcome, rather than a new peer section. Bottom: one visually quieter utilities group containing snapshot metadata and comparison lookup; manual publishing keeps a separate, clearly named release section and its current reason/review flow.

File diff remains directly discoverable near the saved-change identity. It can stay collapsed; a large diff must not push the evidence action out of view by default. The two supported evaluation states determine the content: without a request, creating a request is the next visible task; with a reported comparison, inspecting evidence is the next visible task.

SDK uses the same document rhythm: short app-ownership introduction plus language choice, three numbered sections, then one utility group for IDs, reports and cache details. The text within each step should first state the required action, then expose source-checkout commands or environment details through the existing disclosures.

Tradeoff: least dramatic conceptual change, strongest fit with existing components and state handling. It improves scan order without introducing navigation or hidden completion state.

### B. Review document with desktop action column

Keep identity, diff and evidence in a main reading column. Place request creation and release controls in a narrow secondary column on desktop; collapse to a single ordered document on mobile. Avoid cards around each utility. Use one quiet utility group beneath both columns.

Tradeoff: desktop density can improve, but the actual evaluation action may move relative to the evidence it depends on. A 390px layout receives almost no benefit. This alternative needs strong proof from a real render before it outranks A; it is not an automatic upgrade.

### C. Task navigator with detail pane

Present explicit local tasks such as Review changes, Evaluate and Publish, selecting a detail region below. SDK could similarly select Install, Configure and Check. The task list must describe navigation only, never imply completed steps or successful evaluation when no such state exists.

Tradeoff: the cleanest initial silhouette, but each stage requires an extra interaction and the relationship between evidence and publishing becomes less visible. This also duplicates bundle-level tabs with local navigation. Reject unless the actual functional rendering proves materially clearer than A. It is a useful image-generation direction to test, not the default implementation recommendation.

## Guardrails for six generated concepts

Compare architecture, not six versions of the same card styling. Plausible directions include document rhythm, an inline decision band, a two-column reading/action composition, a compact ledger of real requests, a local task navigator, and a reference-document setup layout. Every concept must retain existing truthful content and available actions; generated metrics or fabricated completion badges are disqualifying.

Evaluate the concepts at both desktop and 390px. Desktop empty space is permitted. Mobile needs intentional wrapping, one reading order, and 44px targets. Tiny text, icon-only replacement labels, concealed evidence actions, or a new pile of nested accordions do not qualify as compactness.

## Acceptance criteria for the implemented render

- The saved-change identity is distinguishable from the current evaluation action and from utility labels without lowering legibility.
- With a comparison available, the visible summary says that the app reported the result and presents Inspect evidence in the first review region.
- With no request, the request-creation task remains easy to find and usable; state-specific density does not accidentally hide it.
- Long IDs, exact timestamps, error text and permission limitations wrap without horizontal overflow or ambiguous truncation.
- A phone can distinguish status, request metadata and action without parsing one run-on label.
- File review, snapshot details, comparison lookup and the manual publish reason/review flow remain reachable.
- SDK language selection, install commands, credentials navigation, private-directory requirements, recipe copying and optional-report deep links retain their behavior.
- Real rendered screenshots, including expanded states, decide the final approval. Concept polish alone does not establish success.

## Actual six-image verdict

Viewed all six generated PNGs, `images/a.png` through `images/f.png`. These are concept studies rather than implementation evidence.

Review ranking: **A > C > B**.

- **A:** strongest immediate reading order: saved-change identity, a sentence explaining the current decision, and a visible evidence action before utilities. Adopt that hierarchy. Reject the green tint and checkmark: app-reported completion does not establish a successful result. Also reject the lower grid's duplicated labels (`New request` next to `Create another evaluation request`, for example). Existing named disclosures are more economical. The image's visible manual-reason input does not replace the actual required reason/review flow.
- **C:** clearer main categories than B, but three equally weighted cards promote manual release to the same visual standing as inspection and inflate a compact workflow into a dashboard. On a phone they become three tall sequential cards. Its legible headings are not sufficient reason to import the composition.
- **B:** repeats generation and parent identity in a top band and again in the selected request pane; repeats request identity, completion and timestamp in the list and detail. The one-request fixture earns no value from list/detail chrome. The primary evidence action appears substantially lower than A. Reject the composition.

Setup ranking: **F > E > D**.

- **F:** best actionable document sequence: supplied-package install command, configuration requirements, run command, expected output and visible recipe copy. Adopt those information principles. Keep the supplied path explicitly replaceable and use the actual existing recipe. Do not import its broad claim that the check verifies the integration end to end, its generated APIs/imports, or miniature numbered sub-wizard. Its permanently open five-row detailed table is not suitable by default on a phone or at 200% zoom.
- **E:** maintains real install/configure/run ordering and exposes the install action, but three tall cards add framing and turn the configuration table into narrow wrapped prose. It incorrectly calls `ACCLIMATE_SCOPE` a directory and invents recipe API calls. Reject those details and the three-card architecture.
- **D:** gives a large generated recipe the first reading position, so the required install/private setup can be missed or arrive too late when stacked. The copy action is visible, but copying before prerequisites are understood is the wrong task order. Reject the recipe-first architecture and generated code.

For mobile F, use three real numbered sections: visible supplied-package command plus a replacement-path note; concise required-settings summary naming the five variables, with the full exact definitions independently expandable; then runnable command, visible Copy recipe and truthful output line. Preserve the app-credential and private-directory instructions. Do not force a permanently expanded long table in order to resemble the concept.

## Direct peer debate

- Accessibility: agreed on A's neutral current-result emphasis and F's action-first sequence. Challenged a literal always-open table because five full definitions would delay the next task at 390px and native 200%. Independent details preserve both discovery and zoom usability.
- Information architecture: agreed on the five-name concise summary and independent full definitions. Challenged A's duplicate-label utility grid and C's promotion of manual release to an equal lane.
- Workflow: agreed that next-action text must be state-aware without inventing a global stage; evidence and reason binding remain the actual behavior. Generated completion styling or a forced wizard cannot establish workflow state.
- Skeptic: agreed to remove success cues and generated API text. Added the duplicate-label-grid objection; the skeptic explicitly accepted it. Actual app-reported provenance and existing named disclosures suffice.
- Developer: challenged phone density and source accuracy of the setup sequence. The developer confirmed that the implementation retains the three existing sections, exact scope/directory meanings, replaceable npm/pip path and independently disclosed strict directory rules. We agree any extra phone length must earn its place through usable prerequisites, rather than matching the concept silhouette.
- Parent implementation discussion: sent the actual rankings and limited extraction recommendation. The six images justify narrow content/task improvements, not shell/editor changes or a visual rebuild.

## Final implemented-render review

Inspected actual screenshots in `artifacts/layout3-capture-1/screenshots/`: desktop evaluation and SDK; 390px evaluation and SDK; desktop selected evidence; desktop source-checkout installation; mobile required-environment and delivery-output views; native-200 evaluation, SDK and delivery output; desktop and mobile first-request, requested-handoff and running-handoff states.

**Final visual verdict: approved, with no material visual objection to this bounded implementation.** After capture 1, independently inspected capture 2's desktop, 390px and native-200 evaluation views; desktop selected evidence; 390px first-request/running views; and desktop, 390px and native-200 private-directory expanded views. Capture 2 resolves the remaining order concern: candidates with requests show results/handoff before the two closed file/snapshot disclosures, while the first-request view retains file review first.

- The neutral primary Inspect evidence button now creates an unambiguous action hierarchy. In capture 2 it begins around 405px on the 390px phone, approximately 112px earlier than capture 1, below a readable two-line request summary. It is fully visible in the initial native-200 viewport as well. No green check, completion badge or invented status was imported.
- State-aware text explains the next action without a mandatory wizard. The actual first-request view exposes configuration, the evaluator's data/scope prerequisites and Create in one compact region; at 390px Create is visible near the bottom of the initial viewport. Requested/running views expose copy actions and precise app-status language without promoting a new request as the main action.
- The SDK now exposes an actual install command and its copy action before the source-checkout disclosure. The replacement-path guidance is readable next to that action on desktop and beneath it on the phone. The five-variable summary gives configuration prerequisites a discoverable place while full definitions remain independent.
- The phone SDK is longer than v2: Run the delivery check now falls below the first 844px viewport. This is an explicit tradeoff, not a claim of fewer pixels. The newly usable install command and visible required settings earn that length. The scrolled delivery view retains a visible Copy recipe, command, factual expected output and independent recipe disclosure. Shrinking the font or touch targets to force it above the fold would be a regression.
- Native 200% keeps the same reading order and readable text; content continues vertically without the concept studies' side columns or narrow table. Capture 2 improves on the baseline and capture 1: the evidence action is now visible without scrolling. The delivery output view demonstrates that the run/copy controls remain available after scrolling, and the expanded environment detail views retain exact definitions and a usable URL copy action.
- The selected-evidence render keeps the actual inventory, binding and release action together ahead of metadata. The running view no longer says to run again beneath its current-status instruction. The existing disclosure-led shell is still visually conservative; the implementation appropriately extracts useful A/F principles rather than reproducing generated chrome.

Optional future refinement remains: deliberately separating request status from exact timestamp metadata would be slightly easier to scan than the current inline summary. The actual two-line phone rendering is readable and does not justify broadening this change. Library, connections, shell and editor need no accompanying redesign.
