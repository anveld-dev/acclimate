# Bundles and local cache

[Design guide](README.md)

The app asks for one bundle version before starting a job. The SDK makes that complete version available locally and reports exactly what was used.

## A small bundle

```text
reviewer/
  instructions/review.md
  skills/retry-review/SKILL.md
  memory/project-notes.md
```

Each entry has a relative path, a kind (`instruction`, `skill`, or `memory`), and UTF-8 text. Supporting text references are allowed; executable assets and arbitrary binary packages are outside v1. Native skill metadata, such as a name and description, remains part of the skill file.

A version record has an ID, parent version, creator, and SHA-256 digest. The digest covers the exact immutable JSON payload bytes stored by the service. The SDK verifies downloaded bytes before parsing; it doesn't hash a differently serialized copy.

Memory files in the bundle are versioned alongside instructions and skills. The learning loop stores its improvement memory separately.

## Fetch and refresh

1. Resolve a bundle/channel under an authenticated workspace. The response names the channel revision, immutable version, and expected digest.
2. If the SDK already has verified bytes for that scoped version/digest, reuse them. Otherwise download the immutable payload.
3. Verify the digest and schema, then publish a complete cache entry by atomic rename from a temporary directory on the same filesystem.
4. Prepare a private workspace or native options for the job. Record the resolved version and digest with the app's job metadata.

Channel reads support conditional requests with an ETag. A `304` confirms the channel mapping is unchanged; it is not a new version. A rollback changes the channel revision even when it selects an older bundle.

<!-- diagram:cache-update -->

## Cache policy belongs to the caller

New jobs resolve the channel online. To permit offline fallback for a previously prepared job, request the exact version ID and explicitly allow that same pinned version in the offline policy. The SDK can reuse the verified cache entry when the request fails with a transport error or HTTP 503.

| Situation | Behavior |
| --- | --- |
| Valid cached version and current mapping | Reuse verified bytes; avoid another payload download. |
| Download fails partway | Keep the previous valid entry. Never expose partial files. |
| Service unavailable | Reuse verified cached content for an explicitly allowed pinned version. Channel resolution fails. |
| No usable cache | Return a cache miss when offline. |
| `401`/`403` or known revocation | Return the authorization error. |
| Digest mismatch or incompatible schema | Reject the entry and report the problem. |

A refresh affects future preparations. Long-lived sessions change content only through an explicit app action supported by that native SDK. A service cannot recall bytes already copied to a host or used offline; applications needing strict freshness must contact it before starting.

## Safe materialization

Cache keys include service origin, authenticated scope, workspace, bundle, and digest. Keep private scopes separate even if their bytes match. Never cache access tokens in bundle files. Create cache entries, temporary download directories, and prepared files with owner-restricted access from the first write (for example, `0700` directories and `0600` files on POSIX, or equivalent private ACLs). Shared access requires explicit app policy; a broad default umask is not sufficient.

Treat file paths as data: reject absolute paths, traversal, duplicates/case collisions, symlinks, and writes outside the chosen root. Use bounded file counts and byte limits. The app chooses the destination; a bundle cannot pick a host path or change tool grants.

Keep cached payloads immutable. Prepare job-local copies or native inputs rather than letting the agent modify the shared cache. Set a local cache size limit for retained payloads. Active jobs keep their prepared files in their job directories.

The plugin must not silently overwrite an existing `AGENTS.md`, rules file, or skill. Use a private prepared workspace, or require the application's explicit merge/collision policy.

**Next:** [SDKs and plugins](sdk-and-plugins.md).
