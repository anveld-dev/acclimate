# Native starter installation and Codex runtime policy

Implemented on 2026-11-17 against checkout `63eb588458732fbba53c0969c9b892cf08a572fe`, with the findings in `docs/acceptance/developer-personas-20261117/plugin-author.md` as the acceptance gap. This implementation makes no new provider/session qualification claim.

The native archive previously had no application manifest. An npm invocation inside a nested checkout could ascend into the enclosing workspace and make checkout imports look like installed release imports. The starter now includes a private ESM `package.json`, Node >=22.22.0/npm >=10 requirements and no dependencies or peers that npm could implicitly resolve. Its README installs already obtained, matching SDK/plugin tarballs with explicit absolute `--prefix`, `--workspaces=false`, `--offline`, `--ignore-scripts` and exact saved references. The package's local manifest and lockfile change; the enclosing application's do not.

`verify-install.mjs` checks each SDK/plugin public entrypoint's physical path before importing it. Every entrypoint must reside beneath this starter's own `node_modules`; checkout symlinks and enclosing installations fail. It verifies package identities and a shared Acclimate release version. Optional `--codex-sdk` additionally requires exactly `@openai/codex-sdk@0.169.0`. This is an import/location check, not archive-byte attestation. Consumers must retain their independently verified release checksums, SDK/native artifact provenance and installation lockfile. The explicit file inventory in `scripts/packaging/starter-files.json` now includes the manifest, verifier and offline runtime-policy test.

`harnesses.mjs` now exports `codexRuntimeInputs(effectiveContext, { env, model, config, configOverrides })`. It rejects missing environment/model declarations, copies supplied constructor options, and selects a fresh workspace-write thread with approval `never`, disabled network and disabled web search. It does not import the optional provider SDK, construct a client, start a process or call a provider. Its default fixture remains deterministic. SDK authentication, authorization, model access, execution limits, confirmed stop and durable quarantine remain the application adapter's responsibility.

The runtime controls were checked against the existing official installed SDK 0.169.0 README, public declarations and implementation, without any model call. The README documents replacement child `env`, structured `config` and raw `configOverrides`; the implementation applies raw config after structured config, then SDK/thread options, and injects SDK-required environment values. Source SHA-256 values are:

| Installed official SDK file | SHA-256 |
| --- | --- |
| `README.md` | `bc454b26a6920efb1826912be6b6ba96348ab39d9f4e70078465deb586dbbfe7` |
| `dist/index.d.ts` | `5b57ce417b5f6e608c8e52707761384be220ff27e0206e93e4c253e83f206a8f` |
| `dist/index.js` | `340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4` |

The README requires a declared runtime revision containing nonsecret configuration provenance, selected environment names, SDK/native hashes, permission/model/tool choices, warnings and reported usage. It describes an application-owned Codex home supplied through explicit `env` as an available configuration policy and requires deliberate authentication provisioning. It does not claim that this suppresses every CLI/system/project configuration source. Full host-configuration isolation remains unproven. The prior accepted run's five setting/marketplace warnings and reported 107,854 input / 84,992 cached input / 663 output tokens remain recorded as historical observations, with no inferred cost or request count.

Validation used Node v26.13.1 and npm 12.2.2 on macOS. Commands and results:

```sh
ACCLIMATE_NATIVE_RELEASE_ROOT=/private/tmp/acclimate-dx-release-20261117-review-1 \
  node --test scripts/packaging/native-starter-install.test.mjs \
  scripts/packaging/starter-artifacts.test.mjs \
  examples/native-repository/test/codex-policy.test.mjs
# 15 passed; 0 failed; 0 skipped

node --test examples/native-repository/test/*.test.mjs
# 23 passed; 0 failed; 0 skipped

ACCLIMATE_NATIVE_RELEASE_ROOT=/private/tmp/acclimate-dx-release-20261117-review-1 \
  node --test scripts/packaging/native-starter-install.test.mjs
# 3 passed; 0 failed; 0 skipped (final verifier revision)
```

The installation regression archives the current native starter into a disposable temporary directory and installs actual existing release SDK plus all four plugin tarballs after checking each archive against `SHA256SUMS`. It tests external extraction and extraction beneath an enclosing npm `packages/*` workspace, invokes npm from outside the consumer with the explicit prefix, resolves/imports five public packages, and executes a successful deterministic Codex repository job. It asserts byte-identical enclosing manifest/lockfile and unchanged enclosing `node_modules`, and rejects a deliberately symlinked checkout plugin. Temporary test archives/workspaces are removed. Without `ACCLIMATE_NATIVE_RELEASE_ROOT`, the two actual-release cases are explicitly skipped rather than silently substituted with checkout packages.

These checks reuse the release at `/private/tmp/acclimate-dx-release-20261117-review-1`, source inventory `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b`. They do not represent a fresh release qualification of the changed source. No shared build, `dist` mutation, commit, push, deployment or provider call was performed for this implementation. The updated source is ready to freeze before the parent task builds and retests a fresh release. Live Codex consumption, forced cancellation and resumed sessions remain separately evidenced gates.
