# Installed package checks

Run `npm run pack:verify` to build the SDK and plugin tarballs, install them into an external app, typecheck a consumer and exercise native preparation. The same check builds a Python wheel, verifies delivery in an isolated environment and packages the native repository starter. Find the release manifest, source fingerprint and SHA256SUMS beside the artifacts in `artifacts/releases/<version>/`. To repeat the check use `-- --output /absolute/new-directory`.
