# Review and setup, third pass

See the [fourth pass](../compact-layouts-v4/README.md) for newer content and draft workspace layouts.

Six fresh images test different layouts for saved-change reviews and SDK setup. The editor and shell keep the compact layout from [the second pass](../compact-layouts-v2/README.md).

[Compare the generated concepts](comparison.html) · [Before and after](results.html) · [Exact prompts](prompts.json)

| Direction | Useful part | Rejected part |
| --- | --- | --- |
| A · Next decision first | A next step based on the actual requests and evidence | A green check before evidence is inspected |
| B · Request and details | Clear separation of request and evidence | Extra selection state and repeated metadata |
| C · Three task lanes | Explicit task labels | Equal emphasis on evaluation and manual release |
| D · Recipe and prerequisites | Related setup reference | Large code block before installation |
| E · Step columns | Install, access, check order | Cramped columns and invented SDK APIs |
| F · One useful document | Visible install command and required settings | Broad verification claims and a tall mandatory reference table |

The images were generated with built-in imagegen. They are layout sketches; their code and status labels are not product specifications.

## What we kept

The review tells you what to do next: configure a first evaluation, run a requested one in your app, check a running app, or inspect reported evidence. A completed request without a comparison never becomes a success badge. Older evidence can coexist with a newer running request. Selecting evidence still requires a deliberate click, and release eligibility is checked separately.

Each evaluator's prerequisites and purpose now appear before Create evaluation request. Creating a request records frozen settings; your app still runs the evaluator. Existing results come before closed file/snapshot details; first-request reviews keep those details before setup. Compatibility and stale-parent warnings remain visible. The existing comparison and manual-release safeguards stay in place.

App setup exposes the actual package-file installation command, five required private settings, and the delivery check's expected output. Checkout build commands, full directory requirements and recipes stay independently expandable. The check reports a pinned version, digest and observed child-process start; it does not prove native agent quality.

The implementation uses the existing shadcn buttons, disclosures and language controls. It adds no package, backend subsystem, dashboard or wizard.

## Independent review

The six reviewers examined all six images and challenged each other's recommendations:

- [Information structure](reviews/information.md)
- [Workflow](reviews/workflow.md)
- [Accessibility](reviews/accessibility.md)
- [Visual design](reviews/visual.md)
- [SDK developer](reviews/developer.md)
- [Skeptical newcomer](reviews/skeptic.md)

All six approve the implemented design with no remaining material objections. They prefer A's decision order and F's document structure. Their main correction was to keep the concepts' visual ideas while discarding invented APIs, success signals and scope claims.

## Validation

Typecheck, the production build and all 140 console tests pass. The [final rendered suite](../../../artifacts/layout3-capture-3/screenshots/summary.json) passes 58 states across desktop, phones and native Chrome 200% zoom, with no browser errors or layout-metric failures. It checks first/requested/running evaluation states, zero writes from profile/disclosure changes, private setup details, both release dialogs, edit retention and keyboard focus after request creation.

The local app is running with real PostgreSQL and Keycloak. Test fixtures use disposable PostgreSQL and fixture identity/model providers; no paid agent-model calls run. The [final full behavior run](../../../artifacts/layout3-full-final/verified-summary.json) passes all 153 behaviors, 196 scenarios and 929 steps across 17 features, with none failed or skipped. [Verification notes](../../../artifacts/layout3-verification.md) retain the earlier interrupted run.
