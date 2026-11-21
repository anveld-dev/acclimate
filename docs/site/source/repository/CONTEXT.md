# Acclimate glossary

Acclimate combines versioned delivery with a self-improvement loop for enrolled bundles.

| Term | Meaning |
| --- | --- |
| Workspace | The scope for bundles, connections and the people who can access them. |
| Bundle | A named collection of agent instructions, skills and memory files: the harness. |
| Version | An immutable snapshot of a bundle. Its digest identifies the exact bytes. |
| Channel | A named reference, such as `stable`, to the version jobs should use. |
| Release | A move of a channel to a version, with a reason. Restoring an earlier version creates a new release. |
| Connection | The link between an application and the workspace, bundle and channel it uses. |
| Learning loop | The always-on loop for one enrolled bundle. It runs rounds back to back while running and with live evolve cases, and releases adopted versions on its learning channel. |
| Round | One pass of the loop: score the incumbent, propose five candidates, screen, evaluate the survivors, adopt or keep, and score the held-out split. |
| Candidate | One of the five proposed changes in a round, with its diagnosis and predicted fixes. |
| Evolve split | The cases the loop learns from. Their scores, traces and errors reach the optimizer. |
| Held-out split | Fixed cases kept in the evaluator's own store. Their scores are shown for monitoring and never reach the optimizer. |
| Outcome | A job's pinned version, input and known expected answer. The input and expected answer become an evolve case. |
| Improvement memory | The optimizer-only record of problems and adopted attempts, including predicted fixes and measured results. Workspace readers other than the app principal can inspect it. It stays outside delivered bundles. |
| App principal | The machine identity that submits outcomes and evolve cases and runs the evaluator for a loop. |

## Internal terms

| Term | Meaning |
| --- | --- |
| Operation result | A stored mutation response used to recover a request by its original key and bytes. |
| Delivery receipt | An application report of content preparation or job startup. |
