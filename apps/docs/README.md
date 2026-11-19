# Acclimate product documentation

The product documentation site is built with [Fumadocs](https://fumadocs.dev) on Next.js and exported as static HTML. It is written for developers who integrate Acclimate into an agent application and for operators who deploy the service. Design records, architecture notes and qualification evidence stay in [`docs/`](../../docs/README.md).

```sh
npm ci --ignore-scripts
npm run dev:docs      # http://127.0.0.1:3200
npm run build:docs    # static site in apps/docs/out/
npm run typecheck:docs
```

Pages live in `content/docs/` as MDX with `title` and `description` frontmatter. Each folder's `meta.json` sets the sidebar order. Besides the Fumadocs defaults (`Callout`, `Cards`, `Card`), pages can use `Tabs`/`Tab` and `Steps`/`Step` without imports. Link between pages with absolute `/docs/...` paths, and keep commands, flags and settings consistent with the repository sources they describe.
