# Fresh-release developer persona retest

Prepared infrastructure; acceptance is pending actual execution. Prior evidence in
`docs/acceptance/developer-personas-20261117` remains historical. Fresh reports belong
in `docs/acceptance/developer-personas-gap-closure-20261117` and must identify the
new release, inventory fingerprint, manifest/checksum hashes, tested service binary,
consumer proof, commands, results, cleanup, and remaining limits.

The planned release is `/private/tmp/acclimate-dx-release-20261117-gaps-1`.
After the final package build, freeze its manifest and independently record its
SOURCE.json fingerprint. Invoke all seven persona drivers with:

```sh
export ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1
export ACCLIMATE_PERSONA_SOURCE_SHA256='<final verified SOURCE.json sha256>'
```

The fixture reads these selectors before stripping ambient application configuration.
An explicit `release=` / `source_sha256=` takes precedence. Omitting selectors uses
the old review release intentionally for historical reproduction and helper smoke
checks; that run is not fresh-release acceptance. Drivers with hardcoded report
locations must be redirected before rerun so historical files remain intact.

All seven persona results are required: first adopter, TypeScript integrator, Python
integrator, plugin author, platform engineer, evaluation researcher, and CI release
engineer. The console/custom-app scenario supplements the first adopter. Persona
owners modify their own drivers; changing a driver or passing a source unit test
does not accept a persona. Run against private disposable PostgreSQL and the real
service, with physical consumer apps outside the checkout, own package manifests,
explicit npm prefix and workspaces disabled. Verify every installed SDK/plugin
archive file and isolated Python wheel contents; retain proofs privately. Never
use ambient databases or put API keys in process arguments. Only the authorized
live Codex SDK receives its explicit SDK environment/authentication.

| Remaining criterion | Implementation owner / evidence owner | Required fresh evidence | Status |
| --- | --- | --- | --- |
| Actionable doctor diagnostics | Doctor implementation agent / first adopter, platform engineer | Installed JS and Python diagnostics explain missing runtime, invalid config, unavailable service and permissions; remediation is usable | Pending rerun |
| Python package-root typing | Python typing owner / Python integrator | Strict checker runs against installed wheel using documented root imports, including public exceptions and adapter types; retain command/version/output | Pending rerun |
| Equal weighting by case in console | UI owner / console custom app, researcher | Unequal repetition fixture displays same per-case aggregate, missing/failed pairing and direction as SDK analysis | Pending rerun |
| Native starter own manifest and install boundary | Starter owner / plugin author, first adopter | Distributed starter owns package.json; offline npm prefix/workspaces=false; all four release plugins and SDK resolve within external app with byte proof | Pending rerun |
| Public analysis and manifest exports | SDK analysis owner / TypeScript integrator, researcher, Python integrator | Installed consumers import public entrypoints; analyze unequal repetitions, failures/missing pairs, directions, and valid/invalid manifests | Pending rerun |
| Build/release provenance | Root qualification owner / every persona | Fresh manifest and checksums, final source inventory, actual service hash and recorded source-to-build receipt are consistent; console output identity recorded separately | Pending rerun |
| Remote progress from independent client | Remote-progress owner / platform engineer, CI release engineer | Another client observes actual persisted running/completed progress and retry behavior against same isolated service without trusting local runner state | Pending rerun |
| Seven complete persona journeys | Each persona owner / root report owner | New release selected explicitly; all seven pass their declared criteria with safe evidence and cleanup; remaining limitations stated | Pending rerun |
| Physical second-machine verification | Root qualification owner | Same frozen artifacts/checksums transferred to separate machine and independently installed/verified; record platform, commands, output, and actual execution | Unqualified; no execution yet |

The fixture records and rechecks the binary hash, but this alone does not attest its
source build. Keep `binarySourceBuildAttested: false` until root qualification can
bind an actual recorded build to the selected source and binary. Release source
inventory also does not cover console output; use its separate build evidence.
There is no signing or publication claim in this retest preparation.

One read-only T3 environment discovery on 2026-11-17 found linked `desktop`
environment `57cfa54b-adaf-4363-bbb7-a16925f73dc7` reachable (link expires
2026-12-15T17:03:42.481Z). No remote execution, mutation, new thread, or delegation
was performed. Availability is an opportunity for root qualification, not evidence
of a cross-machine result.

If physical cross-machine execution is unavailable, an explicitly labeled isolated
container review can still check portability: copy only the frozen release and
SHA256SUMS into an empty supported Node/Python image; verify checksums there; create
an owner-only external app with its own manifest; install tarballs offline with
prefix/workspaces=false and wheel with no-index/no-deps; verify resolution and all
package bytes, then run deterministic import/descriptor/fake-adapter smoke checks.
Use an isolated service/database only if supplied as part of that disposable
recipe. Record image digest and all exact runtime versions. This is container
portability evidence and must never be reported as a physical second machine or
live provider qualification.

Infrastructure smoke on 2026-11-17 used the historical review release only:
five installed npm package inventories (SDK and all four plugins) and 16 static
wheel files passed byte verification, including isolated Python import resolution.
Explicit arguments overrode conflicting selector environment values; selectors
were stripped from consumer environments; a missing npm prefix and an unexpected
SDK file were rejected. Apps lived physically outside the checkout. No service
startup, package build, or model call was involved. This validates the helper,
and does not satisfy any pending fresh-release persona row above.
