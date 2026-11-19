"""Run from an application with an installed acclimate-sdk wheel; no checkout imports.

    python analyze.py --name RUN_NAME --config EVALUATOR_CONFIG [analysis-config.json]
    python analyze.py comparison.json descriptor.json trusted-binding.json [analysis-config.json]

--name reads the run's handoff from the evaluator journal and fetches the request and comparison
from the service, so you do not assemble the trusted binding by hand.
"""
import json
from pathlib import Path
import re
import sys

from acclimate.client import AcclimateClient
from acclimate.evaluation_analysis import analyze_comparison

USAGE = ("Usage: python analyze.py --name RUN_NAME --config EVALUATOR_CONFIG [analysis-config.json]\n"
         "       python analyze.py comparison.json descriptor.json trusted-binding.json [analysis-config.json]")
BINDING_FIELDS = ("parentVersionId", "candidateVersionId", "parentDigest", "candidateDigest",
                  "requestId", "attemptId", "comparisonId")


class InputError(ValueError):
    def __init__(self, code, **detail):
        super().__init__(code)
        self.code, self.detail = code, detail


def read(file):
    try:
        text = Path(file).read_text(encoding="utf-8")
    except OSError:
        raise InputError("analysis.file_unreadable", file=str(file)) from None
    try:
        return json.loads(text)
    except ValueError:
        raise InputError("analysis.file_not_json", file=str(file)) from None


def from_journal(name, config_file):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
        raise InputError("analysis.run_name_invalid", name=name)
    config = read(config_file)
    if not isinstance(config, dict) or not all(config.get(key) for key in ("serviceUrl", "projectId", "evaluatorToken", "journalRoot")):
        raise InputError("analysis.config_invalid", file=str(config_file))
    handoff = read(Path(config["journalRoot"]) / "comparisons" / name / "request.json")
    client = AcclimateClient(config["serviceUrl"], config["evaluatorToken"], config.get("evaluatorPrincipalId", "evaluator"))
    request = client.get_evaluation(handoff["projectId"], handoff["bundleId"], handoff["requestId"])
    if not request.get("comparisonId") or not request.get("attemptId"):
        raise InputError("evidence.not_terminal", requestId=request["id"], status=request["status"])
    comparison = client.get_comparison(handoff["projectId"], handoff["bundleId"], request["comparisonId"])
    binding = {"parentVersionId": request["parentVersionId"], "candidateVersionId": request["candidateVersionId"],
               "parentDigest": request["parentDigest"], "candidateDigest": request["candidateDigest"],
               "requestId": request["id"], "attemptId": request["attemptId"], "comparisonId": request["comparisonId"]}
    if request.get("evaluatorPrincipal"):
        binding["submitter"] = request["evaluatorPrincipal"]
    descriptor = {name: request[name] for name in ("datasetRevision", "graderRevision", "runtime", "expectedCases")}
    return comparison, descriptor, binding


def main(args):
    try:
        if args[:1] == ["--name"]:
            if len(args) not in (4, 5) or args[2] != "--config":
                raise InputError("analysis.usage")
            comparison, descriptor, binding = from_journal(args[1], args[3])
            config_file = args[4] if len(args) == 5 else None
        else:
            if len(args) not in (3, 4):
                raise InputError("analysis.usage")
            comparison, descriptor, binding = [read(file) for file in args[:3]]
            missing = [field for field in BINDING_FIELDS if not isinstance(binding, dict) or not binding.get(field)]
            if missing:
                raise InputError("analysis.binding_invalid", file=args[2], missingFields=missing)
            config_file = args[3] if len(args) == 4 else None
        config = read(config_file) if config_file else {}
        unknown = sorted(set(config) - {"metrics", "observations", "uncertainty"}) if isinstance(config, dict) else []
        if not isinstance(config, dict) or unknown:
            raise InputError("analysis.invalid_config", file=config_file, unknownFields=unknown)
        result = analyze_comparison(comparison=comparison, expected_descriptor=descriptor,
                                    expected_binding=binding, **config)
        print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        code = getattr(error, "code", "")
        if code == "analysis.usage":
            print(USAGE, file=sys.stderr)
        print(json.dumps({"code": code if isinstance(code, str) and re.fullmatch(
            r"(analysis|evidence|policy)\.[a-z_]+", code) else "analysis.input_invalid",
            **(error.detail if isinstance(error, InputError) else {})}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
