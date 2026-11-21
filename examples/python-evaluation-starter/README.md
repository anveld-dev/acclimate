# Python evaluator starter

Install the verified `acclimate-sdk` wheel in a Python 3.11+ environment with `python -m pip install --no-index --no-deps /absolute/path/to/acclimate_sdk-0.1.0-py3-none-any.whl`. Copy `application.example.py` to `application.py` and adapt its `cases`, `execute`, and `grade` to your app.

```sh
python acclimate_eval.py describe
python acclimate_eval.py coverage
python acclimate_eval.py try --payload /path/to/your/bundle
```

Use `--case ID` to choose a case. For callbacks that call a model, set `execution = "live"` and pass `--live` to `try`. The installed `acclimate` script and `python -m acclimate` provide the same commands.

Use `doctor --config CONFIG --bundle ID` to check local evaluator storage and service access. Use `pull --config CONFIG --bundle ID --out PAYLOAD` to save the published payload for a local test.
