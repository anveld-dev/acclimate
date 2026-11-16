# Documentation

**[Open the HTML docs](site/index.html).** The pages include navigation, local search, light/dark themes, and diagrams. Open the file directly; browsing needs no server, installation, or network.

The main site covers current [design](design/README.md) and [research](research/README.md) pages. Historical snapshots are linked from the research archive and excluded from main search. The Markdown files remain the editable source; generated HTML lives in `docs/site/`.

The [architecture folder](architecture/README.md) breaks the design into planned code modules and parallel agent assignments.

## Editing

From the repository root:

```sh
python3 -m pip install -r scripts/docs-requirements.txt
python3 scripts/build_docs.py
python3 scripts/check_docs.py
```

Edit page text under `docs/design/`, `docs/architecture/`, or `docs/research/`. Diagram fragments and shared styles/behavior live under `docs/site-src/`; [the source guide](site-src/README.md) explains the small build setup. Rebuild after changes.

The first service and SDK implementation is available. [Run locally](development.md) for setup and checks. Earlier execution-platform documents are archived.
