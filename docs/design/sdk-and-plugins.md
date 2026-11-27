# SDKs and plugins

Use **App setup** in the console to choose a workspace, bundle and channel and copy the SDK configuration. The TypeScript and Python SDKs resolve the channel, verify the immutable payload bytes and prepare files for the job. Record the version and digest with the job result and clean up the prepared files after the job stops. See [Deliver a bundle to your agent](../getting-started.md).

## Native SDK inputs

The TypeScript plugins map verified bundle content to job-local files and options for the native SDK. The app chooses the job directory and collision policy, starts the native SDK and owns the lifetime of the resulting session.

| Native SDK | Preparation |
| --- | --- |
| Claude Agent SDK | Stage skill files and set the native options for instructions and settings discovery. |
| Pi SDK | Map instructions and skills to the resources used to create a session. |
| Cursor SDK | Prepare a local workspace with the files and options for the Cursor agent. |
| Codex SDK | Prepare repository instructions and skills in the job's working directory. |

See the [SDK architecture](../architecture/sdk.md) for the delivery and preparation boundary.
