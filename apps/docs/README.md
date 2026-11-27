# Acclimate product documentation

The product documentation site is built with [Fumadocs](https://fumadocs.dev) on Next.js and exported as static HTML. It is written for developers who integrate Acclimate into an agent application and for operators who deploy the service. Design records, architecture notes and qualification evidence stay in [`docs/`](../../docs/README.md).

The site is published at [acclimate.anveld.dev](https://acclimate.anveld.dev). The `docs` workflow builds and deploys it to Cloudflare on every push to `main` that changes `apps/docs/`, using the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. To deploy by hand with those set, run `npm run deploy:docs`.

```sh
npm ci --ignore-scripts
npm run dev:docs      # http://127.0.0.1:3200
npm run build:docs    # static site in apps/docs/out/
npm run typecheck:docs
```

Pages live in `content/docs/` as MDX with `title` and `description` frontmatter. Each folder's `meta.json` sets the sidebar order. Besides the Fumadocs defaults (`Callout`, `Cards`, `Card`), pages can use `Tabs`/`Tab`, `Steps`/`Step`, the diagrams in `components/diagrams.tsx` and `Screenshot` without imports. Link between pages with absolute `/docs/...` paths, and keep commands, flags and settings consistent with the repository sources they describe.

Link previews come from each page's `title` and `description`. `lib/metadata.ts` writes the Open Graph and X tags, and `lib/og.tsx` draws the 1200×630 card for every page at build time: the home card at `/og/image.png` and one per docs page under `/og/docs/`. The cards use static Recursive TrueType files in `assets/fonts/` because the image renderer cannot read woff2. Check a card after a long title change by opening it in `out/og/`.

`Screenshot` shows a console screenshot from `public/screenshots/`, in a light and a dark version. To regenerate them after a console change, start the local stack, run the [support agent tutorial](content/docs/tutorials/support-agent.mdx) once so the pages have tasks and rounds, and run:

```sh
.venv-bdd/bin/python scripts/docs/screenshots.py   # or name the screenshots to retake
```

The script signs in as the stack's operator and never submits a form. Check each image for secrets before you commit it.
