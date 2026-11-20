#!/bin/sh
set -eu
# The SDK invokes "exec". Keep every turn ephemeral and inherit the experiment's read fence.
test "${1:-}" = exec
shift
cd "$SIM_CODEX_CWD"
exec /usr/bin/sandbox-exec -p "$SIM_CODEX_SANDBOX" codex exec --ephemeral "$@"
