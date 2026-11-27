# Installed Python type contract

The installed fixtures exercise delivery, job and release request types. Negative fixtures require a release reason and the complete connection identity. They also check that offline delivery uses the `offline` option. Run the negative fixtures through the type checker.

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
dependencies, public export identity and release runtime annotations. The
checker is a development tool; it is not a runtime SDK dependency. This checks the
public consumer contract, not a strict audit of every private implementation module.
