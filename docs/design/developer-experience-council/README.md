# Developer experience design council

**Finalized:** eight design agents produced proposals; seven independent reviewers challenged the integrated plan, raised sixteen blocking findings, then all approved the same revised document after resolution.

- [Implementation-ready plan](PLAN.md): chosen interfaces, exact recovery/command/policy/evidence contracts, onboarding and native workflows, rollout, six work packages and twenty-two release gates.
- [Consensus and exact-revision sign-offs](CONSENSUS.md): final hash, reviewer dispositions, scope and verification limits.
- [Objection resolutions](RESOLUTIONS.md): every blocking finding mapped to a remedy and acceptance gate.
- [Council brief](brief.md): process and constraints.
- [Original developer experience critique](../../research/developer-experience-review/README.md): the seven-persona evidence that motivated the work.
- [Implementation and qualification evidence](IMPLEMENTATION-RESULTS.md): delivered behavior, independent audit resolutions, release identity and G01–G22 test coverage.
- [2026-11-17 implementation review](../../reviews/dx-implementation-20261117/README.md): eight fresh reviews, subsequent repairs and refreshed qualification.

## Design alternatives and workstreams

1. [Minimal evaluator module](proposals/evaluator-minimal.md)
2. [Flexible owned-session alternative](proposals/evaluator-flexible.md)
3. [Common-caller app entry point](proposals/evaluator-common-caller.md)
4. [Onboarding](proposals/onboarding.md)
5. [Python](proposals/python.md)
6. [CI and evidence](proposals/ci-evidence.md)
7. [Platform operations](proposals/platform.md)
8. [Native repository integration](proposals/native-repository.md)

The plan chooses the minimal evaluator module plus common-caller entry point. The other proposals informed its surrounding contracts; they are not independently normative. The final council review records are linked from the consensus ledger. The separate implementation report records subsequent code changes and runtime qualification without changing the frozen design.
