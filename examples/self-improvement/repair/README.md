# Learn a reusable skill helper

The longer tests exposed errors in ad hoc evidence loaders and arithmetic. This example asks the real service proposer to turn approved policy and execution findings into a reusable Python skill resource.

The operator adds an empty, explicitly allowed path on a private draft branch. Luna fills it through the existing bounded edit protocol and updates `SKILL.md` to use it. The original comparison baseline keeps its original files. The service stores text and versions; the native SDK agent executes the skill resource.

```sh
npm run qualify:self-improvement:repair -- \
  --source-run artifacts/self-improvement/my-twenty-round-run \
  --output artifacts/self-improvement/my-repair
```

The source needs `parent.json` and `release-candidate.json`. A twenty-round run can supply these even when its final audit rejects the candidate. Use the [large audit](../large/README.md) to freeze fresh audit and future-job inputs before starting repairs.

## What gets learned

- Approved provider facts remain in `memory/gateway.md`.
- `skills/payment-triage/scripts/triage.py` loads flat inputs or file manifests, projects the five scope fields, selects trusted receipts and calculates decisions.
- `SKILL.md` tells the agent to invoke the helper and return its computed objects.
- Instructions retain the trust boundaries and prohibit executing payments.

The proposer receives the complete input/output contract, including exact field names, plus approved policy and bounded failure feedback. It cannot edit the grader or app code. The helper is model-authored skill content, uses Python 3.9+ standard libraries, and has no payment or network integration.

## Development checks

Up to five proposals and 24 paid Luna SDK turns are allowed, with a 60-minute process deadline. Each proposed helper passes a static preflight before native execution. That preflight is a narrow qualification screen, not a security boundary.

Each draft runs on 24 flat incidents and a 32-view distributed-evidence job. All 56 raw final answers and all 56 helper-produced objects must be correct. The test also requires successful helper invocation and unchanged pinned files. It parses complete trailing JSON when a legitimate command prints inspected inputs before the helper output.

A passing draft is copied unchanged into a release candidate under the original parent, retaining the source draft and proposal records. **No channel is promoted here.** An independent [large audit and delivery check](../large/README.md) must qualify those exact bytes.

See the [stress-test results](../../../docs/research/self-improvement-stress-test.md) for failed attempts, the final helper and measured limits.
