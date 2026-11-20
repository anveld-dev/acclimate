# Rethink the console navigation

**Implemented from the 2026-11-14 review.** The workspace sidebar, scoped bundle views, single change editor, Connections, Members and account split are now in code. The tables below record the reviewed baseline and chosen ownership. Reviewed every visible page and the auth route on 2026-11-14. Four reviewers challenged authoring, onboarding/delivery, minimal navigation and scope integrity. The live local console was inspected without changing stored data. Hosted behavior was reviewed in source.

The main problem is scope. Workspace administration, bundle work, channel history and account actions currently look like seven equal destinations. Renaming those links won't fix that.

## The structure to use

Put workspace destinations in the sidebar. Put **Content · Changes · Releases** on the opened bundle. Show the workspace and bundle names in the header. Show the channel where it applies.

```text
Workspace: Acme ▾                       ← real workspace switcher
  Bundles                              ← workspace landing page
    Payment review                     ← open a named bundle
      Content                          ← published files; selected channel
      Changes                          ← saved drafts and suggestions
      Releases                         ← selected channel's history
  Connections                          ← authorized administration
  Settings
    Members                            ← current workspace admins

Account menu                           ← verified identity and sign-out
Sign in                                ← anonymous visitors; workspace access follows verified identity
```

The indentation describes ownership. The sidebar shows Bundles, Connections and the permitted settings links; Content/Changes/Releases are bundle tabs, not more workspace peers. Render Settings only when the current membership provides relevant actions.

A **workspace** is the existing project. A **bundle** is a named collection of instructions, skills and approved memory. A **channel** selects the published version an application fetches. Keep these names consistent; don't call the project-plus-bundle-plus-channel tuple a workspace.

## What is wrong today

