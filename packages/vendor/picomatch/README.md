# picomatch security backports

The console build uses picomatch 4.x through Vite and TanStack, and 2.x through micromatch. Both locked releases are affected by [CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). These temporary packages apply the parser change proposed in [upstream PR 262 for 4.x](https://github.com/micromatch/picomatch/pull/262) and [PR 263 for 2.x](https://github.com/micromatch/picomatch/pull/263) to the respective npm release. Each archive retains the upstream license. The version suffix identifies the Acclimate build.

Run `bash packages/vendor/picomatch/rebuild.sh` with Node 22 and npm 10 to reproduce the archives. The script verifies the original npm tarball digest and applies only the parser diff between the pinned Git commits. The root lockfile records each resulting archive's integrity so a clean installation can verify it with lifecycle scripts disabled.

When upstream publishes fixed releases for both dependency paths, remove the overrides and this directory, refresh the lockfile, and verify `npm ls picomatch --all` and `npm audit --audit-level=high`.
