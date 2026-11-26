# Deliver a bundle to your agent

1. Start with [the local quickstart](https://acclimate.anveld.dev/docs/get-started/quickstart) or [join your team's workspace](https://acclimate.anveld.dev/docs/reference/credentials).
2. Open **Bundles** and create a bundle from text or files. The first release points the selected channel at the imported version.
3. Create a connection for that bundle and channel. Issue a content-read credential and follow the SDK setup recipe in the console.
4. Prepare the verified content before job execution. Save the version ID and digest with the result and clean up prepared files after the job stops. [SDK delivery guide](https://acclimate.anveld.dev/docs/guides/deliver-content)

Use the SDK to upload another immutable version. A release moves the channel with an expected revision and a reason. **Releases** shows version history and can point the channel back at a previous version. [Release and rollback guide](https://acclimate.anveld.dev/docs/guides/release-and-roll-back)

After releasing your first version, you can enroll the bundle in the [learning loop](design/improvement.md).
