#!/bin/sh
set -eu
ci_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${ACCLIMATE_CI_PYTHON:-python3}" "$ci_dir/ci.py" "$@"
