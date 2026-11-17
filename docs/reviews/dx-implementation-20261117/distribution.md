# Distribution implementation review — 2026-11-17

Reviewed the implementation relative to HEAD `52c1ce1`, against frozen D2 `docs/design/developer-experience-council/PLAN.md`, especially §§11–14 and G17/G19/G20. Scope: `scripts/build-packages.mjs`, `scripts/packaging/**`, `examples/evaluation-starter/**`, `examples/ci/**`. Root coordinates manifests and shared builds; after all product edits froze, root explicitly authorized this reviewer as the sole final package builder and installed-release qualification owner. The native reviewer owns native starter source. No previous retained release was mutated; no model execution, deployment, publication or commit occurred.

## Confirmed findings and repairs

1. **P2 — successful CI concealed failed review exports.** `ci.sh` ignored the false branch of `export`; successful `run`/`check` followed by failed required export exited zero. Conversely, `set -e` during `verify-export` could overwrite an existing run/check category. Reproduce with a command stub returning `run=0`, `check=0`, `export=1`; the original final exit used only check status. The shell now records both export and verification failures, preserves a prior run failure first and quality category second, and otherwise fails on export/verification. A missing flag value also receives a bounded explicit diagnostic. Fifteen shell-entrypoint regressions cover JavaScript/Python dispatch, success, failed request, run/check/export/verification categories and malformed arguments; they execute no evaluator or provider.

2. **P2 — archive filters admitted unreviewed local files.** The prior implementation recursively copied any ordinary non-dot file not on a small denylist, despite describing its input as checked-in source. For example, a local `provider-credentials.json` would have shipped. `starter-files.json` now freezes the reviewed public file inventory for all three starter trees. Unexpected files fail closed, known cache/dependency trees remain omitted, and existing symlink/private-name checks remain. The native reviewer confirmed the native filename set is unchanged. Regression injects an unlisted credential fixture and verifies refusal. This does not inspect or automatically redact secrets inside a reviewed public source file.

3. **P2 — starter bytes depended on temporary filesystem metadata.** Native `tar -czf` retained current directory/package-rewrite timestamps and host metadata. Identical source could produce different tarball hashes. The archive writer now emits sorted USTAR entries with fixed timestamp/ownership/modes and a timestamp-free gzip envelope. Regression changes source timestamps and output location and compares all three archive byte streams. Real current source archives were generated in disposable directories and successfully listed by system tar: evaluation 22 entries, CI 25, native repository 20. Wheel ZIP timestamps are also fixed by supplying `SOURCE_DATE_EPOCH=315532800` only to its build subprocess. A second independent wheel build/install produced byte-identical output, hash recorded below. Release manifests intentionally retain actual creation/runtime evidence and are not claimed byte-identical.

4. **P2 — fresh source hashes could describe stale compiled packages.** `pack:verify --skip-build` previously hashed current source but packed whatever existing `packages/*/dist` contained. TypeScript also leaves emitted files after their sources are removed; copying them into a cleaned package dist would retain obsolete modules. `build-packages.mjs` now owns the compiler invocation, clears only the five package emission source trees, brackets compilation/copying with an input digest, and writes an input/output build receipt. The coordinator updated the root build command accordingly. Packaging validates this receipt before packing and before committing output, including with `--skip-build`. Missing receipts, changed source and changed compiled output are refused. Fixture tests verify all three refusals, source mutation during build, obsolete-module removal and preservation of unrelated shared output. The receipt is a local consistency check, not signed build provenance.

5. **P2 — Python optimization disabled qualification assertions.** Both qualification scripts used `assert` to decide whether checks passed, while `-O` or inherited `PYTHONOPTIMIZE` could remove those checks. Both now reject optimized execution before doing work. Regression invokes each with `-O --help` and confirms failure. This preserves the existing assertion-based qualification checks rather than silently bypassing them.

6. **P2 — qualification source/evidence claims exceeded validated inputs.** Qualification checked hashes listed in `manifest.artifacts` but did not require every referenced starter/package/SOURCE to be hashed, validate the SOURCE digest claim, compare `SHA256SUMS`, or reject artifact symlinks. It seeded the service with a baseline read from the current checkout while evaluating an archived release. It also reported a release source fingerprint alongside a separately built service without explicitly separating their identities. Qualification now checks the complete declared artifact inventory, source-inventory digest, checksum file and regular-file boundaries; reads the baseline from the verified distributed starter; identifies and rechecks the actual service executable digest; and explicitly states that release source metadata does not attest that binary's source. Four Python integrity tests cover omitted coverage, mismatched source claims, checksum mismatch, artifact symlinks and optimization. Source fingerprint inputs additionally cover the imported qualification harness/environment helper and npm's automatically packaged Cursor README.

