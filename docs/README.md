# Documentation

[Open the HTML docs](site/index.html) for searchable guides to Acclimate’s learning loop and versioned delivery. The pages open directly from disk.

- [Get started with versioned delivery](getting-started.md)
- [Run Acclimate locally](development.md)
- [Set up learning](architecture/central-learning/experience.md)
- [Read the design guide](design/README.md)
- [Explore the implementation architecture](architecture/README.md)
- [Publish an Acclimate release](releasing.md)

## Rebuild the HTML export

From the repository root, install the build dependencies and regenerate the checked-in export after editing a source page.

```sh
python3 -m pip install -r scripts/docs-requirements.txt
python3 scripts/build_docs.py
python3 scripts/check_docs.py
```

[The export source guide](site-src/README.md) covers page registration, diagram fragments, and shared styles.
