# Codex session qualification

Run `npx tsx examples/codex-session-check.ts` explicitly to make three paid `gpt-6-luna` turns using the normal local Codex app authentication. This is not part of the offline test suite. The script uses private temporary workspaces, read-only sandbox, approval never, disabled network and web search, and a 110-second timeout per turn. It records the app's version ID and digest alongside marker matches and SDK item types, without printing the random markers. Resource markers are generated independently and are absent from the prompt. A resumed thread retains conversation history, so its response alone cannot establish a new file read.

On 2026-11-13, with `@openai/codex-sdk` 0.169.0 and `gpt-6-luna`, the script completed all three turns:

| Observation | App version and digest | Instruction, skill, memory markers | Other version markers |
| --- | --- | --- | --- |
| Fresh v1 | `session-v1`, `sha256:35c601615d2e47f396b4e36f3599d5ec6a84ab7534df25c5e215934da6ad678b` | all present | none present |
| Fresh v2 after preparing refresh | `session-v2`, `sha256:a43acef1fa1f8c7da125a5085e0de8edc9a26afa920f98009a34207cab79bcd7` | all present | none present |
| Resumed v1 after refresh | same v1 and digest | all present | none present |

All turns included `agent_message`, `command_execution`, and `error` item types. The simple command-string checks did not identify a direct skill or memory file read in any turn. These are response observations, not SDK discovery events or proof of how a resource was loaded; the error items were not classified. Preparing v2 created a separate workspace and did not overwrite v1. The resumed thread was explicitly resumed with the original workspace and can remember previous answers. This experiment does not test modifying files in place or establish a hot-reload guarantee. Native behavior may vary by SDK and environment.

The offline unit test additionally checks both versions' instruction, skill and memory files, recorded IDs and digests, separate workspace paths, and preservation of v1 after v2 cleanup. It tests staging and pinning only, not model behavior.
