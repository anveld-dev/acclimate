# Python evaluator starter

Install `acclimate-sdk` in a Python 3.11+ environment. Copy `application.example.py` to `application.py` and adapt its `cases`, `execute`, and `grade` to your app.

```sh
python acclimate_eval.py describe
python acclimate_eval.py coverage
python acclimate_eval.py try --payload ./bundle
```

Use `--case ID` to choose a case. For callbacks that call a model, set `execution = "live"` and pass `--live` to `try`. The installed `acclimate` script and `python -m acclimate` provide the same commands.

Use `doctor --config CONFIG --bundle ID` to check local evaluator storage and service access. Use `pull --config CONFIG --bundle ID --out PAYLOAD` to save the published payload for a local test.