## Executed validation

- Node `v26.13.1`: `node --test scripts/packaging/*.test.mjs` — **28 passed**.
- Python `/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11`: `-m unittest discover -s scripts/packaging -p 'test_*.py' -v` — **4 passed**.
- Same Python, `PYTHONPATH=python`, `-m unittest discover -s examples/evaluation-starter/test -v` — **2 passed**, including two caller cancellations while a real worker file/kernel lock remains held until quiescence. No async-wrapper defect was found; its existing behavior matches D2.
- `node --check` on build/verify/archive scripts and `sh -n examples/ci/ci.sh` — passed.
- Real reviewed source archive creation/system-tar listing — passed, disposable outputs removed.

## Final installed-release evidence

After the coordinator froze product/source changes, all of the following completed successfully:

- `npm run build:packages` — clean package emissions, compiler, import closure and receipt creation. Log: `artifacts/dx-review-20261117/package-build.log`.
- Explicit Python 3.11.7, `npm run pack:verify -- --skip-build --output /private/tmp/acclimate-dx-release-20261117-review-1` — receipt verification; external SDK/plugin offline installs; public declarations; optional peers; compiled TypeScript starter; isolated wheel imports/trial/descriptor/async tests; extracted JS/CI/native archives and all four fake native harnesses. Log: `artifacts/dx-review-20261117/pack-verify.log`.
- `cargo build --bin acclimate-service` — fresh service executable. Log: `artifacts/dx-review-20261117/cargo-build.log`.
- Python 3.11.7 `scripts/packaging/qualify_dx.py --pg-bin /opt/homebrew/opt/postgresql@16/bin --release /private/tmp/acclimate-dx-release-20261117-review-1 --output /private/tmp/acclimate-dx-qualification-20261117-review-1.json` — **passed against PostgreSQL 16.15**. Actual installed JavaScript and Python consumers each passed trial/describe/doctor, headless immutable request creation, dropped committed draft/request/start/submit/finish responses with expired transient caches, paired run, policy pass/fail/invalid categories, terminal replay, selected review exports, independent read-only and cross-language verification, secret canaries, same-principal grant overlap/revocation, actual archived CI entrypoint in both languages, and downloaded review verification after all fixture worker journals were removed. Log: `artifacts/dx-review-20261117/installed-qualification.log`.
- A second isolated wheel build/install with the fixed epoch matched the retained wheel bytes. Log: `artifacts/dx-review-20261117/wheel-reproducibility.log`.

Final source fingerprint was recomputed after qualification and matched all **152** recorded source inputs. Identifiers:

| Evidence | SHA-256 |
| --- | --- |
| Release source inventory fingerprint | `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b` |
| Release `manifest.json` bytes | `559c1dfe4e47158af21178742d0715500e6616b182ee89be1caf5ca844675153` |
| Release `SOURCE.json` bytes | `85c33470c04914e7e170f2c552b056b5ff391f686ebcca283ebd6370d5cd9038` |
| Release `SHA256SUMS` bytes | `a7163b99cd420ac3fa0bc965da85b10298c756bc75a980dd0fbce91f4e490a72` |
| Installed qualification report bytes | `1310b9bb7f5939fc1afe9b4cff2b34d8ed2994df38f460ad1ef02a0a57f55bc2` |
| Qualified service executable bytes | `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a` |
| Retained/reproduced wheel bytes | `1597fab5a5b18b9fed33a56777165843a0c1c7b1a499c1a52ee8e231f0a7fae1` |

## Limits

No unresolved confirmed defect remains in the owned scope. Prior retained release/report evidence is historical only; `/private/tmp/acclimate-dx-release-20261116-final` was not mutated. The new report qualifies the focused installed headless path and fresh CLI/service process recovery on fixed local physical journal roots; it does not claim every G01–G22 gate. Source inventories require deliberate maintenance when adding/removing starter files. No live/native-quality, container recovery, arbitrary-secret-detection or signed service-source provenance claim is made.
