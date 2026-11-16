# Developer integration review

Reviewed the latest captured desktop and 390px phone App setup, Connections, and selected evidence screens in `artifacts/layout2-capture-final-2/screenshots`, plus `sdk-setup.tsx`, `sdk-setup-recipes.ts`, `workspace-connections.tsx`, and the evaluation handoff/evidence rendering in `improvement-workspace.tsx`.

## Initial judgement

Keep the current three-step setup and language switch. It already gives a developer the right sequence, keeps code copyable without opening it, and states that the app owns runtime/tools/model credentials. The present editor is outside this review's proposed changes: its established desktop and phone heights should not move for novelty.

## Material findings

1. **An admin-supplied package has no direct install action.** Step 1 correctly says to obtain a tarball or wheel, but its actual install command appears only inside “Install from this checkout.” That label excludes the other supported starting point. Keep the checkout build instructions disclosed; surface the package installation command with a clear replace-the-path instruction and a copy action. Do not imply registry availability with `npm install @acclimate/sdk` or `pip install acclimate-sdk`.
2. **Required configuration is visually optional.** Step 2 says “settings below” while all five required environment variables and directory rules are collapsed. A newcomer can copy step 3 without knowing those prerequisites. A compact visible required-settings area or an explicit “5 required settings and private directories” disclosure is a useful change; the full security text can remain available in the existing details. Never prepopulate a real credential or suggest a token is a cache scope.
3. **The recipe's outcome is hidden behind its source code.** The visible model-free statement is good. Add a brief visible expectation beside the run instruction: the check prints its pinned version, digest, and observed start, then cleans up prepared files. This helps developers distinguish an install/configuration problem from an application/evaluation problem without a console “Run” or fake success state.
4. **“Active connection” can be mistaken for runtime evidence.** The directory's “Enabled” is precise. Selected connection details currently say “Active connection,” while the clarification that creation does not connect a running app is collapsed. Prefer “Enabled connection” consistently and retain explicit unknown delivery when reports are absent. Do not introduce a green connected/readiness indicator.

## Preserve as constraints

- Node.js 22.22+; Python 3.11+ on POSIX; actual tarball/wheel distribution. A design may improve access to the instructions but cannot invent a public package registry or CLI.
- All five required settings: `ACCLIMATE_URL`, private content-read `ACCLIMATE_TOKEN`, stable non-token `ACCLIMATE_SCOPE`, absolute private cache directory, and a separate empty private job directory. Existing directories are current-user-owned mode 0700 with no symlink ancestors.
- Current selection is frozen into the copyable recipe. Language choice must stay obvious and the copied recipe must match it.
- Content-read and receipt-write are distinct credentials. Reporting is off by default, requires both connection ID and receipt-write credential, and cannot block delivery/start. Optional reporting belongs after the core check.
- The console does not execute the SDK check or evaluation. A successful model-free check does not prove model consumption, adapter installation, evaluation readiness, or behavior quality.
- Dedicated evaluator credentials differ from Connections credentials. Public configuration matching is not proof the evaluator adapter is installed.
- Complete evidence is an inventory claim, not a win. Missing outcome/grade and unknown usage must remain explicit. Release review stays scoped to the selected candidate/request evidence.
- Keep one-time-secret and recovery behavior unchanged; this task has no reason to issue credentials.

## Optional improvements

- More specific copy labels, such as “Copy TypeScript recipe,” can reduce uncertainty without extra controls.
- A constrained text measure can make desktop setup paragraphs easier to scan, provided code blocks retain width and phone screens do not acquire side rails or nested cards.
- A compact summary row for selected evidence could help orientation, but the present score-pair table and warning already communicate the facts accurately. Do not trade them for a generic success meter.

## Direction for the six concepts

Prefer a quiet setup path with visible prerequisites and one prominent recipe copy action. A compact task checklist may work if its steps are instructions rather than tracked completion. Reject completion ticks, progress percentages, “ready” cards, live app status, invented terminal commands, and additional chrome that merely replaces straightforward sections. Connections should make credential management and delivery observations distinct. Evidence should preserve pair-level truth and separate release review from evaluation execution.

Concept critique, peer debate, and final implemented-screen review will be appended after those artifacts are available.

## Peer debate before concepts

