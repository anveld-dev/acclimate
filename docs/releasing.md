# Publish an Acclimate release

1. Set the same `MAJOR.MINOR.PATCH` version in the root and console `package.json` files, the SDK and plugin manifests under `packages/`, `python/pyproject.toml`, and `Cargo.toml`. Update any inter-package version references and refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts` and `Cargo.lock` with `cargo update --workspace`.
2. Update `CHANGELOG.md` with a section headed `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`. Run `npm run pack:verify` and commit the refreshed `scripts/packaging/release-metadata.json` along with the version and changelog changes.
3. From the release commit on `main`, create and push the matching tag, for example `git tag -a v0.1.0 -m "Release 0.1.0"` followed by `git push origin v0.1.0`.

The release workflow checks the tag against the package versions and runs `npm run pack:verify`. It builds each image on native amd64 and arm64 runners, then tags one multi-arch image for each of `ghcr.io/anveld-dev/acclimate-service` and `ghcr.io/anveld-dev/acclimate-console` with the version (for example, `0.1.0`) and `latest`. Each platform image includes BuildKit provenance and SBOM attestations. The arm64 jobs use GitHub's `ubuntu-24.04-arm` hosted runners.

After both images build and push, the workflow creates a GitHub Release with the verified tarballs, wheel, manifest and checksums. It uses the matching changelog section when available and GitHub-generated notes otherwise. The tag run does not publish to npm or PyPI. Registry publication is a separate, approved step.

After the first release, set both GHCR packages to **Public** in their package settings so self-hosters can pull anonymously. GitHub creates new GHCR packages with private visibility by default. [GitHub Container Registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)

## Dry-run the workflow

In GitHub Actions, select **release**, choose a branch or a matching release tag, and leave **Build and verify without publishing** selected. You can also run `gh workflow run release.yaml --ref main -f dry-run=true`. The run builds both architectures and retains the verified SDK artifacts in Actions without pushing images or creating a GitHub Release. A manual run with the box cleared requires the matching release tag. GitHub only offers **Run workflow** once `release.yaml` is on the default branch, so the first dry run happens after this workflow merges to `main`.

## Publish to npm and PyPI

After the GitHub Release exists, publish the same verified packages to the registries:

```sh
gh workflow run release.yaml --ref v0.1.0 -f dry-run=false -f publish-registries=true
```

This run rebuilds and verifies the release artifacts, checks them against `SHA256SUMS`, and then publishes. It doesn't rebuild images or touch the GitHub Release. The `npm` job publishes `@acclimate/sdk` first and then the four plugins, each with an npm provenance statement. The `pypi` job uploads the `acclimate-sdk` wheel with PEP 740 attestations. Versions that already exist are skipped, so a rerun finishes whatever an earlier run left.

Nothing publishes without approval. Each job runs in a GitHub environment, `npm` or `pypi`. Before the first registry release, configure both:

1. In **Settings → Environments**, create `npm` and `pypi`, add the release maintainers as required reviewers, and limit deployments to `v*.*.*` tags.
2. On PyPI, add a trusted publisher for the `acclimate-sdk` project: owner `anveld-dev`, repository `acclimate`, workflow `release.yaml`, environment `pypi`. For a project that doesn't exist yet, add it as a pending publisher. PyPI then needs no stored token.
3. On npm, the first publication of each `@acclimate` package needs a token. Store an automation token as the `NPM_TOKEN` secret of the `npm` environment. After the first release, add a trusted publisher to each package (repository `anveld-dev/acclimate`, workflow `release.yaml`, environment `npm`) and delete the secret.

npm provenance requires each package's `repository.url` to match this repository, so every published `package.json` declares it.
