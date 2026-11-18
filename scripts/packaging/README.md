# Distribution and installed developer-experience checks

`npm run build:packages` regenerates public `release-metadata.json`, compiles package sources and checks every relative runtime/declaration import stays inside its installed package. SDK delivery/validation imports remain separate from Node-only evaluator exports. Metadata names exact manifest-derived tarballs, the wheel, three starter archives, runtime/storage requirements, capability features and optional native peer versions. It contains no download URL or invented checksum.

`npm run pack:verify -- --output /absolute/new-release` creates actual SDK/plugin tarballs, installs them offline into an external app, typechecks public declarations and an application-owned TypeScript adapter, verifies the installed evaluator entry points and native plugin imports. It then checks native option/loader helpers with the lockfile-resolved peers, builds and installs an isolated Python wheel, and exercises the Python evaluator/CLI/policy/artifact imports, descriptor and asynchronous lifetime tests.

The output also includes evaluation, CI and native-repository archives. Their extracted consumers are checked separately from checkout sources. Starter archives use sorted reviewed inventories with fixed modes, timestamps and ownership; repeated identical sources produce identical archive bytes. Wheel builds use a fixed `SOURCE_DATE_EPOCH` to exclude build time from ZIP metadata. The final manifest records checks that actually ran, exact artifact byte counts/SHA256 hashes, runtime versions and explicit unrun external/live gates. `SHA256SUMS` covers tarballs, wheel, archives and public metadata. An existing output is refused; use a fresh path. Registry publication is not performed.

Native/model-free checks establish preparation, source/context handling, retention and wiring. They do not qualify native model consumption, provider termination, behavioral improvement of a real agent, in-place reload or public deployment.

## Full headless installed-app path

With PostgreSQL 16 tools available, run:

```sh
npm run qualify:dx -- --pg-bin /absolute/postgresql/bin --python /absolute/python3.11 --output /absolute/private/new-dx-report.json
```

The command builds packages/service, creates a fresh verified release, then installs its SDK tarball and wheel into fresh external JS and Python applications. Those applications supply their own adapters and cases and invoke the installed CLIs directly. The packaging check separately exercises the extracted starter entry points. Qualification provisions a disposable PostgreSQL cluster and real Rust service using generated fixture identities, never an ambient database or user credentials.

For both languages it checks describe → nonexecuting doctor → immutable headless candidate/request creation → paired execution → explicit policy pass/fail/invalid categories → selected output/explanation export → independent read-only verification. Creation retry after expiring the transient 24-hour cache preserves the original request; terminal rerun preserves comparison identity. Export canaries exclude generated credentials/private roots. Each language verifies the other's exported projection against the independent trusted service/request.

`--release /existing/verified-release` reuses a release after checking its complete declared inventory, hashes, source inventory and `SHA256SUMS`. `pack:verify --skip-build` requires the source/output receipt from `build:packages` to match current package inputs and compiled files. Package compilation clears previous package emission trees so deleted source files cannot survive in a release. Qualification's service executable is built separately; the report identifies its exact binary digest and makes no claim that the release source hash attests that binary. `qualify:dx --skip-build` therefore remains appropriate only when the caller has built the service to qualify. Python optimization (`-O`/`PYTHONOPTIMIZE`) is rejected because it would disable assertion-based checks. Reports state the scope precisely and do not claim all G01–G22 gates or live-provider readiness. Keep the report alongside the release manifest and the root implementation acceptance ledger.

Archive privacy/path checks can also run without a build:

```sh
node --test scripts/packaging/*.test.mjs
python3.11 -m unittest discover -s scripts/packaging -p 'test_*.py' -v
```

The tests refuse source symlinks, private dotenv/evaluator/journal/key files, unlisted local files and escaping artifact filenames. `starter-files.json` is the reviewed source inventory: adding or removing public starter files requires updating it. The exporter omits caches/dependencies and never archives a worker journal or prepared job. This is fail-closed filename/path handling, not automatic detection of arbitrary secret text inside a reviewed public source file. Additional fixture tests cover stale build receipts, obsolete emitted modules, CI failure exit categories and qualification integrity.
