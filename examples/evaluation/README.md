# Evaluator adapter

An application supplies the case inventory and two callbacks. `execute` runs the agent with a versioned bundle and returns its output. `grade` scores that output against the expected result.

Use `acclimate-eval describe` to inspect the application descriptor and `acclimate-eval try --payload ./bundle` to test the callbacks. Add `--live` for adapters that call a model. See the [TypeScript starter](../evaluation-starter/) or [Python starter](../python-evaluation-starter/) for setup.
