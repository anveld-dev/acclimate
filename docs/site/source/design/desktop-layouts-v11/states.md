# States that matter

The layouts were reviewed as workflows, including the parts a closed screenshot hides.

| Area | States and boundaries |
| --- | --- |
| Library | Several bundles, long names, real channel links, no published channels, live local search, no matches, read-only and empty states. |
| Creation | Create, Files, Bundle JSON and Example; retained browser input, source changes, advanced settings, JSON validation, import preview and explicit confirmation. |
| Initial publication | Real initial channel, fixed compatibility target, content count, immediate publication and no evaluation. Cancel must respect dirty input. |
| Creation recovery | Visible unresolved result and Check result before another write; exact retry, close and forget keep distinct meanings. |
| Draft lists | Current channel, open versus all statuses, complete identities, independent details, refresh, loading/error and pagination. A loaded page is not the whole history. |
| Suggestions list | All channels, queued/running/ready/failed, real returned errors, separate parent identity, polling and older pages. A suggestion is not a release. |
| Suggestion form | Real source release details, long editable paths, hypothesis and authorized evidence, whole-parent reading disclosure, unchecked consent and disabled actions. |
| Proposal recovery | The entire mode, including notices, shares the form width. Pending Check result stays visible; no new collapsed recovery gate. |
| Shared interactions | Hover and keyboard focus, tooltips, open/closed disclosures, checkbox Space, menus, dirty cancellation and dialog Escape/return. Existing shadcn primitives own these behaviors. |
| Reflow | Desktop 1440/1920/1024, narrow coarse-pointer controls and actual Chrome 200%. Long paths and IDs wrap; source editors and paired evidence keep their existing wider layouts. |

The focused v11 proof uses private PostgreSQL, real service/API data and browser interaction. Fixture-provider outcomes can establish returned UI states and scope checks; they do not measure model quality. We do not claim to freshly manufacture every permission, transport or unknown-outcome failure. Those branches remain separately source-reviewed or covered by earlier behavior suites.

## Verification notes

Early focused runs had two test assumptions corrected: editable paths start unchecked, and a successful suggestion opens the existing Saved change review region. The diagnostics stay separate from accepted evidence; neither assumption required a product change. The final proof checks that consent alone cannot submit without an editable path.

The closed-draft bug was an application issue. A unit regression checks the exact scoped status=all request on the first and cursor pages. Real API fixtures discard the 20 highest-ID drafts, leaving open drafts on a later page, so the browser can prove filtering, honest partial-history copy and Load more without response interception or direct database edits.
