# Replication of connected learning on LLM CLI support

Can the current service release a candidate that is non-inferior to the published baseline on unseen LLM CLI support requests? The secondary analysis uses the same one-sided 95% bound to test for a gain above zero. [Pre-registration and amendment](replication-preregistration.md)

## Setup

Acclimate service source `ea81aed7cf4dc267473c603cfd02f85671a3fc71` ran against a disposable PostgreSQL 18.6 database, with Rust 1.89.0. The grader used LLM 0.38 at upstream commit `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Python 3.13.1 and Click 8.5.1. Readiness used Codex CLI 0.169.1. The evaluator used @openai/codex-sdk 0.169.0 with its bundled Codex CLI. Every call explicitly requested `gpt-6-luna` at low reasoning effort.

The pre-registration records SHA-256 digests of the reused development and field task source, the corrected grader, the baseline bundle file, and the new 30-task audit cohort. Zero-call checks passed for all 70 original references and negative controls, 30 fresh references and 60 fresh negative controls, and both upstream encode/decode tests. Distinctness was checked against all original and new parsed targets.

Policy v3 used a development step margin of 3 percentage points, a fresh cumulative superiority check, and an audit non-inferiority margin of 3 points at one-sided 95% confidence. Both policies set the power target to a 10-point gain. The repetition plan allowed 60 pairs per comparison with uniform two repetitions per arm. One proposal admission and human review only on service request were pre-registered.

## Results

**The service stopped proposal admission on projected cumulative power.** No candidate reached the held-out audit. Non-inferiority and superiority are unevaluated, and the baseline remains the published version.

The baseline version was `f634676e-3cd7-4f1b-97a2-7bc7f6beae7c` with resolved bundle digest `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`, matching the original experiment. A/A request `11d5f7ce-f2bf-47b7-813b-3ae26c74871a` finished with 60 scored pairs across 30 cases and no missing observations.

| Stage | Comparison ID | Parent | Candidate | Paired gain | One-sided lower bound | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A/A | `9525434c-65b0-41fa-92bd-1c6dc51d8180` | 17/60 | 17/60 (same baseline) | 0.00 pp | — | Calibrated |
| Development step | — | — | — | — | — | No proposal admitted |
| Fresh cumulative | — | — | — | — | — | Power guard stopped admission |
| Independent audit | — | — | — | — | — | Unevaluated |

A/A case-mean flip rate was **10.00%** (3/30), with six cases showing disagreement in at least one repetition. The paired calibration SD was 0.25400, standard error was **4.64 pp**, and the calibration MDE was **10.04 pp**. The service planned 60 pairs and 120 trials per comparison, uniformly two repetitions per case across development, cumulative and audit.

| Projected gate | 80%-power MDE | Power at +10 pp | Cases needed at +10 pp |
| --- | ---: | ---: | ---: |
| Development step | 8.41 pp | 87.60% | 24 |
| Cumulative superiority | 11.41 pp | 72.10% | 39 |
| Audit non-inferiority | 10.46 pp | 77.86% | 33 |

The guard reported the cumulative gate first. Its 11.41 pp MDE exceeded the 10.00 pp target. The audit projection also exceeded the target. These are projections from baseline noise. No candidate diff, proposal, correction, or human review was produced.

## Turn accounting and deviations

| Segment | Started turns | Turns with usage | Input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| Readiness and interrupted A/A | 18 | 17 | 267,537 | 639 |
| Restarted A/A and partial field delivery | 125 | 124 | 1,684,997 | 3,242 |
| Total | **143** | **141** | **1,952,534** | **3,881** |

The experiment ran for approximately 13 minutes from readiness through cleanup. The pre-registered projection was 552 turns including contingency. The experimenter requested removal of global turn and wall-clock caps during the first A/A, before any comparison result was observed. The amendment records an interruption after 18 started turns and a restart from a fresh database with the same statistical design. One interrupted turn per run had no Codex usage report.

The runner treated `noiseCalibration.status: "completed"` as a completed power decision. The enrollment endpoint can show that state immediately after the evaluator submits a comparison, while `plan` is absent and before the worker publishes its decision. To reproduce, poll enrollment status during submission and observe `completed` with no plan, followed by the worker's projected power and `stopped` for a calibration that fails the guard. This run observed both states, the latter in a read-only snapshot of the disposable database. The runner started five field turns during this transition. The first four (in order, `cli-01-7`, `cli-02-6`, `cli-03-5`, `cli-04-4`) scored zero. The fifth was interrupted after the guard stop was confirmed. No corrections were submitted. The harness now waits for a plan or a terminal stop before starting field work. Service source was untouched.

## Comparison with the first experiment

| Measure | First experiment | Replication |
| --- | --- | --- |
| Repetitions per arm per case | 1 | 2 |
| A/A case-mean flip rate | 16.67% | 10.00% |
| A/A standard error | 8.03 pp | 4.64 pp |
| Calibration MDE | 17.05 pp | 10.04 pp |
| Development | +16.67 pp, +4.25 pp lower bound | Unevaluated |
| Held-out audit | 0.00 pp, −13.66 pp lower bound, rejected | Unevaluated |
| Candidate released | No | No |

The replication reached the power guard but furnished no candidate-level evidence for either audit hypothesis. The lower calibration SE accompanies both a change in repetitions and a change in calibration statistics, so the results do not isolate either contribution. The power projections transfer development baseline noise to a fresh cohort and apply to this CLI, model configuration and exact Click-parameter scoring rule. Codex reported usage and the requested model, and the backend model identity was independently unverified. [First experiment](README.md)
