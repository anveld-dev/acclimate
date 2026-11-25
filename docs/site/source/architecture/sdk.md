# SDK and native plugins

The [TypeScript and Python clients](../getting-started.md) resolve channels, fetch immutable payloads and verify hashes before parsing. The cache is scoped to the authenticated application and service. Preparation writes a pinned version's files to a private job directory. New jobs resolve a channel again. Keep existing prepared files until their job stops, then clean up.

The native plugins translate a verified version into inputs for Codex, the Claude Agent SDK, Pi and Cursor. The application calls the native SDK. Provider-dependent helpers live behind native entry points. Delivery receipts report which version the app observed at job start.

An application with workspace write access can call `job.expect(expected, { input, output })` after a production job. The SDK sends the pinned version and digest. The service assigns the task’s split and runs admission.