| Finding | Evidence and implication |
| --- | --- |
| The hierarchy is mostly decorative. | [Shell](../../../apps/console/src/components/shell.tsx) has seven flat links, a generic `Workspace / page` header and a noninteractive “Stored workspaces” footer. Replace the footer with a real switcher and name the selected context. |
| Setup hides everyday navigation. | [Setup](https://github.com/anveld-dev/acclimate/blob/9b4e660/apps/console/src/routes/setup.tsx) mixes browsing, selection and creation. Its Project dropdown changes the creation target, while bundle rows still span every project. The displayed list and selected workspace must agree. |
| Overview repeats other pages. | [Overview](../../../apps/console/src/routes/index.tsx) repeats the Content file list and recent release facts. Move those facts into the bundle header and Releases; remove Overview as a primary destination. |
| Content has two independent file selections. | [Content](https://github.com/anveld-dev/acclimate/blob/9b4e660/apps/console/src/routes/content.tsx) stacks a published viewer over a separate [draft editor](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/apps/console/src/components/draft-workspace.tsx). Clicking a published file does not select it in the editor. Use one published view or one named change detail at a time. |
| Improvement mixes several stages. | [Improvement](https://github.com/anveld-dev/acclimate/blob/4096ff1b60098554b0cb932866a338cadf29601c/apps/console/src/components/improvement-workspace.tsx) combines proposal creation, candidate lookup, evaluation and release. Put those actions on the selected change, with links between its saved records. |
| Access mixes three owners. | [Access](https://github.com/anveld-dev/acclimate/blob/9b4e660/apps/console/src/routes/access.tsx) combines personal identity, deployment-operator workspace creation and workspace membership. Local mode only explains configuration. Split those responsibilities. |
| SDK setup sits behind administration. | [Integration access](../../../apps/console/src/server/integration-core.ts) requires admin access before the [page](https://github.com/anveld-dev/acclimate/blob/9b4e660/apps/console/src/routes/integrations.tsx) displays its general SDK recipe. Move the readable recipe to the bundle; keep credentials and receipt administration separate. |

## Every action gets a home

| Current action | Proposed home |
| --- | --- |
| Overview file list, current revision, latest release | Content and compact bundle header; decision details in Releases |
| Setup workspace selection | Persistent workspace switcher |
| Setup bundle selection | Bundles library, scoped to that workspace |
| Write instructions, upload files, import JSON | Bundles → New bundle; retain separate choices and pending-operation recovery |
| Content browse, filter, select and download published entries | Bundle → Content |
| Content add/rename/remove entries or skill packages, import files | Changes → draft detail; one editor |
| Save, reopen, diff and inspect draft generations | That draft's detail; Edit from Content opens the same entry there |
| Request an improvement and authorize provider disclosure | Changes → Suggest a change; retain explicit consent |
| Inspect candidate, request evaluation, inspect evidence | That saved change's detail; link existing requests/comparisons without copying IDs |
| Publish with evidence or an explicit manual reason | Same change detail; confirm target channel, snapshot and current revision |
| Inspect/download old releases, browse history, restore with reason | Bundle → Releases, with a visible channel selector |
| General SDK setup and native plugin guidance | Bundle → Connect app, reachable by readers; no integration required |
| Create optional integration, issue/revoke credentials, revoke integration, inspect/paginate receipts | Workspace → Connections → scoped record; show its bundle and channel |
| Verify a person, confirm identity, grant/change/remove membership | Workspace settings → Members |
| Create workspace | Workspace switcher and no-workspace empty state; operator-only |
| Identity and sign-out | Account menu; auth callback routes stay internal |
| Local access explanation | Local operator info; no daily-work sidebar destination |

“Connections” is a UI label for the existing optional integration records. The workspace index can use the existing project-scoped listing, with bundle/channel filters. It is not a new Application resource, agent runtime or live-health dashboard. A bundle's administration link opens that same index, prefiltered. Its Connect app recipe remains readable separately.

## Changes needs honest ownership

Keep the existing records. Don't add a universal Change database entity or manufacture a combined status.

- **Saved drafts:** owned by bundle and channel. Show an explicit channel filter and paginate this list independently.
- **Suggestions:** proposals owned by the bundle. Show their parent version and candidate, when available; don't imply they were created for the currently selected channel.
- **Evaluation and evidence:** owned by the bundle and exact version pair. Keep requests and comparisons attached to the saved snapshot they describe.
- **Publishing:** an explicit action against a channel, with existing parent, generation and revision checks. Changing the channel must not relabel old evidence.

The current console's evaluation request is a fixture workflow. Keep that label until general evaluator settings are supported. Navigation changes must not imply that the service now executes evaluations or supports arbitrary benchmark configuration.

## Scope correctness comes before cosmetic changes

The current [selection cookie](../../../apps/console/src/server/selection.ts) supplies the resource behind generic URLs. `/content` or `/releases` alone doesn't identify which bundle it means.

Use scoped URLs. The cookie can remember a default landing location; it must not override an opened URL. Example route shapes:

| View | Owning route |
| --- | --- |
| Bundle library | `/w/:workspace/bundles` |
| Published content | `/w/:workspace/bundles/:bundle/channels/:channel/content` |
| Changes index | `/w/:workspace/bundles/:bundle/changes` |
| Draft detail | `…/changes/drafts/:channel/:draft` |
| Suggestion detail | `…/changes/suggestions/:proposal` |
| Release history | `/w/:workspace/bundles/:bundle/channels/:channel/releases` |
| Connection | `/w/:workspace/connections/:integration` |
| Members | `/w/:workspace/settings/members` |

These were route proposals, not new service endpoints. The implementation keeps draft/suggestion/candidate/comparison identity in the scoped Changes URL query (`?draft=…`, `?proposal=…`, `?candidate=…`, `?comparison=…`), rather than adding separate detail path patterns. They remain bookmarkable native records. Use native record IDs and real links for snapshots, evaluation requests and comparisons. Keep file paths and selected saved records bookmarkable; store search/filter state where Back can restore it. Unauthorized or deleted targets show an unavailable state instead of substituting a different bundle.

Two source-inferred risks need runtime regression cases before implementation:

1. **Cross-tab create can change destination.** The integration form sends a name and operation ID; [its server command](../../../apps/console/src/server/integration-core.ts) takes the destination from the current selection cookie. A second tab can change that cookie. Bind every mutation to the scope rendered with its form and reauthorize it server-side; changing the URL alone is insufficient.
2. **Release history can retain another scope's local state.** The [History mount key](https://github.com/anveld-dev/acclimate/blob/9b4e660/apps/console/src/routes/releases.tsx) contains channel and revision, but not actor, project or bundle. Switching between matching channel/revision tuples may preserve old local rows. Key or reset state by full owning scope.

Neither case was runtime-reproduced during the initial review. Implementation adds real browser regression cases for both scope risks; mutations now bind rendered scope and history state resets by actor/project/bundle/channel/revision. Most ownership and page moves can use existing reads and commands. Correctly hiding workspace creation needs a verified deployment-operator capability; workspace-admin membership is not that capability.

## What the reviewers changed their minds about

The authoring reviewer initially placed Connections inside the bundle. The operations reviewer argued that finding and revoking an existing credential should not require remembering the selected bundle. Both authoring and the minimal reviewer accepted one canonical workspace index over existing scoped records.

The integrity reviewer corrected an early assumption that everything under a bundle was also channel-owned. That changed the Changes design to separate draft and suggestion lists, with independent pagination and an explicit release target.

The remaining disagreement is **Content · Changes · Releases** versus **Content → Published / Changes**, plus Releases. Both can work. Recommend the first: reopening saved work and reviewing provider suggestions are important enough to have a visible bundle tab. The second is smaller, and wins if people find saved work just as reliably. Source inspection does not prove either universally best.

Don't settle this by counting links. Ask new users to edit a selected skill, reopen saved work after a fresh visit, find a failed evaluation and identify the channel a release will affect. Prefer the structure with fewer wrong turns and correct target identification. Avoid claiming a small internal review is a usability study.

## Implementation order and acceptance

1. **Establish scope.** Scoped loaders/links, explicit mutation targets, real workspace/bundle labels, correct state reset, permission-aware destinations. Reproduce and close the two cross-tab/state risks.
2. **Replace Overview and Setup with Bundles.** Preserve imported content, stored provenance and unknown-write recovery. Hosted nonoperators without membership get their verified ID and an ask-admin state; local users get the configured workspace.
3. **Make one change detail.** Move the existing editor there, preserve complete skill packages, and link draft/suggestion → exact candidate → evaluation/evidence → deliberate publication. Keep paused/interrupted/missing evidence honest.
4. **Move administration.** One workspace Connections index; reader-accessible SDK recipe; Members separated from account actions. Don't expand the backend domain model.

Extend the existing behavior suite for:

- Same scoped URL opens the same resource in another tab and after restart; Back restores its context.
- Switching workspace, bundle, channel or view prompts for unsaved edits. Cancel preserves text; confirm discards only browser edits.
- Another tab changing its selection cannot retarget a displayed form's write or retain another bundle's history.
- A clicked published entry opens that same path in a named draft; no second independent editor remains below it.
- Exact snapshot/generation and evidence survive refresh, retry and moving between change detail and release history.
- Draft, proposal, request and history lists expose independent pagination; an initial page never masquerades as a complete queue.
- Local, viewer, editor, admin and deployment-operator navigation reflects real capabilities; server authorization remains authoritative.
- A reader can find SDK setup without credential-management access. Missing receipts remain unknown; reports don't claim model consumption.
- Desktop and mobile share the same hierarchy, active state, keyboard navigation and usable context labels.

This is a navigation redesign over the current product. No new agent fleet, application registry, evaluation runner or dashboard is needed.


## Implementation checks

The navigation behavior suite now includes bookmark/Back scope, cross-tab connection creation, same-revision history isolation, workspace switching with unsaved edits, operator capability, membership downgrades, pre-upgrade creation recovery and dirty creation Cancel/Leave. Those cases use a built console, real Rust service and disposable PostgreSQL. The source review's async-detail and actor-state findings are addressed with native-record and actor/role/scope reset rules.

[Behavior stories](../../../features/navigation.feature) · [Console guide](../../../apps/console/README.md)


The final clean-build run passed **158 scenarios / 121 mapped behaviors**, with no failures or skips. Type checks, 117 TypeScript tests, eight Rust unit tests, clippy, and the 35-page documentation/link check also passed. Browser scenarios qualify the local fixture flows; they don't qualify a live identity provider or model quality.
