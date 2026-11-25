# Service interface

Workspace-scoped routes manage identities, machine tokens, bundles, channels and application connections. A version stores an immutable payload with an exact-byte SHA-256 digest. A channel release points to a version and records its reason and revision. Connections resolve their configured channel, and applications can report the version they observed.

See the [server architecture](../architecture/server.md) for modules and the [HTTP contract](../../contracts/openapi.json) for route and body definitions.
