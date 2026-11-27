# Publish an Acclimate release

1. Set the same `MAJOR.MINOR.PATCH` version in the root and console `package.json` files, the SDK and plugin manifests under `packages/`, `python/pyproject.toml`, and `Cargo.toml`. Update any inter-package version references and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts` and `Cargo.lock` with `cargo update --workspace`.
2. Update `CHANGELOG.md` with a section headed `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`. Run `npm run pack:verify` and commit the refreshed `scripts/packaging/release-metadata.json` along with the version and changelog changes.
3. From the release commit on `main`, create and push the matching tag, for example `git tag -a v0.1.0 -m "Release 0.1.0"` followed by `git push origin v0.1.0`.

The release workflow checks the tag against the package versions and runs `npm run pack:verify`. It builds each image on native amd64 and arm64 runners, then tags one multi-arch image for each of `ghcr.io/anveld-dev/acclimate-service` and `ghcr.io/anveld-dev/acclimate-console` with the version (for example, `0.1.0`) and `latest`. Each platform image includes BuildKit provenance and SBOM attestations. The arm64 jobs use GitHub's `ubuntu-24.04-arm` hosted runners.

`compose.yaml` names these images with `${ACCLIMATE_VERSION:-local}`, so it needs no change for a release. Without a version, Compose builds and tags `local` images from the checkout, which can never be mistaken for a published release. A self-hoster pins a release with `deploy/init.sh --version 0.1.0` or `ACCLIMATE_VERSION=0.1.0` in `.env`.

After the four images (service, console, executor and runner) build and push, the workflow creates a GitHub Release with the verified tarballs, wheel, manifest and checksums. It uses the matching changelog section when available and GitHub-generated notes otherwise. Once the release is ready, the workflow requests approval to publish the same artifacts to npm and PyPI.

After the first release, set the four GHCR packages to **Public** in their package settings so self-hosters can pull anonymously. GitHub creates new GHCR packages with private visibility by default. [GitHub Container Registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)

## Dry-run the workflow

In GitHub Actions, select **release**, choose a branch or a matching release tag, and leave **Build and verify without publishing** selected. You can also run `gh workflow run release.yaml --ref main -f dry-run=true`. The run builds both architectures and retains the verified SDK artifacts in Actions without pushing images or creating a GitHub Release. A manual run with the box cleared requires the matching release tag. GitHub only offers **Run workflow** once `release.yaml` is on the default branch, so the first dry run happens after this workflow merges to `main`.

## Publish to npm and PyPI

For an existing release tag or a registry-only retry, dispatch the workflow on that tag:

```sh
gh workflow run release.yaml --ref v0.2.0 -f dry-run=false -f publish-registries=true
```

The registry-only run rebuilds the package artifacts and checks them against `SHA256SUMS`. The `npm` job publishes `@anveld/sdk` first and then the four plugins, each with an npm provenance statement. A retry skips npm versions whose recorded integrity matches the tarball and fails if the integrity differs. The `pypi` job uploads the `acclimate-sdk` wheel with PEP 740 attestations and skips an existing upload.

Nothing publishes without approval. Each job runs in a GitHub environment, `npm` or `pypi`. Before the first registry release, configure both:

1. In **Settings → Environments**, create `npm` and `pypi`, add the release maintainers as required reviewers, and limit deployments to `v*.*.*` tags.
2. On PyPI, add a trusted publisher for the `acclimate-sdk` project: owner `anveld-dev`, repository `acclimate`, workflow `release.yaml`, environment `pypi`. For a project that doesn't exist yet, add it as a pending publisher. PyPI then needs no stored token.
3. On npm, the first publication from CI of each `@anveld` package needs a granular write token authorized for the scope. The token needs bypass 2FA for direct publication. Store it as the `NPM_TOKEN` secret of the `npm` environment for the bootstrap run. After the first release, add a trusted publisher to each package (repository `anveld-dev/acclimate`, workflow `release.yaml`, environment `npm`) with direct publishing allowed. Delete the secret and revoke the bootstrap token.

npm provenance requires each published `package.json` to declare a `repository.url` that matches this repository.