- **Information architecture and workflow:** Both identified evaluation prerequisite ordering as more material than SDK polish. The current profile-specific explanation (including the payment simulator's `payment-policy.json` requirement) follows “Create evaluation request.” I agree: place that explanation before the action while preserving profile values/defaults and the installed-adapter boundary. Do not invent server-side compatibility readiness.
- **Workflow:** Proposed showing the five required environment names concisely, keeping full definitions and private-directory constraints expandable. I support this over forcing a large default-open configuration block on phone. Independent setup sections should remain accessible rather than becoming a gated wizard.
- **Skeptic:** Challenged whether SDK needs structural change and classified visible expected-output copy as optional. I agree on scope: the structure is already sound; a package-install label/action correction is useful, and expected output can be secondary if a more material evidence-review improvement competes for space.
- **My response:** A developer supplied a package by an admin should not have to infer that “Install from this checkout” contains the installation command for that package. Solve this locally by accurately naming the disclosure or exposing the short install command, keeping checkout build details secondary.

Updated priority: evaluation prerequisites before request creation; install-path discoverability; concise required-setting summary; truthful connection enabled wording; expected-output copy optional.

## Six rendered concepts

Reviewed `images/a.png` through `images/f.png` directly, not only their prompts.

| Concept | Developer assessment | Retain / reject |
| --- | --- | --- |
| A — Next decision first | Best review direction: a reported request and Inspect evidence are immediately visible. The large headline and green checked result row overstate what “App reported completed” establishes. | Retain a small state-aware sentence and direct evidence action. Remove completion tick/success styling and keep manual reason entry within its own disclosure. |
| B — Request and details | Master-detail adds navigation weight for one request while repeating saved-generation, parent, request state, and time. It uses a bare Completed badge in addition to app-reported wording. | Reject architecture. A normal request row preserves developer orientation with less chrome. No invented reason-choice dropdown. |
| C — Three task lanes | Readable labels, but side-by-side release/evaluation lanes make manual release as visually prominent as inspecting a reported result. “No release has been published for this generation” is an unsupported extra claim. | Reject architecture. Keep independent ordinary actions, without a progress or release-state story. |
| D — Recipe and prerequisites | A broad recipe is useful for experienced readers, but first-use install/configure is demoted to a right reference column. The actual artifact install action is missing. Rendered code invents constructor/resolve/prepare signatures. | Reject code-first structure and all generated code. Preserve actual executable source. |
| E — Compact step columns | Exposes all three steps above fold and makes artifact installation visible, but narrow columns constrain explanation and long variable names. It incorrectly defines `ACCLIMATE_SCOPE` as a private directory and invents `client.info()`. | Retain visible artifact command idea only. Do not transfer code, scope definition, or an all-purpose optional-details bucket. |
| F — One useful document | Strongest setup reading order: artifact installation, required settings, check/run expectations, then source/optional details. It still lacks a replace-the-package-path note and exact private-directory requirements. “Verifies the SDK and app setup end to end” overclaims this model-free demonstration. | Borrow prerequisite visibility and code disclosure, using the existing three sections. Keep precise source text and real recipe, not the rendered descriptions or a nested numbered mini-stepper. |

Preference: setup **F > E > D**, review **A > C > B**, judged as ideas to extract rather than pixel-copy targets. None is safe to implement literally.

## Debate after renders

Skeptic independently agreed on A's truthful next-action cue and F's visible prerequisites, and challenged whether that requires a new document architecture. I accept the narrower implementation: the current SDK's three sections can carry the useful information. No new wizard, status model, completion marks, reason dropdown, generated code, or combined optional-details mega-disclosure is warranted.

Workflow agreed that code-first D harms first-install ordering, and that E's scope definition and generated snippets cannot enter implementation. I emphasized that “expected output” must remain an instruction: it cannot be rendered as actual observed status or claim installed evaluator/model readiness. The run recipe should still copy from `sdk-setup-recipes.ts` unchanged.

Final recommended extraction: neutral A-style reported-request emphasis plus F-style prerequisite visibility, with the real file diff scope visible, evaluator prerequisite copy above request creation, current setup sequence, and existing evidence/release safeguards intact.

## Implemented SDK source review

Reviewed the updated `sdk-setup.tsx` after implementation. Approved with no material source objection: package commands use a replaceable absolute tarball/wheel path and are copyable independently of checkout build details; five concise definitions preserve the stable non-token scope and absolute/private/separate-empty directory meanings; full ownership/mode/symlink constraints remain available; expected output truthfully describes pinned version/digest/observed child start and cleanup. It makes no model/evaluator readiness claim. Recipes remain sourced from the real `sdk-setup-recipes.ts`, with no generated API substitutions.

Final responsive captures and implementation review remain pending.

## Final rendered implementation verdict

**Approved — no remaining material developer UX objections.** Reviewed actual v3 captures in `artifacts/layout3-capture-1/screenshots`: desktop SDK, expanded TypeScript checkout build, Python artifact install and required-settings summary, phone install/required-summary/delivery-output, native 200% delivery-output, first-request setup at desktop/phone, requested evaluator handoff, reported result, and selected evidence.

The implemented path makes package installation and all five required settings concrete before recipe copy/run. Phone content wraps within the existing panel without adding columns or a forced wizard; its additional scroll carries useful prerequisites. The no-model statement and expected child-start/version/digest/cleanup remain legible and distinct from observed application status. Payment simulator purpose and `payment-policy.json` prerequisite now precede request creation on desktop and phone. Reported results retain explicit app attribution and a clear Inspect evidence action. Selected evidence still displays pair inventory, request binding, parent/candidate outcomes, unknown/missing semantics, and the guarded release-review action.

Capture coverage limit: the files named `*-sdk-required-environment` show the new concise summary with the full environment/private-directory disclosure closed. I verified the exact strict directory rules in source, not in an expanded screenshot. This does not block the narrow layout change; avoid claiming that expanded panel was visually inspected based on these images.

The earlier connection “Enabled” wording suggestion and changed-file-count idea are optional follow-up refinements, not reasons to enlarge this implementation. The implemented scope addresses the useful SDK/evaluation friction while preserving the established editor and evidence model.
