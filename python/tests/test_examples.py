"""The Python examples stay importable and render a bundle with the SDK helper."""

import importlib.util
from pathlib import Path
import unittest

import acclimate

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def load(path: str):
    spec = importlib.util.spec_from_file_location(Path(path).stem, EXAMPLES / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExamplesTest(unittest.TestCase):
    def test_support_agent_renders_with_the_sdk_helper(self):
        # test_system_prompt.py checks the helper against the executor's runner.
        self.assertIs(load("support-agent/agent.py").system_prompt, acclimate.system_prompt)

    def test_ticket_triage_reads_its_bundle_directory(self):
        loop = load("ticket-triage/loop.py")
        payload = loop.payload_from_directory(EXAMPLES / "ticket-triage" / "bundle")
        self.assertEqual([(file["path"], file["kind"]) for file in payload["files"]], [("instructions.md", "instruction")])


if __name__ == "__main__":
    unittest.main()
