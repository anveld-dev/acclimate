"""The Python examples stay importable and render a bundle as the learning executor does."""

import importlib.util
from pathlib import Path
import unittest

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def load(path: str):
    spec = importlib.util.spec_from_file_location(Path(path).stem, EXAMPLES / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExamplesTest(unittest.TestCase):
    def test_support_agent_renders_a_bundle_as_the_executor_does(self):
        payload = {"schemaVersion": 1, "files": [
            {"path": "memory/facts.md", "kind": "memory", "text": "Refunds take five days.\n"},
            {"path": "skills/refunds/SKILL.md", "kind": "skill", "text": "Refund steps.\n"},
            {"path": "instructions.md", "kind": "instruction", "text": "Answer briefly.\n"},
        ]}
        # scripts/examples.test.ts checks the executor's runner against the same text.
        self.assertEqual(
            load("support-agent/agent.py").system_prompt(payload),
            "# instructions.md\nAnswer briefly.\n\n\n# skills/refunds/SKILL.md\nRefund steps.\n\n\n"
            "# memory/facts.md\nRefunds take five days.\n",
        )

    def test_ticket_triage_reads_its_bundle_directory(self):
        loop = load("ticket-triage/loop.py")
        payload = loop.payload_from_directory(EXAMPLES / "ticket-triage" / "bundle")
        self.assertEqual([(file["path"], file["kind"]) for file in payload["files"]], [("instructions.md", "instruction")])


if __name__ == "__main__":
    unittest.main()
