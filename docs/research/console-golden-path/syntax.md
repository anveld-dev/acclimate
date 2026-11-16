# Syntax highlighting and editing

Use **Shiki for read-only code** and **CodeMirror 6 for editing**. Shiki was already installed, but none of the active page surfaces used its highlighter. The gap was integration, not a missing library.

| Option | Good fit | Decision |
| --- | --- | --- |
| [Shiki](https://shiki.style/guide/) | Read-only source and snippets; TextMate grammars, lazy language/theme loading | Reuse installed 4.6.0. Render React text tokens rather than injecting HTML. |
| [CodeMirror 6](https://codemirror.net/) | A real editor with native input, selection, mobile support and extensions | Add focused modules and a small wrapper; skip IDE chrome, completion, folding and line-number clutter. |
| [Monaco](https://github.com/microsoft/monaco-editor) | A browser IDE with language services and workers | Too much surface for instructions and small config files. Its official README also excludes mobile browsers. |

This is a fit comparison, not a download-count ranking.

## Shared pieces

- [SyntaxCode](../../../apps/console/src/components/syntax-code.tsx) keeps a real, selectable `pre`, highlights after hydration, and falls back to exact plain source for unknown languages, chunk failures or files over 100,000 characters. Copy actions use the original source.
- [CodeEditor](../../../apps/console/src/components/code-editor.tsx) lazily loads CodeMirror. It has one real contenteditable textbox, no painted overlay or hidden textarea mirror. A visible plain-text editor remains available if loading fails.
- [Raw source state](../../../apps/console/src/lib/editor-source.ts) maps logical editing offsets to the original CRLF, LF or mixed endings. Undo/redo restores those endings too. History keeps compact newline metadata and shared document trees, rather than copying the whole source for every keystroke.
- The public `codeEditor.getValue()` / `focus()` handle supports host integrations and exact-byte readbacks. It has no write escape hatch and is removed on unmount. Tests edit through native input and verify saved payloads through the service.

The [CodeMirror system guide](https://codemirror.net/docs/guide/) models edits as transactions. Its [Tab guidance](https://codemirror.net/examples/tab/) deliberately leaves Tab available for focus navigation; our wrapper keeps that default. Disabled editors set both the [read-only state and noneditable DOM facets](https://codemirror.net/examples/readonly/).

Languages are bounded and lazy: Markdown, JSON, TypeScript/JavaScript, Python, Rust, YAML, shell and TOML for editing; Shiki also handles CSS, HTML, SQL, diff and common config formats for reading. Above 200,000 characters the editor keeps native editing and skips language parsing.

## Evidence and limits

Focused unit tests cover real token colors, escaped source, unsupported names, exact line splitting, multi-edit UTF-16 offsets, mixed-ending changes and undo/redo. [Browser evidence](../../../artifacts/golden-path-v3-focused/summary.json) checks native clipboard paste, undo/redo, file switching, exact copy and service-saved bytes in a virtualized document. [Layout checks](../../../artifacts/golden-path-v3-desktop/summary.json) cover focus, viewport sizing and coarse-pointer controls. IME composition and broad assistive-technology compatibility still need dedicated qualification.
