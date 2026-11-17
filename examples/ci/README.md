# App-owned CI evaluation

The release archive contains `ci.sh` and an `evaluation/` copy of the installed-app starter. It makes no paid calls by default and never promotes a channel. It supports JavaScript or Python and needs only the documented SDK artifact/wheel plus the normal runtime/lock prerequisites.

Install release artifacts explicitly before running the script. Your CI secret manager supplies the private evaluator JSON file and fixed private journal volume. Do not place a token on the command line, in a handoff, or in a tracked file. Evaluator authority is project read/write, separate from delivery and promotion credentials.

```sh
sh ci.sh --language javascript --config /private/config/evaluator.json --bundle YOUR_BUNDLE_UUID --intent /private/persistent/ci-intent.json --output-dir /private/job-results
```

`--language python` uses Python 3.11+ (`ACCLIMATE_CI_PYTHON` may explicitly select its interpreter). The shell script creates an immutable candidate/request, executes the installed app, checks the explicit quality policy, and deliberately attempts the selected review export even after a failed quality check. It preserves `run` versus `check` process categories. If both pass, failed export or export verification still fails the job. No automatic retry creates new paid work.

The intent filename identifies one exact request-creation operation. Reusing it with changed payload/app revision/target is an error. Supply a new intent only after reviewing the old request and deciding new work is appropriate. A channel conflict does not rebase silently. An ephemeral worker without its original journal cannot resume uncertain execution; inspect/terminate the original app, record an explicit interruption, and then decide whether a new request is safe. Restoring a journal at another path or changing language is unsupported.

Upload **only** an export directory containing its committed `manifest.json`, through your CI provider's authenticated artifact mechanism. Configure team-only ACLs and explicit retention. Never upload `--output-dir` recursively, the private config, journal, intent, expected answers or provider credentials. Keep failed/incomplete exports visibly unavailable rather than creating empty successful artifacts. A colleague runs `verify-export` locally and can match the scalar projection online with a project-read credential and an independently selected handoff. Artifact hashes alone are not execution attestation.

An authorized reviewer releases the chosen version separately using fresh channel revision and existing operator commands. Completed evidence, a descriptive quality-policy pass, and permission to release remain separate decisions.

For a real app, replace the starter executor/grader and their public build/dataset/runtime identities. Mark model-backed definitions live and require an explicit `--live` authorization in your reviewed CI adapter; this default script intentionally accepts no live flag. Do not turn a provider timeout into proof the job stopped.
