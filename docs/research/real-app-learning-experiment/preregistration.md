# Pre-registration for connected learning on LLM

Test whether a service-proposed candidate improves binary CLI-support correctness on LLM 0.38 at upstream commit `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`. Use authenticated Codex with explicit `gpt-6-luna` and low reasoning effort for each turn, including the proposer and critic through a local adapter to the service's native chat-completions transport.

The frozen task source assigns 30 development, 30 audit and 10 field cases by rotating the seven positions of each family. There is one audit cohort. Use one observation per arm in each comparison. Each answer is an argv array. Feed it to the pinned LLM Click parser and compare the selected command and all parsed parameters with the reference. Invoke no command handlers. Validate every canonical answer and negative control and run the upstream frozen encode/decode pytest file before the first paid turn.

Start from the linked baseline. Allow edits to its instruction and memory only. First check model access with one tool-free readiness response. Run A/A calibration on development. Run the field tasks on normal baseline delivery, report all outcomes and attach app-validated corrections for failures. Permit up to three proposal admissions and set the audit cadence to one accepted step to ensure the checked cumulative head can reach the sole audit cohort. Use the service's default development and audit statistical gates. Manually approve a passing review only if the audit lower bound is strictly positive and the diff contains reusable guidance. Report a candidate that never reached audit as unevaluated on audit. Keep all spent attempts in the 600-turn budget and cap runtime at six hours. Record provider usage when returned. Do not replace the task set, grader or bundle after seeing evaluation results.

- [Task definitions](../../../examples/real-app-learning/tasks.py)
- [Click grader](../../../examples/real-app-learning/grade.py)
- [Baseline](../../../examples/real-app-learning/baseline.json)

SHA-256 digests of frozen files follow.

```text
98ba61a7435fe79a90285a67effc0cec9bea0e303362ef232aece0b96615d3fe  examples/real-app-learning/tasks.py
7d2b7347c5fb9c471235bbb448f8948a0e836bf4faccdf860abb4ab1b2838172  examples/real-app-learning/grade.py
1a760943b79185b7cff38cea52e06f67b8fe32cd090f560dd4453e0019db103b  examples/real-app-learning/baseline.json
```
