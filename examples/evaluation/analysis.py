"""Checkout compatibility entry point for the distributed starter recipe."""
from pathlib import Path
import runpy


if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parents[1] / "evaluation-starter" / "analyze.py"), run_name="__main__")
