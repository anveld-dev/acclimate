# Self-improvement

Acclimate delivers immutable bundle versions in this release. A later release will run the [self-improvement loop](../architecture/self-improvement-memory/README.md) for enrolled bundles, based on [arXiv 2611.18856](https://arxiv.org/abs/2611.18856).

The loop scores the incumbent on evolve cases, proposes five candidate harness changes, screens them, and evaluates the survivors. The selector keeps the incumbent or adopts a survivor and releases it to the learning channel. Improvement memory records the adopted change's diagnosis, predictions and fixes. The application's evaluator scores the retained version on held-out cases for monitoring.
