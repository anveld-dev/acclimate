"""The system prompt helper renders a bundle as the learning runner does."""

import json
from pathlib import Path
import unittest

from acclimate import system_prompt, validate_payload

# packages/sdk/tests/delivery/system-prompt.test.ts checks this fixture against
# executor/runner/chat.mjs messages(), the function that builds the loop's system message.
FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "system-prompt-v1.json").read_text(encoding="utf-8")
)


class SystemPromptTest(unittest.TestCase):
    def test_renders_the_shared_fixture_byte_for_byte(self):
        validate_payload(FIXTURE["payload"])
        self.assertEqual(system_prompt(FIXTURE["payload"]).encode(), FIXTURE["systemPrompt"].encode())

    def test_an_empty_bundle_renders_an_empty_prompt(self):
        self.assertEqual(system_prompt({"schemaVersion": 1, "files": []}), "")


if __name__ == "__main__":
    unittest.main()
