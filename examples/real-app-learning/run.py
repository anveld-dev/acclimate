"""Run the preregistered comparison against an isolated PostgreSQL instance."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/productization"))

from qualify import Harness


def main():
    scratch = ROOT / ".real-app-scratch"
    os.environ.update(
        TMPDIR=str(scratch),
        LLM_USER_PATH=str(scratch / "llm-user"),
        PYTHONDONTWRITEBYTECODE="1",
        CARGO_TARGET_DIR=str(scratch / "target"),
        CARGO_PROFILE_DEV_DEBUG="0",
    )
    assert (scratch / "preflight.jsonl").is_file(), "Run preflight.sh first"
    harness = Harness(sys.argv[1])
    try:
        harness.start_database()
        subprocess.run(
            ["node", "--import", "tsx", "examples/real-app-learning/run.ts"],
            env=dict(os.environ, EVALUATION_TEST_DATABASE_URL=harness.env["DATABASE_URL"]),
            cwd=ROOT,
            timeout=6 * 3600,
            check=True,
        )
    finally:
        harness.close()


if __name__ == "__main__":
    main()
