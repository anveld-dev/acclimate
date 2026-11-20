# Evaluation analysis recipes

The canonical [analysis guide](../evaluation-starter/ANALYSIS.md) and executable
`analyze.mjs` / `analyze.py` programs ship in the evaluation starter archive.
The `analysis.mjs` and `analysis.py` files here are thin checkout compatibility entry points.

Each interval states the question it answers: `paired-t` for tasks like these
(`estimand: "sampled-cases"`, the same question as the default policy test) and
the variance-scaled `paired-within-case-bootstrap` for these tasks again
(`estimand: "fixed-cases"`, at least three repetitions per case). The starter guide
publishes their simulated coverage.
