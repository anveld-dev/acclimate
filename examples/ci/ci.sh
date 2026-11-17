#!/bin/sh
# Provider-neutral example. No model calls unless the app definition and command opt in.
set -eu
acclimate_ci_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
acclimate_ci_language=javascript
acclimate_ci_config=
acclimate_ci_bundle=
acclimate_ci_intent=
acclimate_ci_output=
acclimate_ci_payload="$acclimate_ci_dir/evaluation/candidate.json"
while [ "$#" -gt 0 ]; do
  if [ "$#" -lt 2 ]; then
    printf '%s\n' 'CI starter arguments require values' >&2
    exit 1
  fi
  case "$1" in
    --language) acclimate_ci_language=$2 ;;
    --config) acclimate_ci_config=$2 ;;
    --bundle) acclimate_ci_bundle=$2 ;;
    --intent) acclimate_ci_intent=$2 ;;
    --output-dir) acclimate_ci_output=$2 ;;
    --payload) acclimate_ci_payload=$2 ;;
    *) printf '%s\n' 'Unknown CI starter argument' >&2; exit 1 ;;
  esac
  shift 2
done
if [ -z "$acclimate_ci_config" ] || [ -z "$acclimate_ci_bundle" ] || [ -z "$acclimate_ci_intent" ] || [ -z "$acclimate_ci_output" ]; then
  printf '%s\n' 'Required: --config --bundle --intent --output-dir; all private paths are explicit' >&2
  exit 1
fi
case "$acclimate_ci_output" in /*) ;; *) printf '%s\n' '--output-dir must be absolute' >&2; exit 1 ;; esac
umask 077
mkdir -p "$acclimate_ci_output"
acclimate_eval() {
  case "$acclimate_ci_language" in
    javascript) node "$acclimate_ci_dir/evaluation/acclimate-eval.mjs" "$@" ;;
    python) "${ACCLIMATE_CI_PYTHON:-python3.11}" "$acclimate_ci_dir/evaluation/acclimate_eval.py" "$@" ;;
    *) printf '%s\n' 'Language must be javascript or python' >&2; return 1 ;;
  esac
}
acclimate_ci_handoff="$acclimate_ci_output/evaluation-request.json"
acclimate_eval doctor --config "$acclimate_ci_config" --bundle "$acclimate_ci_bundle" --policy "$acclimate_ci_dir/evaluation/quality-policy.json"
acclimate_eval request --config "$acclimate_ci_config" --bundle "$acclimate_ci_bundle" --channel stable --payload "$acclimate_ci_payload" --intent "$acclimate_ci_intent" --out "$acclimate_ci_handoff"
if acclimate_eval run --config "$acclimate_ci_config" --handoff "$acclimate_ci_handoff"; then
  acclimate_ci_run_status=0
else
  acclimate_ci_run_status=$?
fi
acclimate_ci_policy_status=3
if [ "$acclimate_ci_run_status" -eq 0 ]; then
  if acclimate_eval check --config "$acclimate_ci_config" --handoff "$acclimate_ci_handoff" --policy "$acclimate_ci_dir/evaluation/quality-policy.json"; then
    acclimate_ci_policy_status=0
  else
    acclimate_ci_policy_status=$?
  fi
fi
# Export is explicit even when evaluation/check failed. Missing required content
# yields no complete manifest. Upload only a successfully committed export.
acclimate_ci_export="$acclimate_ci_output/review-$(date +%s)-$$"
acclimate_ci_export_status=0
if acclimate_eval export --config "$acclimate_ci_config" --handoff "$acclimate_ci_handoff" --selection "$acclimate_ci_dir/evaluation/share-selection.json" --out "$acclimate_ci_export"; then
  if acclimate_eval verify-export --manifest "$acclimate_ci_export/manifest.json"; then :; else
    acclimate_ci_export_status=$?
  fi
else
  acclimate_ci_export_status=$?
fi
if [ "$acclimate_ci_run_status" -ne 0 ]; then exit "$acclimate_ci_run_status"; fi
if [ "$acclimate_ci_policy_status" -ne 0 ]; then exit "$acclimate_ci_policy_status"; fi
exit "$acclimate_ci_export_status"
