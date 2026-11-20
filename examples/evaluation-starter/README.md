# TypeScript evaluator starter

Install the dependencies and add `application.mjs` or `application.mts` next to `acclimate-eval.mjs`. Export `cases`, `execute`, and `grade`. Cases are objects with `caseId`, `input`, and `expected`. The executor receives a verified version and the case input and returns `{ output }`. The grader receives the output and expected result and returns `{ reward }`.

```sh
npm install
node acclimate-eval.mjs describe
node acclimate-eval.mjs coverage
node acclimate-eval.mjs try --payload ./bundle --live
```

For deterministic adapters, export `execution = 'model-free'` and omit `--live`. Choose specific cases with `--case` or provide a private JSON inventory using the absolute path in `ACCLIMATE_EVALUATOR_CASES`. The inventory file must be owned by you with mode 0400 or 0600.

Use `doctor --config CONFIG --bundle ID` to check local evaluator storage and service access. Use `pull --config CONFIG --bundle ID --out PAYLOAD` to save the published payload for a local test.
