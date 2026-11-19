# Publish an Acclimate release

1. Set the same `MAJOR.MINOR.PATCH` version in the root and console `package.json` files, the SDK and plugin manifests under `packages/`, `python/pyproject.toml`, and `Cargo.toml`. Update any inter-package version references and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts` and `Cargo.lock` with `cargo update --workspace`.
2. Update `CHANGELOG.md` with a section headed `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`. Run `npm run pack:verify` and commit the refreshed `scripts/packaging/release-metadata.json` along with the version and changelog changes.
3. From the release commit on `main`, create and push the matching tag, for example `git tag -a v0.1.0 -m "Release 0.1.0"` followed by `git push origin v0.1.0`.

The release workflow checks the tag against the package versions and runs `npm run pack:verify`. It publishes `ghcr.io/anveld-dev/acclimate-service` and `ghcr.io/anveld-dev/acclimate-console` for Linux amd64 and arm64, with the version tag (for example, `0.1.0`) and `latest`. Each image includes BuildKit provenance and SBOM attestations.

After both images build and push, the workflow creates a GitHub Release with the verified tarballs, wheel, manifest and checksums. It uses the matching changelog section when available and GitHub-generated notes otherwise. SDK and plugin distributions are available as Release assets without publication to npm or PyPI.

After the first release, set both GHCR packages to **Public** in their package settings so self-hosters can pull anonymously. GitHub creates new GHCR packages with private visibility by default. [GitHub Container Registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)

## Dry-run the workflow

In GitHub Actions, select **release**, choose a branch or a matching release tag, and leave **Build and verify without publishing** selected. You can also run `gh workflow run release.yaml --ref main -f dry-run=true`. The run builds both architectures and retains the verified SDK artifacts in Actions without pushing images or creating a GitHub Release. A manual run with the box cleared requires the matching release tag.
