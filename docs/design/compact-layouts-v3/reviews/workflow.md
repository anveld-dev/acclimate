# Workflow review — compact layouts v3

Independent product/workflow review. Scope: saved-change review, request setup and handoff, reported evidence, release review, and SDK setup. This file is the reviewer's only owned artifact; no app changes are made here.

## Baseline inspected

Read the actual `ImprovementWorkspace` and `SdkSetup` components and directly inspected these final v2 renders under `artifacts/layout2-capture-final-2/screenshots`: desktop-evaluation, desktop-selected-evidence, desktop-evidenced-release-dialog, desktop-manual-release-dialog, desktop-sdk, mobile390-evaluation, mobile390-sdk. The desktop editor already starts at 156px, and the parent reports 196 passing BDD scenarios. Neither fact justifies wholesale shell or editor churn.

The current review workflow is credible. Generation identity is visible, app execution is explicit, completed results lead to Inspect evidence, a selected real comparison appears before request history, and the manual route remains secondary. Both final release dialogs distinguish evidence support from a required manual reason. No fake health, readiness or quality metrics appear in the observed screens.

## Highest-value opportunities

1. **Make the next action match the actual review state.** The persistent sentence says “Create a request, run it in your app, then inspect the reported evidence” even when the displayed request has already completed. This is truthful but spends scarce attention on the whole procedure instead of the user's current task. A state-aware sentence can point to creating the first request, running a requested evaluation externally, inspecting reported evidence, or reviewing a selected comparison. It must not infer success, quality, readiness or approval. Multiple active requests mean it should describe the available action, not invent one global stage.
2. **Expose required SDK prerequisites before the copy action.** The install/build commands, private environment and directories, and recipe are three closed disclosures. The numbered sequence is understandable, but Copy recipe is more immediately actionable than the configuration it needs. Prefer a concise visible prerequisite summary or one open configuration surface; preserve source-package installation and the full private directory constraints. A copy button is convenience, never evidence that the app is configured or connected.
3. **Reduce request setup nesting for a new evaluator.** The newest unreported request opens by default, then required included-checkout setup is another disclosure with many paragraphs. The existing “Included checkout setup (required)” label is honest. An alternative can make setup and app-run handoff siblings within the open request, with required setup ahead of command copy. Keep the dedicated evaluator principal distinct from content-read/receipt-write delivery credentials. Do not generate a one-click Run affordance.

These are opportunities, not baseline failures that require adding new UI modes. The existing review page is already short; more collapsed rows alone would not improve task completion.

## Disclosure priorities

Keep visible: saved generation, page purpose, stale-parent/compatibility warnings, uncertain operation/recovery notice, externally reported request state, unreported request's external-run action, selected comparison's completeness/missing-data warnings and its binding, deliberate review-release action, and final manual-versus-evidence support.

Safe to disclose: full raw candidate/request/comparison JSON, digest, full identifiers outside the final decision, older request setup instructions, optional delivery reporting, cache/offline explanations. Keep first request creation immediately discoverable. A user should not need to open generic Details to learn why an action is unavailable.

The final modal's full IDs are long but precise. A labelled description list could improve scanning without changing content. Do not replace them with only ellipsized strings; the final confirmation must remain auditable. Always show bundle, target channel/revision, saved candidate/generation, parent, and selected comparison or actual manual reason. Evidence inspection and publication remain separate actions.

## Meaningful compact alternatives to test

- **Task-led single column:** retain the current full-width review layout, use one state-aware sentence, keep selected evidence first, and show compact request rows with handoff details only for unreported work. This is the lowest-risk direction and my initial preference.
- **Request-first handoff surface:** for an unreported request, display required setup and copyable frozen handoff together in a compact open panel; reported rows remain collapsed with Inspect evidence. This helps first-time execution without increasing routine review height.
- **Setup workbench:** keep SDK steps sequential; put private environment configuration visibly beside the recipe on a wide screen and above it on mobile. Optional reporting and cache stay below. A split surface earns its width only while actual configuration/code is visible; no permanent empty status rail.

Reject a fixed wizard that forces evaluation before manual publication, a “Ready to release” completion badge, a score dashboard inferred from complete inventory, a Publish menu that hides manual reason and evidence binding, or a three-column page that compresses the actual evidence table. No split-pane commitment until actual 390px and 200% renders demonstrate the sequence remains readable.

## Acceptance requirements

