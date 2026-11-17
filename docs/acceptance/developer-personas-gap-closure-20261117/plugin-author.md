# Coding-agent plugin author fresh-release retest

Acceptance criteria were recorded before execution on 2026-11-17: consume the fresh checksummed release outside the checkout; retrieve a pinned instruction/skill/two-memory bundle through an actual Rust/PostgreSQL service-issued content-read credential; exercise all four installed plugin preparations with owned deterministic children; preserve original source, exclude withheld memory, reject guidance conflicts, retain patch/manifests before cleanup, and quarantine uncertain children until confirmed termination. The authorized live gate was one fresh `@openai/codex-sdk@0.169.0` / `gpt-6-luna` task, bounded to 110 seconds, with resource reads, actual failing/passing repository tests, a source edit, independent unchanged-test verification and normal process completion.

**Passed on the fresh gap-closure release.** The native archive supplied its own `package.json`, `verify-install.mjs` and `codexRuntimeInputs` helper. The external consumer actually called both installed helpers. All 120 files across the SDK and four plugins matched the exact file sets and bytes in their five release tarballs, including a repeat verification after installing Codex. All public imports and the optional Codex native executable resolved within the external consumer. npm used an explicit absolute `--prefix` and `--workspaces=false`; enclosing repository manifests and lockfiles remained byte-identical. npm deliberately added dependency declarations to the consumer's own manifest.

The release source inventory is `63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd`; manifest SHA-256 `d58ba710bf5a2d0829d7a61e3520c69bd607be87dfe258f41fccfec4ebbf660f`; service binary SHA-256 `c84d1961249e635c024346fb23328dccf738f0aa7eef0e5e50fa4b00111d2a50`. Checkout HEAD is `63eb588458732fbba53c0969c9b892cf08a572fe` with the released uncommitted gap-closure implementation identified by the source inventory. No binary-to-source build attestation is claimed. Full archive, helper, entrypoint, patch and manifest hashes are in the [machine-readable evidence](plugin-author.json). The [earlier acceptance](../developer-personas-20261117/plugin-author.md) remains unchanged.

| Gate | Observation | Result |
| --- | --- | --- |
| Installed starter fixes | Archive contains its own manifest; distributed install verifier used for five Acclimate packages and exact Codex SDK version; distributed explicit runtime helper used by the live adapter | Passed |
| All four preparations | Codex, Claude, Pi and Cursor preparations each ran an owned deterministic child: original retry test exit 1, source correction, final test exit 0, child exit 0 | Passed; no live Claude/Pi/Cursor calls |
| Memory policy | Each child read only the selected random memory marker; recursive prepared-workspace scans and effective context excluded the withheld canary | Passed |
| Conflicts | `AGENTS.md`, `nested/claude.MD`, `.cursor/skills/retry-review/SKILL.md` rejected with `native.control_path` | Passed |
| Uncertain child | Workspace retained while the owned child was alive; cleanup without termination confirmation rejected; SIGKILL and reap preceded explicit recovery cleanup | Passed; deterministic child only |
| Fresh Codex task | Resources/source read, provider-run baseline exit 1, actual source file change, provider-run final test exit 0, host final test exit 0 | Passed; one live session |
| Retention and cleanup | Four deterministic patch/manifests and live patch/manifest survive workspace removal; original source and live test bytes unchanged; zero remaining workspaces | Passed |
| Service cleanup | Owned service stopped and private PostgreSQL directory removed | Passed |

The service-issued reader resolved pinned version `7ad3254b-febb-4289-ac01-854567390334`, digest `sha256:2a512645c56a68a3ee2e6a8ab7023c16521fbeada031af2f1822895a110a7524`. The operator credential was used only to create the disposable service fixture and reader. The task adapter fetched the pinned bundle through the real service; it did not construct a local verified-bundle substitute. Random instruction, skill and selected-memory canaries were absent from the prompt, then matched in the provider's response after its observed file read. The selected-memory digest in the job records hashes the selected path inventory; it is not a digest of memory text.

