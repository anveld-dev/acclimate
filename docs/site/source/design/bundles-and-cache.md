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

Versioned memory is ordinary approved content here. It isn't a portable native memory API, a live conversation store, or evidence that a fact remains current forever.

## Fetch and refresh

1. Resolve a bundle/channel under an authenticated project scope. The response names the channel revision, immutable version, and expected digest.
2. If the SDK already has verified bytes for that scoped version/digest, reuse them. Otherwise download the immutable payload.
3. Verify the digest and schema, then publish a complete cache entry by atomic rename from a temporary directory on the same filesystem.
4. Prepare a private workspace or native options for the job. Record the resolved version and digest with the app's job metadata.

Channel reads support conditional requests with an ETag. A `304` confirms the channel mapping is unchanged; it is not a new version. A rollback changes the channel revision even when it selects an older bundle.

<!-- diagram:cache-update -->

## Cache policy belongs to the caller

The helper accepts a maximum channel-resolution age and an explicit offline policy. The default requires a fresh resolution for a new job. An app may allow a bounded stale result or explicitly pin an already cached version for offline use.

| Situation | Behavior |
| --- | --- |
| Valid cached version; fresh mapping | Reuse verified bytes; avoid another payload download. |
| Download fails partway | Keep the previous valid entry. Never expose partial files. |
| Service unavailable | Use verified cached content only within the caller's offline/age policy; report its version, age, and stale status. Otherwise fail. |
| No usable cache | Return an explicit error. Don't invent empty instructions. |
| `401`/`403` or known revocation | Refuse new preparation. Do not turn denial into a stale-cache success. |
| Digest mismatch or incompatible schema | Reject the entry and report the problem. |

A refresh affects future preparations. Long-lived sessions change content only through an explicit app action supported by that native SDK. A service cannot recall bytes already copied to a host or used offline; applications needing strict freshness must contact it before starting.

## Safe materialization

Cache keys include service origin, authenticated scope, project, bundle, and digest. Keep private scopes separate even if their bytes match. Never cache access tokens in bundle files. Create cache entries, temporary download directories, and prepared files with owner-restricted access from the first write (for example, `0700` directories and `0600` files on POSIX, or equivalent private ACLs). Shared access requires explicit app policy; a broad default umask is not sufficient.

Treat file paths as data: reject absolute paths, traversal, duplicates/case collisions, symlinks, and writes outside the chosen root. Use bounded file counts and byte limits. The app chooses the destination; a bundle cannot pick a host path or change tool grants.

Keep cached payloads immutable. Prepare job-local copies or native inputs rather than letting the agent modify the shared cache. Evict by a bounded local size/age policy without deleting files an active preparation needs. No cache daemon or cross-machine shared-cache protocol is required.

The plugin must not silently overwrite an existing `AGENTS.md`, rules file, or skill. Use a private prepared workspace, or require the application's explicit merge/collision policy.

**Next:** [SDKs and plugins](sdk-and-plugins.md).