- A saved immutable candidate remains the evaluation/publish target even when browser draft edits exist elsewhere. Never retarget to the live editor payload.
- Request creation freezes public configuration and never claims to execute the app. Included checkout setup remains explicitly required where applicable; interruption records do not claim to stop external execution or charges.
- Every loaded active request and older history stays reachable. A completed request without a comparison does not become successful evidence.
- Selected evidence must match candidate and current published parent; completeness means expected inventory only. Missing grades, failures and unknown cost retain their honest representation.
- Stale parent, changed generation/revision, compatibility, pending/related operation and recovery guards remain effective in review and final submission. Do not collapse an uncertain operation notice.
- Manual release retains required non-whitespace reason and explicit unsupported status. Final buttons distinguish selected evidence from publishing without evaluation.
- SDK setup retains real TypeScript/Python commands, scoped content-read credential destination, private environment/directory requirements and model-free delivery-check boundary. No connected/success state arises from copying a recipe.
- Actual renders must cover no-request setup, unreported external-run handoff, completed result, selected evidence, both release dialogs, and SDK at desktop, 390px and native 200%. Existing focused behavioral checks must cover the retained guards; broad tests need repetition only when the implementation warrants it.

## Review disposition

Initial findings delivered. The existing shown workflow is acceptable; the new concepts and their implemented render still require independent review. This is not approval of an unobserved v3 implementation.

## Peer debate before concepts

Information architecture identified a stronger decision-order issue than my initial SDK-disclosure concern: the default payment-retry example requires `payment-policy.json`, and its limited model-free purpose is explained **after** Create evaluation request. I agree that the selected configuration's prerequisites and scope should appear before that mutation. Keep them truthful and configuration-specific; do not infer that an adapter is installed or that a bundle is compatible. Retaining the existing selected default keeps this a small ordering improvement; introducing a new blank selection is a separate workflow change with additional validation needs.

Accessibility and I agree that Results must expose the actionable row, not merely its heading, within a reasonable 200% viewport. Keep Review file changes a named, reachable control; generic More is unsuitable. Preserve independent SDK disclosures, language radio semantics, form values and install/reporting hash targets. Any desktop paired setup layout must become a single logical sequence at mobile/zoom widths.

The skeptic proposes a factual changed-entry count in the Review file changes trigger. I support that low-risk summary if it uses the existing published-parent comparison semantics. I challenged an always-review-first introduction: when a request has completed, Inspect evidence is the available next action, and selected evidence leads to review of that evidence. State-aware language should preserve those distinctions and never require opening a long diff before evidence inspection.

The developer proposes showing required environment names and expected delivery-check output near the setup actions. I support concise prerequisite names before recipe copy and an explicitly **expected** output description. Keep the full directory requirements available. Do not show fabricated actual output, readiness ticks or tracked completion. SDK layout is an optional improvement, not a blocker in the existing acceptable baseline.

## Six-image review

Directly inspected all six PNGs, then read their prompts. Review ranking: **A > B > C**. Setup ranking for workflow principles: **F > E > D**. None is safe for literal adoption.

- **A:** best task hierarchy. The reported request and Inspect evidence become immediately useful, and independent utilities remain reachable. Remove the olive checkmark/success treatment: an app-reported completed request is neither complete evidence nor a win. The stray required-reason field outside the closed manual disclosure is incorrect; manual reason belongs in the deliberate manual path. Its large intro need not become a second headline.
- **B:** request master/detail adds selected-request state and repeats generation, parent and status several times. For the demonstrated single request it consumes more space than the working list. It also invents a fixed reason selector. Reject the new structure unless actual multi-request use demonstrates value; preserve the current arbitrary required manual reason.
- **C:** three lanes make manual publishing visually equal to evidence review and imply a global staged process. The “Review required” heading is vague and the Release lane is mostly empty. Reject this structure; concurrency and manual publication do not fit a fixed pipeline.
- **D:** large visible recipe precedes the prerequisites in reading order, while install/private settings become a narrower rail. It also invents API usage. Retaining real source would be much longer. The layout does not earn the extra pane or improve the external execution handoff.
- **E:** required setup items scan well on desktop, but three narrow columns constrain the actual code and would need careful reflow. The image incorrectly calls `ACCLIMATE_SCOPE` a private directory and invents `client.info()`. Those content errors are material: scope is stable app identity, never a token, while cache/job paths have distinct private-directory requirements.
- **F:** strongest setup order: install artifact, private configuration, then model-free delivery check with expected output. Use the real implementation's exact environment meanings and commands. The visible full five-row table may make mobile/200% setup unnecessarily tall; a concise prerequisite summary before copy plus independent full configuration disclosure is a credible hybrid. Keep the long recipe named and expandable, and keep optional reporting/IDs/cache separate.

Recommended synthesis: A's next-action priority without success styling or exposed manual reason; F's prerequisite-before-action order without a large default-open table or fabricated code. Preserve existing single-column review, exact real recipes and current model boundaries. The two material improvements remain state-aware review guidance and evaluation prerequisites before request creation. No image demonstrates a need for editor or shell changes.

