# Core service and SDK roadmap

[Design guide](README.md)

All five core stages have a working implementation and local acceptance evidence. The [console productization guide](../architecture/productization/README.md) covers the implemented console improvement workflow and access/reporting code. The local workflow is checked; live hosted identity and deployment qualification remain. The application keeps its native agent runtime. The [full acceptance record](../implementation/full-roadmap.md) separates tested behavior from platform/provider limits.

<!-- diagram:service-roadmap -->

## 1. Deliver a bundle

The Rust service stores scoped immutable versions and channel pointers in PostgreSQL. TypeScript and Python clients verify the exact downloaded bytes, use private atomic caches, and prepare job-local files safely.

**Verified:** publish instruction, skill and memory content; reject unauthorized reads, malformed paths, conflicting files, redirects and bad digests. Both SDKs install into clean external consumers.

## 2. Use it through a native SDK

The app resolves a version before starting its agent and records its ID/digest. It owns credentials, execution, workspaces and cleanup.

**Verified:** Codex/Luna fresh and resumed-workspace checks; after a real fixture promotion the next preparation receives the new skill, while the existing workspace keeps its original skill bytes. Rollback restores the next preparation's content.

## 3. Prove the plugin interface

Codex, Claude, Pi and Cursor have small in-process preparation packages. Native helper entry points use actual pinned SDK interfaces; the main preparation entry points work without native runtime dependencies. Python uses the same content contract.

**Verified:** native file mapping and external package consumers, Claude option types, Pi's real resource loader, and Cursor option types. Codex has live Luna evidence. Claude/Pi/Cursor provider calls and in-place hot reload are not qualified; no unsupported model was used to fill that gap.

## 4. Improve one file

A scoped proposal pins a parent and allowed paths. The bounded service worker saves an immutable candidate. The application runs paired cases and its independent grader, then uploads the complete inventory and outcomes.

**Verified:** a real service-generated skill edit with a Luna-backed local qualification transport and four paired app executions. PostgreSQL tests cover authorized instruction and memory edits, unchanged parent/unselected files, candidate provenance, invalid edits, interruptions and missing results. Artifacts preserve the proposal, before/after content and responses. A two-case fixture does not prove a general quality gain.

## 5. Publish deliberately

Operator commands fetch and verify review content and evidence. Explicit promotion requires matching comparison evidence and the current channel revision. History is scoped and paginated; rollback records its reason and advances the revision.

**Verified:** operator review → fixture promotion → next-job refresh → stale revision denial → history pages → rollback. Process ownership, restart, private backup and transactional restore also have local checks. Deployment recipes are provided; no production deployment or registry publication was performed.

The core remains one content service. Hosted execution, global agent spend control, a sandbox fleet, automatic optimization and live session mutation are outside this roadmap.
