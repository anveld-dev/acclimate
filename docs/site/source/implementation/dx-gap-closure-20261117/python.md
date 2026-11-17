# Python public imports and onboarding closure

The [original Python persona](../../acceptance/developer-personas-20261117/python-integrator.md)
passed installed submodule typing, but its documented
`from acclimate import AcclimateClient` failed mypy 1.18.2 strict checking with
`attr-defined`. The SDK README also assumed an already available wheel. That
acceptance report and its original JSON remain unchanged as historical evidence.

`python/acclimate/__init__.py` now explicitly re-exports the 10 existing public
client/delivery/receipt symbols and all 46 domain types using same-name import
aliases. Strict consumers can use the documented root imports without private
modules or a submodule workaround. The original wildcard runtime surface remains
for compatibility, including its incidental typing helpers. No classes, functions,
wire fields or runtime dependencies changed. `pyproject.toml` already packages
`py.typed`; no packaging metadata change was needed.

`python/README.md` now identifies operator-managed release acquisition, exact
0.1.0 wheel/starter filenames, checksum verification, application-venv offline
installation and the separate contributor source-build path. It links to getting
started, source packaging, the installed-app starter, complete asyncio recipe and
operator recovery guide. It distinguishes checkout imports/examples from installed
SDK files, labels the API synchronous, and explains whole-worker cancellation and
stable durable-journal ownership.

## Verification performed

Python 3.11.7 built a wheel from a private copy of `python/`, installed it offline
with `--no-index --no-deps` into an external temporary consumer venv, and ran the
new `python/tests/typing/check_installed.py` driver against it. Shared `python/dist`,
build directories and retained releases were not written. The isolated developer
tool environment from the original acceptance run supplied mypy **1.18.2**; it was
not installed in the runtime consumer. The exact command, wheel hash, source hashes,
environment paths and output are retained privately in:

- `artifacts/dx-gap-closure-20261117/python-typing-environment.json`
- `artifacts/dx-gap-closure-20261117/python-typing-result.json`
- `artifacts/dx-gap-closure-20261117/python-typing.log`

The reusable command is:

```sh
python3.11 python/tests/typing/check_installed.py \
  --consumer-python /absolute/installed-consumer-venv/bin/python \
  --mypy-python /absolute/mypy-1.18.2-tool-venv/bin/python
```

The driver removes import path overrides, copies fixtures outside the checkout,
selects the installed consumer interpreter and runs strict mypy without ignore or
suppression flags. Results:

| Check | Result |
| --- | --- |
| All 56 root exports, typed lifecycle/delivery calls and generic callback inference | Strict positive fixture exits 0 |
| Unknown `attempt_id`, missing `comparisonId`, invalid evaluation status, invalid executor result and invalid grader result | Negative fixture exits 1 with exactly 6 expected diagnostics |
| Installed site-packages provenance, `py.typed`, zero runtime dependencies | Passed |
| Root type identity and public lifecycle/callback runtime annotations | Passed |
| `PYTHONPATH=python /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m unittest discover -s python/tests -v` | 82 tests passed |
| Python README relative link targets | All exist |

This is public installed-consumer type-contract verification, not a strict audit
of every private implementation module. It uses a disposable wheel snapshot while
other closure work proceeds; final release qualification must build and check the
combined frozen sources. No new Rust/PostgreSQL or real-service persona run was
performed for this import/documentation fix. No model/provider call, registry
publication, production change or recovery-journal mutation occurred. The old
acceptance wheel and records are preserved.

## Combined API source follow-up

After the analysis/progress helpers were added, the fixtures gained the public
progress DTO/reporter imports and a typed `analyze_comparison` call using
`Comparison`, `EvaluationDescriptor`, `AnalysisComparisonBinding`, metrics,
observations and uncertainty. Strict mypy 1.18.2 reports no consumer diagnostics
for the positive source fixture. The negative fixture now produces exactly seven
expected consumer diagnostics, including a missing analysis `comparisonId`.
This follow-up used source-path resolution and is not an installed-wheel claim;
the final combined release qualification must rerun the installed driver.

An independent analysis review caught and verified the owner's fixes for component
metrics incorrectly remaining usable when the scalar score was null/nonfinite,
and for bare-dictionary annotations rejecting public typed comparison/descriptor
inputs. Final analysis source tests pass (27 JavaScript tests, five Python tests,
including shared vectors). Analysis conclusions remain conditional on explicitly
declared independent stochastic paired repetitions for fixed tasks.
