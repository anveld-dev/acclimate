# Acclimate

Acclimate delivers the instructions, skills and approved memory your agent uses. Your application runs the agent and grades its work.

## Public glossary

| Term | Meaning |
| --- | --- |
| Workspace | The scope for bundles, connections and the people who can access them. |
| Bundle | A named collection of agent instructions, skills and approved memory. |
| Version | An immutable snapshot of a bundle. Its digest identifies the exact bytes. A client can verify those bytes and prepare them for a job. |
| Channel | A named reference, such as `stable`, to the version jobs should use. |
| Proposal | A request for changes to a bundle, with a candidate version when the changes are ready. |
| Comparison | The outcomes of running two versions on the same cases with the same grading rules. |
| Release | A decision to make a version available on a channel or connection. Restoring an earlier version creates a new release. |
| Connection | The link between an application and the workspace, bundle and channel it uses. |
| Outcome | The application’s result for a task on a specific version. It may carry a correction the application approves for future proposals. |

## Internal terms

These names apply to service operations and contracts.

| Term | Meaning |
| --- | --- |
| Draft | Editable changes based on a version and channel revision. Saved generations preserve the edits before they become a version. |
| Operation result | A stored mutation response used to recover a request by its original key and bytes. |
| Delivery receipt | An application report of content preparation or job startup. |
| Evaluation request | An assignment for an application to run and grade a comparison. |
| Handoff | The file (`handoff.json`) that gives an evaluator one evaluation request: the service URL, workspace, bundle, request ID and descriptor. |
| Learning enrollment | The administrator’s authorization for a connection to accept outcomes, generate proposals, request comparisons and release versions under configured limits. |
| Round | The service’s tracked work on an admitted improvement, from proposal through comparisons and any release decision. |
| Policy epoch | A span of rounds using the same selection and evaluation policy. |
| Admission decision | The service’s decision about whether an outcome or correction can start another round. |
| Teaching view | The approved subset of outcome and correction data supplied to the proposer. |
| Harness treatment | The agent configuration and bundle content assigned to one side of a comparison. |
| Audit cohort | A held-out inventory of cases reserved for an independent comparison. |
| Development incumbent | The version currently selected for comparison in private development. |
| Renewal | An administrator’s update to enrollment limits, case inventories or policy. |
| Recheck | A test of whether the current version still exhibits the issue described by a correction. |
| Field audit | A comparison of sampled jobs on a released version against its assigned control. |
| Field window | The interval in which the service gathers evidence about a release from sampled jobs. |
| Requalification | Replay evidence required before withdrawn content can be restored against the current version. |
| Incident replay | A private reproduction check tied to an outcome or correction. |
| Restore target | The previously released or currently approved source version chosen for restoration. |
| Delivery revision | The increasing reference for the version served by a connection. |
| Policy override receipt | The recorded policy evidence and reason that authorize a release despite a blocking verdict. |
