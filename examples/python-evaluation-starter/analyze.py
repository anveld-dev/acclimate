"""Run from an application with an installed acclimate-sdk wheel; no checkout imports."""
import json
from pathlib import Path
import re
import sys

from acclimate.evaluation_analysis import analyze_comparison


def main():
    if not 4 <= len(sys.argv) <= 5:
        print("Usage: python analyze.py comparison.json descriptor.json trusted-binding.json [analysis-config.json]", file=sys.stderr)
        return 1
    try:
        comparison, descriptor, binding = [json.loads(Path(file).read_text(encoding="utf-8")) for file in sys.argv[1:4]]
        config = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8")) if len(sys.argv) == 5 else {}
        if type(config) is not dict or set(config) - {"metrics", "observations", "uncertainty"}:
            raise ValueError()
        result = analyze_comparison(comparison=comparison, expected_descriptor=descriptor,
                                    expected_binding=binding, **config)
        print(json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        code = getattr(error, "code", "")
        print(json.dumps({"code": code if isinstance(code, str) and re.fullmatch(
            r"(analysis|evidence|policy)\.[a-z_]+", code) else "analysis.input_invalid"}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
