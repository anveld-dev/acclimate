#!/usr/bin/env bash
set -euo pipefail
scratch="$PWD/.real-app-scratch"
export TMPDIR="$scratch"
export LLM_USER_PATH="$scratch/llm-user"
export PYTHONDONTWRITEBYTECODE=1
"$scratch/venv/bin/python" examples/real-app-learning/grade.py --check
"$scratch/venv/bin/python" -m pytest "$scratch/llm/tests/test_encode_decode.py" -q
mkdir -p "$scratch/preflight"
codex exec --json --model gpt-6-luna -c 'model_reasoning_effort="low"' --ephemeral \
  --sandbox read-only -C "$scratch/preflight" 'Reply with the single word ready. Do not use tools.' \
  > "$scratch/preflight.jsonl"
