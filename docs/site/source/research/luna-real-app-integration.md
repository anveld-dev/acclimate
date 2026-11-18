# Integrating Luna into Simon Willison’s LLM

Developers installed the 0.1.0 Acclimate packages in fresh checkouts of Simon Willison’s LLM 0.38. They integrated a Luna-backed model plugin into the application, ran the native coding-agent starter against the same upstream project, and exercised a CI worker and a separate read-only reviewer. The Rust service and PostgreSQL ran locally. Every inference call in this study explicitly selected `gpt-6-luna`. Each task had one observation per arm. The results describe integration behavior on those cases. [Pinned upstream source](https://github.com/simonw/llm/tree/46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f)

## A Python test-runner error became a quality score

The native task asked Luna to document LLM’s binary embedding format. The evaluator froze the upstream source, limited edits to `llm/__init__.py`, and checked both original pytest cases. A separate check verified that only the two docstrings changed and that they described the byte order, float width and direction of conversion. The parent and candidate produced byte-identical source, each passed both tests, and each earned 1/1. The paired run took 42.5 seconds. Both private Codex thread records confirmed provider `openai`, model `gpt-6-luna` and low reasoning effort. [Upstream test](https://github.com/simonw/llm/blob/46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f/tests/test_encode_decode.py) · [Native comparison](#comparison-records)

Two reviewers independently checked what the starter’s default grader would report for those exact retained solutions. It accepted the Python test path during setup, invoked `node --test` and discarded stderr. Node exited 1 with `ERR_UNKNOWN_FILE_EXTENSION`. The starter turned exit 1 into `testsPassed: false` and reward zero for both correct solutions. The native README does describe Node tests. A developer working on a Python app can still get all the way to a score with the wrong runner. The first fix should validate the runner against a frozen test file before a paid turn, keep its startup diagnostic, and let the app register pytest. [Starter’s grader](../../examples/native-repository/application.mjs) · [Starter documentation](../../examples/native-repository/README.md)

## The reviewer had enough permission and still needed the app

The Python integrator registered an LLM model plugin that calls the authenticated Codex CLI and verified the plugin class before dispatch. Both arms received the installed CLI’s help and answered `--usage --expand`. LLM’s actual Click parser accepted each complete answer and enabled both requested options. The comparison scored 1/1 on each side. A policy allowing zero regression passed and the service recorded the receipt.

A reviewer installed the wheel in an empty checkout. With a read-only credential and the public handoff, `status` worked, and `verify-export` verified the producer’s scalar export against the service. With the same reader, running `check` with the shared policy or requesting a scalar `export` both exited 1 and requested `application.py`. The reviewer used authenticated API data to recompute the policy and separately parsed the two deliberately shared answers. The default scalar export contained neither the policy nor the two answers. These commands should operate from the handoff, reader credential and supplied policy. A separate opt-in per-case share should make the relevant answer and grading explanation available to authorized reviewers. [Python CLI](../../python/acclimate/evaluation_app.py)

## The Python CLI and the CI wrapper disagree about the app path

A first-time Python developer using Luna wrote a small adapter from scratch against LLM’s real Click parser. Both `python -m acclimate describe --app application.py` and `coverage --app application.py` worked. The CI owner then passed the same form of path to the released PR wrapper and got exit 1 with “Evaluator returned no JSON object for doctor”. Pointing `--app` at the directory containing the adapter worked. The wrapper should accept the familiar file form or say which directory to supply before it runs the subprocess. [CI wrapper](../../examples/ci/ci.py)

The working PR check caught an instruction regression. The task explicitly requested two long flags. Luna returned `--usage --expand` for the parent, then `-u --expand` for the candidate. Click accepts the short alias, but the candidate violated the user’s format. CI recorded a failing receipt and exited 2 in 15.72 seconds. Repeating the same commit kept the comparison ID and exit code, took 3.54 seconds and started zero additional model calls. This exercised a local Git branch and a separate trusted worker using the packaged wrapper.

## It takes private records to establish which model ran

The public comparison result reports per-case scores, version IDs and completion. It omitted the model identity. On the native run, a reviewer joined the two private job handles to the provider’s thread records to confirm the exact model and effort. On the Python run, the integration pinned the model and verified its dispatch path. Ephemeral Codex JSONL reported successful turns and token usage but supplied no independently verifiable resolved model. A useful result would show what the application requested, what the provider confirmed when available, and the source of each value. Leaving an unreported value empty preserves the difference. [Codex integration](../../examples/native-repository/harnesses.mjs)

The Python plugin also had to distinguish two LLM transports that advertised the same model ID. That check belongs to the app. An SDK integration example can show where to record its outcome alongside usage. The Python parent reported 23,932 input and 8 output tokens, and the candidate reported 24,038 and 8. USD cost was unreported.

## Comparison records

| Task | Comparison | Outcome |
| --- | --- | --- |
| Native coding-agent change | `935f6dab-810d-4fca-adf1-902806e14c8c` | 1/1 for each arm with the app’s grader. This run supplied no policy. |
| Python LLM plugin and CLI support task | `89da066f-fdd0-4e66-8234-7de80a1f9681` | 1/1 for each arm. The no-regression policy passed. |
| Local Git PR format regression | `b69f4e49-7817-4812-a898-44282701fd3d` | Parent 1/1, candidate 0/1. Recorded failure, exit 2 on the original and replay. |