### State-aware guidance edges

Use actual comparison availability rather than `status === completed` to offer evidence inspection. A completed or interrupted request may have no comparison; the existing request body correctly points to app logs in that case. An older reported comparison and a newer active request may coexist. Say that evidence is available rather than declaring the whole bundle's evaluation complete. A selected mismatched or incomplete comparison remains inspectable; the guidance must not imply release eligibility that its binding/completeness guards deny.

Skeptic accepted the challenge to an always-review-first introduction and now treats changed-entry count as optional. Accessibility agreed to concise SDK prerequisites before Copy with independent full environment details; showing all five full definitions by default is not a requirement. These resolutions preserve useful compactness without hiding the actual decision conditions.

## Actual implementation review — capture 1

Inspected desktop completed-result review, selected evidence, both release dialogs, first-request setup, custom public configuration, requested and running handoff, SDK overview, mobile390 evaluation/first-request/requested handoff/SDK/delivery output, and native200 evaluation/delivery output. Read current source, including `reviewNextStep`, and capture summary. The capture reports 55 states, no failures/browser errors, no paid model calls, unchanged published release and passing keyboard checks. It created one request in its disposable fixture to exercise requested/running handoff; this is not a claim that the external evaluator ran.

The two material changes are visibly useful: selected configuration prerequisites now precede Create evaluation request, and review guidance describes the actual available action without interpreting app-reported status as approval. The helper handles an actual comparison, running/requested work, terminal no-comparison outcomes and older-page availability separately. SDK exposes the actual replaceable artifact install command, accurate five-variable prerequisite summary, and expected pinned-version/digest/observed-child-start/cleanup behavior before the long recipe. Language switching changes real commands. Existing independent details remain reachable.

Selected evidence still shows its real bound request, completeness inventory, outcome table and explicit limitations. Both release dialogs preserve bundle, channel/revision, exact candidate/generation, parent and selected comparison or manual unsupported status/reason. Existing guarded publication remains deliberate. No success styling or fake readiness from the concepts was adopted.

Two focused follow-ups are now agreed before final review. First, the running request body repeats “Run in your app” immediately after “Check your app for current execution status”; keep run instruction for requested work and status-check instruction for running work. Second, at native200 the two file/snapshot disclosures still precede Results and leave only the heading in the initial viewport. This is not a functional accessibility regression, but A offers a useful improvement: when requests exist, move those two named disclosures together after Results and before utilities. Keep them in the initial summary for first/no-request setup. Stale-parent and compatibility warnings must remain visible in the summary, while selected evidence remains ahead of history. I accepted this extraction; actual follow-up render is still needed before final v3 approval.

## Final workflow verdict — capture 2

**Approved from the workflow/product review perspective. Happy with the implemented result; no material workflow objections remain.**

Directly inspected the final desktop completed-result review, running handoff, selected evidence, both release dialogs, first-request setup and SDK, plus mobile390 completed review/private-environment disclosure and native200 completed review/delivery output. Read the changed source and capture-2 summary. The capture reports 58 states passed, no failures/browser errors and zero paid model calls. Its keyboard and evaluation checks report the published release unchanged, no writes from switching profiles/disclosures, and successful requested/running handoff coverage.

Both follow-ups are resolved. Existing requests now put their result and Inspect evidence before file/snapshot details; the actual native200 screenshot shows the full actionable result in the initial viewport. The two review controls remain directly named immediately afterward, before secondary setup/lookup/manual release. First-request setup still places those controls before creation, with accurate prerequisites above Create. Compatibility and stale-parent warnings remain outside the moved details in source. Selected real evidence remains first, with bound request, full inventory, honest outcome table and explicit completeness limits.

The running handoff now asks the user to check their app's current status and does not tell them to run the same work again. Requested work retains its copyable ID/configuration and app-run instruction. Required included-checkout setup and interruption semantics remain reachable. Final dialogs preserve the exact saved generation/candidate, channel revision, parent and selected comparison or unsupported manual reason; explicit final publish actions and existing generation/base/revision/recovery guards are retained.

SDK now presents concrete package installation and required configuration before recipe copy, while retaining the exact real recipe and full independent environment disclosure. The observed narrow and zoomed views reflow in a single sequence, and the expected output remains clearly expected, model-free, and limited to pinned delivery plus observed child start. No concept's fake API, success check, scope-directory error or forced workflow was adopted.

This verdict approves the reviewed UI implementation. It does not authorize publishing a bundle or claim live model quality. The full behavioral suite outcome is the parent's separate final validation; this reviewer does not claim an unfinished run passed.
