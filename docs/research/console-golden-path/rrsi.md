# RRSI: keep the improvement trail clear

Read-only review of `.repos/rrsi` at `be50316e1db05914068a973f322770ef08ed7ba1`. No upstream scripts, builds, tests or model calls were run.

RRSI is useful evidence for the **improvement workflow**, not a visual template. Its documented interface is a Python CLI that runs experiments. It does not prescribe our sidebar, tabs, file controls, setup layout or editor library. Its editable harness includes prompts, control flow, tools, skills and memory around a frozen model. Our product deliberately manages a smaller set of versioned content and evaluation evidence; the host app keeps its agent runtime. [Overview](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/README.md:15) · [CLI workflow](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/README.md:81)

## The useful golden path

```text
Evidence from tasks → small change + hypothesis → measured candidate
                    → decision + reason → keep current or accept change
```

The durable output is an edited harness commit plus an inspectable trail. The proposer describes the mechanism, targeted failure and regression risk; the loop records the diff, measurements and verdict. It does not train new model weights. [Proposal shape](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/propose.py:89) · [Recorded outcomes](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:304)

| Artifact | What it answers | Source |
| --- | --- | --- |
| `analysis_report.json`, `global_analysis.json` | What failed, what worked, and what might help? | [Analysis writes](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:249) |
| `proposal.json`, `diff.patch` | What changed and why? | [Draft and diff](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:490) |
| `critic.json`, `smoke.json`, `prep.json` | Was the candidate screened, runnable and committed? | [Candidate preparation](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:548) |
| Per-candidate `eval.json` and raw job trials | What did the candidate actually do? | [Evaluation cache and measurement](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:578) · [Result fields](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/evaluate.py:71) |
| `decisions.json`, `history.jsonl` | Was it accepted, rejected, or admissible but beaten? Why? | [Decision recording](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:304) · [History fields](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/history.py:77) |
| `frontier.json`, the evolution branch | Which version is current, and how did it get here? | [Current-version update](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:327) |

A rejected change still teaches the next proposal. The history keeps hypothesis, component, measured deltas and reason; its compact prompt view gives measured results priority over a wall of unmeasured failures. That supports a readable change list with evidence behind it, rather than exposing every JSON record at once. This is a UI inference, not an upstream screen design. [History model](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/history.py:36) · [Compact history view](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/history.py:165)

## What we should simplify

These are recommendations for this UI round, not claims that RRSI contains equivalent web pages.

| Surface | Lead with | Keep secondary |
| --- | --- | --- |
| Changes | The saved change, affected files, available rationale and next action | Random IDs, digests and raw request JSON |
| Releases | Current channel version, release reason, evidence and previous decisions | Internal operation records and full version metadata |
| App setup | Install → private configuration → fetch pinned files → hand them to the app’s SDK | Package-building instructions and detailed directory rules, available when needed |
| Evaluations | Parent/candidate identity, measured results, coverage, missing data and decision eligibility | Search hyperparameters, calibration internals and infrastructure logs |
| Content | Actual file tree and readable source, with a clear edit action | Counts and metadata; a second type-filter control needs a real use case |

For Changes, a successful suggestion is a candidate ready to inspect—not a proven improvement. For Releases, a completed evaluation is evidence—not a release decision. RRSI distinguishes `ACCEPTED`, `LOST`, `REJECTED` and pre-measurement failures. If no candidate is admissible, it deliberately keeps the incumbent. Our UI should make “keep the current release” an ordinary outcome. [Outcome distinctions](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:313) · [Selection](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/selection.py:124)

For setup, the relevant boundary is the adapter: the domain owns execution, scoring and trace rendering. RRSI’s core works through that contract. That supports our app-owned evaluator boundary; it does **not** mean users should install RRSI’s benchmark environments to fetch a content bundle. [Domain execution and evidence methods](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/domain.py:66) · [Adapter overview](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/README.md:141)

## What we should not copy

- **The whole runtime.** RRSI can edit control flow, tools and subagents. Our content SDK should not silently grow into a managed execution platform. [Component vocabulary](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/components.py:28)
- **Its memory semantics.** The workspace harness includes an inert, mutable JSONL memory primitive with filtered recall. It must be wired into the agent loop. That is different from delivering reviewed `memory/*.md` files. A skill file also needs a discovery/use path; placing it on disk alone does not prove the agent uses it. [Inert primitives and skills](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/third_party/archipelago/harness_workspace/mechanisms.py:28) · [Memory implementation](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/third_party/archipelago/harness_workspace/mechanisms.py:73)
- **Automatic promotion policy.** RRSI automatically moves an experimental Git branch. Our reviewed, concurrent channel promotion and restore operations remain production decisions. Its ancestry check and ref write are separate from history/frontier writes. [Branch movement](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/gitops.py:121) · [Separate round writes](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/loop.py:327)
- **Missing cost as no cost change.** Its relative-cost helper returns zero when either token estimate is absent or zero. Our UI should keep unknown usage visibly unknown. Its weighted score also depends on domain-provided trial records; our displayed paired means are not a reproduction of every RRSI benchmark metric. [Aggregation](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/evaluate.py:104) · [Relative cost](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/evaluate.py:131)
- **Research knobs as default UI.** Annealing, novelty and noise thresholds are research policy. They do not earn a panel on an SDK delivery page. If we later expose automated search, its operator configuration can be a separate advanced surface. [Selection rules](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-8c855076/.repos/rrsi/rrsi/selection.py:81)

Syntax highlighting is an independent product choice. RRSI defines domain trace rendering, not a React editor/highlighter contract. Pick a modern viewer/editor library for our actual formats and editing needs; do not call a library choice “the RRSI golden path.”
