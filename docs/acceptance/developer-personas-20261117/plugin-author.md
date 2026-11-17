# Coding-agent plugin author acceptance

Criteria fixed before execution on 2026-11-17:

1. Install the native repository starter, SDK and all four plugin tarballs from the checksummed release into an external consumer. Retrieve a pinned instruction/skill/two-memory bundle from the actual Rust/PostgreSQL service with a distinct service-issued content-read credential.
2. For each plugin, use the public repository helper to combine that bundle with frozen existing source. An owned deterministic child process must read instructions, skill, selected memory and source; observe the original retry test fail; change code; and run the repository test successfully. Retain the patch/result manifest before cleanup; preserve original source bytes.
3. Reject existing repository guidance conflicts, and prove withheld memory is absent from both the child context and prepared workspace.
4. Leave an uncertain, still-running owned child quarantined; reject cleanup without termination confirmation; kill and reap that child before explicit recovery cleanup.
5. Record service/release hashes, pinned identity, commands, exits, patch digest and remaining qualification limits. Make no model/provider calls or real consumption claims.

Live criteria added before the authorized provider run: use installed `@openai/codex-sdk@0.169.0`, existing SDK authentication and `gpt-6-luna` for one fresh repository task. Require actual tool events reading resource/source paths, a provider-run failing baseline and passing final test, independent host verification with unchanged tests, resource marker matches, retained patch, original-source preservation and cleanup after normal SDK process completion. Bound the turn to 110 seconds. Forced provider cancellation and resumed-session behavior remain separate, unqualified gates. Subsequent user steering selected the Codex SDK; the accepted live validation uses Codex only.

## Result

**Passed for installed preparation across all four plugins, deterministic child-process lifetime/recovery, and one real Codex SDK repository task.** The accepted consumer ran physically outside the checkout against the actual isolated Rust service and PostgreSQL 16. Its Acclimate SDK/plugin files were verified against release tarball bytes, and every public import resolved beneath the consumer's own `node_modules`. No local constructed `VerifiedBundle` substitutes for service retrieval in this acceptance.

The tested checkout is `63eb588458732fbba53c0969c9b892cf08a572fe`. Service binary SHA-256 is `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a`; release source inventory SHA-256 is `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b`. These identify the tested binary and release inputs; no binary-to-source build attestation is claimed. The public [machine-readable evidence](plugin-author.json) records package archive/content hashes, imported entrypoint hashes, commands, exits, identities and retained patch digests.

The accepted service-issued content-read credential resolved pinned version `f4461914-31b5-4717-8edf-9848c10c36bc`, digest `sha256:411da9cb1af81b219403575636c36a374c3eacdaaeec01bbd0f54e3074cc01c1`. The operator created this disposable fixture and reader credential through actual service APIs. No operator credential was passed to the consumer or coding task. Credential values and raw provider output remain private.

| Criterion | Observation | Verdict |
| --- | --- | --- |
| External installed release | 111 SDK/plugin files matched all five verified release archives; SDK, four plugin and Codex SDK entrypoints resolved within the external consumer | Passed |
| Existing repository task | All four plugin preparations ran an owned deterministic child reading resources/source; baseline exit 1, final test exit 0, child exit 0 | Passed; simulated provider |
| Native Codex execution | Actual Codex SDK thread read resources/source, ran failing test, wrote source, ran passing test; host independently confirmed final test and unchanged test file | Passed; real provider |
| Outputs before cleanup | Four deterministic patches and the real Codex patch/manifest remain after all successful native workspaces were removed | Passed |
| Existing guidance conflicts | `AGENTS.md`, nested case-variant `CLAUDE.md`, and a native hidden skill path rejected with `native.control_path` | Passed |
| Uniform memory selection | Each deterministic child saw only `memory/selected.md`; recursive workspace scan and effective context excluded the withheld canary. Selected-memory digest identical across all four plugins | Passed |
| Uncertain execution | A still-running owned deterministic child caused `ExecutionUncertainError`, retained workspace and false stopped/cleaned facts; unconfirmed cleanup rejected | Passed; simulated provider |
| Recovered cleanup | Owned child was killed with SIGKILL and reaped before an explicit termination callback allowed recovery cleanup | Passed; no real-provider cancellation claim |
| Original checkout and service cleanup | Original fixture source unchanged; successful/recovered workspace parent empty; owned service stopped and private PostgreSQL directory removed | Passed |

