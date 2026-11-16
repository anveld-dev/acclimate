# State coverage

Six reviewers audited the whole desktop flow, not just the closed editor. New evidence uses build `837fea…`; earlier v6 evidence is a baseline, not a claim of new coverage.

| State family | Evidence for this pass |
| --- | --- |
| Scope and navigation | Long/ordinary bundle names, full selected desktop channel, four views, active route, keyboard links, global menu and resize handoff |
| File workspace | Published and editable source, filters, exact path text, slash-aware wrapping, clean/dirty commands and retained browser edits |
| Hover and focus | Workspace tooltip, Add entry menu, entry dialog, account dialog, Escape and hidden-invoker fallback |
| Collapsed and expanded | Import preview, history, draft details, setup recipes/private settings, account and evidence/output details |
| Decisions | Full generation/version/evidence or manual reason; release and restore actions retain their existing meaning |
| Forms | Local errors and described fields; connection/member scope and permission-sensitive controls |
| Reflow | 1024/1440/1920 desktops, coarse targets, narrow layouts and actual Chrome 200% zoom |

Unknown-write recovery, every stale/concurrent permission race, OS-native popup appearance and assistive-technology qualification are not all freshly rendered. Unchanged recovery semantics were source-reviewed. Long selected channels still clip in some narrow mobile controls; the desktop change does not claim to solve that older limitation. No live evaluator/model quality was tested.

The navigation BDD run intentionally selected 13 scenarios; 183 other scenarios were not rerun for this bounded presentation change. The previous complete behavior baseline remains in the [v6 evidence](../compact-layouts-v6/README.md).
