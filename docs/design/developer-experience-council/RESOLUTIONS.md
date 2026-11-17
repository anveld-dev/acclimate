# Council objection resolutions

Round one reviewed D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`. All seven reviewers withheld approval. Sixteen formal blocking findings were raised; overlapping findings remain individually tracked rather than silently merged. All original reviewers subsequently accepted their findings as resolved on D2, SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`. The [consensus ledger](CONSENSUS.md) links every exact-revision acceptance. No blocking finding remains open.

| Finding | Minimum remedy incorporated in PLAN.md | Gate | Original reviewer |
| --- | --- | --- | --- |
| PR-1 | Treat retained responses as historical; authoritative lifecycle/binding reads after replay and before callbacks; acknowledge interruption race | G06/G08 | [Protocol](reviews/protocol-r1.md) |
| PR-2 | Guided target grammar shared with retained routing; unsupported project/principal cannot claim retained-ready | G03/G04/G06 | [Protocol](reviews/protocol-r1.md) |
| PR-3 | Separate bounded 4 MiB JSON/operation response budget from 2 MiB requests; streamed limits and wrapper tests | G06 | [Protocol](reviews/protocol-r1.md) |
| TS-1 | Concrete evaluationMain review options, data-only role selection and mapper types, documented command flags | G13/G22 | [TypeScript](reviews/typescript-r1.md) |
| TS-2 | Module-owned verified bundle snapshot; independent payload+metadata copy per execute invocation | G09 | [TypeScript](reviews/typescript-r1.md) |
| TS-3 | Exact parent-execute/parent-grade/candidate-execute/candidate-grade timeline; uncertainty escapes execute AND grade classification | G08/G09 | [TypeScript](reviews/typescript-r1.md) |
| PY-1 | Same verified-bundle isolation contract in both languages | G09 | [Python](reviews/python-r1.md) |
| PY-2 | Explicit threading Event/cancellation context, quiescent cancellation sentinel, awaitable/future uncertainty and shielded repeated-cancel drain | G08/G17 | [Python](reviews/python-r1.md) |
| EC-1 | Exact sum-then-divide round64 recurrence for case/aggregate means, differences and cost; overflow/rounding vectors | G11 | [Evals/CI](reviews/evals-ci-r1.md) |
| EC-2 | Ordered eligibility/authoring/identity/incomplete/policy verdict and exit table | G10/G11 | [Evals/CI](reviews/evals-ci-r1.md) |
| EV-1 | Role-level selected/required/availability/file contract and no manifest for unsatisfied required selections | G13 | [Evidence](reviews/evidence-r1.md) |
| EV-2 | Closed selection+static mapper registration, scalar-only no-journal path, reader-config online verifier with independently selected handoff | G13/G22 | [Evidence](reviews/evidence-r1.md) |
| EV-3 | Validate local sealed report, confirmed comparison ID, index binding and original file bytes before role-only mapper input | G13 | [Evidence](reviews/evidence-r1.md) |
| UX-1 | Complete headless request command using durable draft/candidate and retained request creation; immutable private intent/replay/channel-drift rules | G01/G20 | [Journey](reviews/journey-r1.md) |
| NO-1 | Narrow callback execution context; private durable native job locator and launch/stop/retention facts; persistent workspace parent and marker-checked recovery | G08/G21 | [Native/ops](reviews/native-ops-r1.md) |
| NO-2 | Closed case-insensitive source-control policy; reserve all dot-prefixed roots; prune memory files AND expose only filtered EffectiveContext | G14/G21 | [Native/ops](reviews/native-ops-r1.md) |

Nonblocking refinements also incorporated: separate interruption intent lock, explicit safe codes, unambiguous HTTP correlation versus evaluation identity, bool/integer/count validation, read-only verifier credentials, single-receipt timestamp/version projection, precise module ownership, pure/browser split, no claim of unbiased fixed-order execution, and one authoritative physical restore volume.

Acceptance of this design is distinct from executing these gates. Runtime correctness, live provider behavior and observed usability remain implementation/qualification work.
