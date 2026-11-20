# Installed Python type contract

These fixtures use only public imports. `positive.py` imports every domain type from
the package root, checks lifecycle/delivery return annotations and generic callback
inference. `negative.py` must reject unknown request fields, missing required fields,
invalid lifecycle status and invalid execution/grading callback results. It contains
intentional errors and is checked separately, never run as an application.

The combined closure fixtures also import the public progress DTOs/reporter and
check the analysis API with typed comparison/descriptor inputs, component metrics,
observations and uncertainty protocol. Its analysis binding must include
`comparisonId`; omitting it adds the seventh expected negative diagnostic. The eighth rejects the removed `offline_max_age` keyword in favor of `offline={"max_age_ms": ...}`. The last rejects a `VerifiedVersionConnection` without `connectionId`; `positive.py` reads `VerifiedVersion["connection"]` with the same shape as the TypeScript `VerifiedVersion.connection`.

Install a freshly built wheel in an external Python 3.11+ consumer venv with
`--no-index --no-deps`. Install `mypy==1.18.2` in a separate developer-tool venv, then
run from the repository root:

```sh
python3.11 python/tests/typing/check_installed.py \
  --consumer-python /absolute/consumer-venv/bin/python \
  --mypy-python /absolute/mypy-tool-venv/bin/python
```

The driver copies fixtures outside the checkout, clears import path overrides, uses
strict mypy without suppression flags or ignores, and targets the consumer interpreter.
It separately verifies the installed package location, PEP 561 marker, zero runtime
dependencies, public export identity and lifecycle/callback runtime annotations. The
checker is a development tool; it is not a runtime SDK dependency. This checks the
public consumer contract, not a strict audit of every private implementation module.