The live adapter called installed `codexRuntimeInputs(effective, {env, model, config, configOverrides})`, then passed its constructor and thread options to the installed official SDK. Environment values came privately from `PersonaFixture.sdk_env`, whose allowlist contains authentication and runtime basics. Ordinary service/install/consumer subprocesses used the credential-stripped environment. A mode-0600 one-use private adapter configuration carried the SDK environment and was removed after the SDK turn completed normally and confirmed stop was recorded; the public declaration contains only environment names, configuration provenance, nonsecret options and declaration SHA-256 `9ab00fbcc63cb44640b84baa978eeef24681d6719fe3f3d88f0ff83cf8a20f36`. No credential values or credential hashes are published.

The declared policy selected `workspace-write`, approval `never`, disabled network/web search, low reasoning and a 110,000 ms turn signal. It deliberately retained the selected host `CODEX_HOME`/`HOME` configuration provenance. Full host-configuration isolation is unproven. The SDK reported five nonfatal ambient warnings: two deprecated multi-agent settings, two ignored remote-connections settings and one marketplace-root warning. These warnings and the substantial reported context usage remain material limits of this host policy.

Thread `01a1ea08-90f3-7da1-aef5-37a218adbd19` completed normally. Its 19 SDK events were `thread.started`, `turn.started`, `item.started`, `item.completed` and `turn.completed`; the JSON retains the ordered event/item ledger. Observed completed work was:

1. `item_6`: read `AGENTS.md`, the prepared retry-review skill, selected memory, `src/retry.js` and `tests/retry.test.mjs`; exit 0.
2. `item_7`: `node --test tests/retry.test.mjs`; exit 1.
3. `item_9`: completed `file_change` updating `src/retry.js`.
4. `item_10`: the same repository test; exit 0.

Reported usage was 108,224 input tokens, 85,376 cached input tokens, 0 cache-write input tokens, 659 output tokens and 0 reasoning output tokens. No cost or provider-request count is inferred. Installed SDK implementation SHA-256 is `340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4`; native CLI SHA-256 is `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002`.

The live patch is 214 bytes, SHA-256 `64579463e5608e0232319f673dc50398faf1b9cf05c0c52b0b6f5c7318a3fb46`. Its retained manifest SHA-256 is `b284267092fb5e7203b8dc6183dddf36c9a3f36b1bc8d19672a50c98df13a410`. Host verification independently reran the test successfully and compared working test bytes with the original. The live job facts are `prepared=true`, `launchIntent=true`, `confirmedStopped=true`, `resultsRetained=true`, `cleaned=true`. Normal SDK stream exhaustion in installed SDK 0.169.0 awaits the Codex executable exit; this successful run never used forced termination as cleanup authorization. The recovered deterministic quarantine correctly records `resultsRetained=false`; recovery removed that uncertain workspace after termination rather than accepting its unconfirmed output.

The acceptance harness was updated to use the actual consumer directory when sanitizing reports, the new installed helpers, private explicit SDK inputs, random selected-memory canaries and release/binary/enclosing-manifest guards. Generated Python/JavaScript syntax checks passed. The live acceptance passed on its first fresh-release execution; no provider run was repeated. Post-run reporting enrichment read retained job records and SDK events without any provider call. The harness now removes the one-use SDK handoff in a guarded `finally` after normal completion and confirmed stop; that cleanup was also applied to this retained run. User authentication files were untouched.

Reproduce with the verified service binary already built and the frozen release:

```sh
ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1 \
ACCLIMATE_PERSONA_SOURCE_SHA256=63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd \
PYTHONPATH=. /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  -m scripts.acceptance.dx_personas.plugin_author \
  --output /private/tmp/acclimate-codex-gap-retest-20261117 --live-codex \
  --report docs/acceptance/developer-personas-gap-closure-20261117/plugin-author.json
```

Private evidence is retained at `/private/tmp/acclimate-codex-gap-retest-20261117/plugin-author-51t5ejt5`, including commands, SDK events, service-fetched inputs, job records and retained artifacts. It contains private credentials and canaries and must not be published wholesale. This persona does not qualify forced real-provider cancellation, resumed sessions, in-place reload, skill-discovery events, general model quality or behavioral improvement. Evaluation/console journeys are outside this persona run.
