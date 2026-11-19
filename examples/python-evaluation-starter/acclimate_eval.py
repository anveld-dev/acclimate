"""Run the installed evaluator against this application's adjacent adapter."""
from pathlib import Path

from acclimate.evaluation_app import SetupError, installed_application as _load, main as _main


def installed_application():
    return _load(Path(__file__).resolve().parent)


def main(argv=None):
    return _main(argv, directory=Path(__file__).resolve().parent)


if __name__ == "__main__":
    raise SystemExit(main())
