# AgentRun: borrow the task flow, not the runtime

Inspected local commit `077b2fa1c831bdd2bbcb7ed7a0435914f48486b5`. This was a read-only source review; no upstream scripts, tests or builds ran. The observations below describe code, not a reproduced usability study.

AgentRun helps a person create and run an agent, inspect its output, and review what it learned. Acclimate manages versioned content and evaluation evidence for an app that owns execution. That difference matters more than visual similarity.

## Useful patterns

| Observed in AgentRun | Apply to Acclimate |
| --- | --- |
| [StartHere](../../../.repos/agentrun/apps/console/src/components/StartHere.tsx), lines 21–57, offers three concrete starter tasks. It shows the missing model prerequisite instead when none can run. | App setup should lead to one working integration: choose a language, install, configure access, copy the recipe, recognize the result. Keep checkout packaging and recovery notes secondary. |
| [CodingAgentHandoff](../../../.repos/agentrun/apps/console/src/components/CodingAgentHandoff.tsx), lines 16–58, opens a context-specific dialog with app choice, editable prompt and Copy. It explicitly says copying runs nothing and carries no credential. | Make the next action and execution owner obvious. Our setup can provide copyable code and expected output without implying that the console runs the host agent or verifies an unexecuted recipe. |
| [AgentPage](../../../.repos/agentrun/apps/console/src/components/AgentPage.tsx), lines 145–172, places Back above the desktop title. Current revision facts have their own lower band. | The user's separate Back and title rows fit an actual upstream pattern. Keep channel selection beside identity, with tabs below; IDs and revision internals should not compete with the title. |
| [RunChanges](../../../.repos/agentrun/apps/console/src/components/RunChanges.tsx), lines 28–64, starts with the human description of a changed note, puts its path underneath, and opens Before/After locally. Empty changes render nothing. | Changes should start with useful content names, saved state and the next action. Open the diff where the person selects a change. Move immutable IDs and raw records into named details. |
| [Learning](../../../.repos/agentrun/apps/console/src/components/Learning.tsx), lines 168–184, puts pending approval ahead of optional impact charts. Earlier artifacts appear later, at lines 210–219. | Prioritize actionable drafts and release decisions. Put closed drafts and old releases after the current state. Recovery controls belong to an actual uncertain operation, not the normal page. |
| [AgentsList](../../../.repos/agentrun/apps/console/src/components/AgentsList.tsx), lines 52–91, separates descriptive content from small, explicitly named icon actions. | Group Add entry and Import in the file toolbar, with accessible labels and tooltips. The count can sit quietly at the bottom of the file panel, as requested. |

## Where our old flow wandered

These are product inferences from the source comparison, not claims that AgentRun has solved our exact problem:

- **Setup read like a long installation document.** The pre-change [SdkSetup](../../../apps/console/src/components/sdk-setup.tsx) exposed package distribution, checkout builds and configuration before the person reached useful code. A short working path should own the page; supporting instructions should be nearby when needed.
- **Changes led with system vocabulary.** The pre-change [BundleChanges](../../../apps/console/src/components/bundle-changes.tsx) mixed a “Make a change” panel, saved drafts, closed-state filtering and suggestions. The useful question is simpler: what am I changing, what state is it in, and what can I do next?
- **Release history needs a clear current state.** [BundleReleases](../../../apps/console/src/components/bundle-releases.tsx) has valid restore and uncertain-write behavior. Keep it, but give current release, release reason and Inspect/Restore visual priority over raw request bodies and IDs.
- **File controls competed with the files.** Type selectors and repeated top counts add little to a small content bundle. Removing the selector and moving counts down follows the user's request; it is not something upstream proves universally correct.

## What not to copy

AgentRun's model keys, tool grants, computers, run bars, workflows and agent execution belong to its runtime product. Adding them here would recreate the scope expansion the user already rejected.

Its revision header is also not our channel promotion contract. Restoring a retired learned note is not the same operation as creating a new content release. Preserve Acclimate's actual evidence binding, revision checks and explicit release confirmation.

Syntax highlighting is a worthwhile improvement of our own. [AgentEditor](../../../.repos/agentrun/apps/console/src/components/AgentEditor.tsx), lines 325–329, uses a plain textarea with a rendered Markdown preview. [RunFiles](../../../.repos/agentrun/apps/console/src/components/RunFiles.tsx), lines 65–119, uses rendered Markdown or raw text. Neither supports claiming that a full IDE is the upstream golden path.

AgentRun itself puts file counts above its run-file list ([RunFiles](../../../.repos/agentrun/apps/console/src/components/RunFiles.tsx), lines 25–55). The requested bottom count is our design decision. Borrow intent, not every control.