## Actual Codex SDK evidence

Installed `@openai/codex-sdk@0.169.0` used model `gpt-6-luna`, existing SDK authentication, `workspace-write`, approval `never`, disabled network/web search and a 110-second signal. SDK implementation SHA-256 is `340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4`; its installed native CLI binary SHA-256 is `739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002`. Both were inside the external consumer. Thread ID: `01a1e9da-fbdb-7551-9ca5-d90ffe0f43e1`.

Observed completed tool items were:

1. `item_6`, exit 0: `cat AGENTS.md .agents/skills/retry-review/SKILL.md .acclimate/memory/memory/selected.md src/retry.js tests/retry.test.mjs`.
2. `item_8`, exit 1: `node --test tests/retry.test.mjs`.
3. `item_9`, exit 0: wrote `src/retry.js` through a shell heredoc.
4. `item_11`, exit 0: `node --test tests/retry.test.mjs`.

The final response matched the instruction and skill random markers, whose values were absent from the prompt, and the selected memory text. These observations establish retrieval on this run. They do not establish a separate skill-discovery event. The SDK emitted command-execution items for the edit rather than a `file_change` item; the retained file bytes and independent test establish the actual change.

Host verification found unchanged tests, final test exit 0 and original source preservation. The retained native patch is 219 bytes, SHA-256 `5361282f51c440db403e50daed42a7d2239f73db95689168dd73d9ce7d3d447e`. The frozen source manifest digest is `3b8ba85fc011ae2bef147eea29bbdc9cd95fe4bca99fe6b4a84a1efe9997ea28`. The job recorded confirmed stop, retained results and completed cleanup. Normal stream exhaustion in the installed SDK awaits the Codex executable's exit; an abort/error would have left this helper's job uncertain rather than authorizing cleanup.

## Findings against the original persona review

The original existing-repository composition gap is now covered by the distributed native starter. Its explicit source inventory, private job workspace, selected-memory context, retained patch and durable recovery can be used by an installed consumer. The real Codex task makes this more than a file-staging demonstration. The common helper also preserved one memory policy across all four plugin preparations: selected-memory SHA-256 `d955feaad6129ea681d5b5de5174d5a7bce99ce2b82445e3bdbb3a90cd06ca21`.

Installation still has a concrete trap: the native starter archive contains no `package.json`. Our first in-checkout acceptance attempt let npm find an enclosing workspace and resolve repository packages. That run is excluded from accepted release-consumer proof, including its paid session. The fixture was corrected to create an application manifest, use explicit npm `--prefix`, verify import locations and compare installed files with tarball bytes. The full task was then repeated in an external directory. The starter should make that installation boundary explicit or ship a minimal manifest; otherwise an adopter can mistake workspace resolution for testing installed artifacts.

Ambient SDK configuration remains application-owned and visibly affects the task. The accepted run emitted five nonfatal configuration/marketplace warnings (two deprecated multi-agent-setting warnings, two ignored remote-connections-setting warnings and one marketplace-root warning). Its reported usage was 107,854 input tokens, 84,992 cached input tokens and 663 output tokens for this tiny task. This is a practical reason to make host settings part of the application's declared runtime policy. No token-cost estimate or unobserved provider-request count is inferred.

The paired evaluation/report journey and console harness-selection flow were not exercised by this persona script. This run does not prove behavioral improvement, Claude/Pi/Cursor provider consumption, resumed sessions, in-place reload or forced Codex cancellation/termination. All-four deterministic results remain explicitly distinct from the real Codex result. The qualification ledger correctly leaves those broader gates separate.

Reproduce with the existing verified release and service binary:

```sh
PYTHONPATH=. /Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  -m scripts.acceptance.dx_personas.plugin_author \
  --output /private/tmp/acclimate-plugin-persona-20261117 \
  --live-codex \
  --report docs/acceptance/developer-personas-20261117/plugin-author.json
```

The accepted private run is retained under `/private/tmp/acclimate-plugin-persona-20261117/plugin-author-bh9431dv`. It contains command stdout/stderr, SDK events, original/extracted fixture inputs, retained patches/manifests, job records and cleanup evidence. These private artifacts must not be published wholesale.
