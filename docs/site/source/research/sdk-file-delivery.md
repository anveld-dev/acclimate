# Native SDK file delivery

**Checked 2026-11-13.** The original source inspection did not execute upstream tests or paid sessions. The subsequent implementation adds Codex/Claude/Pi preparation mappings and a live Codex SDK `0.169.0` check using `gpt-6-luna`; [run locally](../development.md) describes the check and limits. Claude options and the real Pi resource loader now have offline checks. Codex has separate fresh/resumed workspace observations; in-place reload and live Claude/Pi provider sessions remain unqualified.

A cache makes content available to the application. A native SDK only uses that content through its own supported prompt/resource mechanism. None of these observations establishes one portable memory API or automatic updates to an existing conversation.

## Claude Agent SDK

Claude exposes system-prompt configuration and file-based skills. The current skills guide describes `SKILL.md` discovery through `settingSources` (TypeScript) / `setting_sources` (Python), plus a `skills` option controlling which discovered skills can be invoked. That option selects skills; it does not register arbitrary skill text. Explicitly select the intended project/plugin sources rather than inheriting a developer's personal setup. [Official skills guide](https://code.claude.com/docs/en/agent-sdk/skills).

The pinned Python source documents custom/system prompts, `cwd`, and prompt snapshot behavior on resume. An edited prompt may not replace the saved snapshot; a new session is the predictable baseline, with version-specific alternatives documented upstream. [Pinned SDK README](https://github.com/anthropics/claude-agent-sdk-python/blob/22b8eb9c19adfa78759b79e22bd664a57843bb06/README.md#L71-L87).

**Plugin route:** stage a skill in a supported location and supply selected instructions/memory as native prompt/context or files. Verify discovery and prompt composition in a fresh session. The SDK can internally use a bundled runtime; Acclimate need not supervise that runtime itself.

## Codex SDK

OpenAI documents both TypeScript `@openai/codex-sdk` and stable Python `openai-codex`. These are distinct from the OpenAI model API clients and the separate OpenAI Agents SDK. The SDKs start/use local Codex threads; Python includes a pinned runtime dependency. Using that official wrapper is different from implementing a custom CLI/app-server supervisor. [Official Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

Codex loads repository instructions from `AGENTS.md`, while skills use native discovery locations including project `.agents/skills`. A skill directory contains a `SKILL.md`; discovery and loading are not equivalent to arbitrary in-memory registration. [Repository instructions](https://developers.openai.com/codex/guides/agents-md), [native skills](https://learn.chatgpt.com/docs/build-skills).

**Plugin route:** prepare an application-controlled working directory with the approved instruction/skill files before starting a thread. Don't silently overwrite an existing instruction file or assume a resumed thread reloads changed resources. Supply memory as selected context/files; there is no common cross-harness `memory=` contract. Exact option parity and refresh behavior need version-specific tests.

## Pi SDK

Pi's coding-agent SDK uses a resource loader. Its source recommends `DefaultResourceLoader` for standard discovery with selected overrides, and a custom `ResourceLoader` when the host owns storage and discovery. That is a direct integration seam for locally cached resources. [Pinned SDK guide](https://github.com/earendil-works/pi/blob/b4899f59ef0fba6507c2e619fd804dcde51920ba/packages/coding-agent/docs/sdk.md#L98-L110), [pinned skill guide](https://github.com/earendil-works/pi/blob/b4899f59ef0fba6507c2e619fd804dcde51920ba/packages/coding-agent/docs/skills.md).

**Plugin route:** configure the app's resource loader from the resolved bundle, then create its native session. Treat approved memory as selected context or files. Test explicit resource reload/resume separately; refreshing a cache directory is not proof the existing session changed. No external RPC layer is required for this embedded SDK route.

The clone directory is still named `pi-mono`; the current project is `earendil-works/pi`. The implementation now tests `@earendil-works/pi-coding-agent` 1.5.2, using the real loader with extensions and ambient context disabled. The old npm scope was replaced after checking the [upstream advisory](https://github.com/advisories/GHSA-jfgx-wxx8-mp94).

## Cursor SDK

Cursor has official TypeScript and Python SDK documentation. The TypeScript SDK supports local and cloud runtimes. Local execution uses files on disk; cloud execution uses its remote environment. Its configuration lists `local.cwd`, `local.settingSources`, and workspace scan caching. Native rules/skills can therefore have their own freshness behavior beyond our download cache. [TypeScript SDK](https://cursor.com/docs/sdk/typescript), [Python SDK](https://cursor.com/docs/sdk/python).

**Plugin route:** prepare an app-controlled local workspace, select native configuration deliberately, and test discovery on a fresh agent. A cloud SDK/API run needs content in its remote workspace; a caller's local path is not an upload. Cursor also documents a separate [Agent SDK](https://cursor.com/docs/agent-sdk) and [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints); their delivery mechanisms should be assessed separately before adding examples.

## What an example must prove

Use one instruction, one skill, and one approved memory file. Verify native discovery and the actual options used, rather than treating a good answer as proof that every resource loaded. Record SDK version, bundle digest, and session creation mode.

Then test a changed bundle, resumed session, offline cache use, paths with spaces, conflicting existing files, and a remote workspace if that route is claimed. Keep model/provider credentials with the application. Cached content cannot grant additional runtime permissions.

The first implementation uses Codex as its live example and Claude/Pi preparation to exercise the same application-side interface. More examples are delivery work, not a reason to create a universal agent runtime. The first improvement loop can use a service-side proposer plus app-run comparisons without automatic multi-candidate search.
