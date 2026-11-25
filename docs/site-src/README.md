# HTML docs source

The output is plain, self-contained HTML at [docs/site/index.html](../site/index.html). It works from disk, with no CDN, network calls, server, or browser-side Markdown renderer.

- Page text comes from the current design, architecture, and operations guides listed in the builder.
- Page order, routes, navigation, and shell: [build_docs.py](../../scripts/build_docs.py).
- Appearance and browser behavior: [styles.css](styles.css), [app.js](app.js).
- Diagrams: HTML fragments under `diagrams/`, styled by [diagrams.css](diagrams.css).

[diagrams.json](diagrams.json) registers each diagram ID, its owning source page, and its HTML fragment. Place `<!-- diagram:name -->` immediately before its Mermaid fallback, or use the marker alone to insert a drawing. The builder rejects duplicate, misplaced, missing, and unused diagram IDs; source block order never selects the drawing. Each drawing needs a caption, readable text order, responsive layout, and theme-aware colors.

Run `python3 scripts/build_docs.py` and `python3 scripts/check_docs.py` from the repository root. The check covers every page, local link/anchor, search target, source-page inventory, and unrendered diagram. It also checks source fingerprints and fails if the HTML is stale. Generated pages include a copy of their Markdown source and the pinned repository manifest.

Optional browser QA uses `python3 scripts/test_docs_browser.py` with the Python `playwright` package and an installed Chrome. It creates an isolated headless context, checks all pages at five widths in both themes, tests navigation/search/keyboard flows, and denies external network requests. It never starts a server or uses a personal browser profile.

Keep the generated pages in sync with their sources. Serve or copy `docs/site/` as a unit if hosting is added later; publication is not part of this local build.
