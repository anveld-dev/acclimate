import Link from 'next/link';

const loop = [
  {
    step: 'Version',
    body: 'Save instructions, skills and approved memory as an immutable bundle version.',
  },
  {
    step: 'Compare',
    body: 'Your application runs the parent and candidate on the same saved cases and grades both.',
  },
  {
    step: 'Review',
    body: 'Your team inspects the scores and evidence before anything ships.',
  },
  {
    step: 'Release',
    body: 'Point a channel such as stable at the reviewed version, or restore an earlier one.',
  },
  {
    step: 'Deliver',
    body: 'Each new job fetches, verifies and prepares the pinned content for its native agent SDK.',
  },
];

const entries = [
  {
    title: 'Quickstart',
    href: '/docs/get-started/quickstart',
    body: 'Connect an existing agent and run its first comparison.',
  },
  {
    title: 'Guides',
    href: '/docs/guides/evaluate-a-change',
    body: 'Evaluate a change, gate PRs in CI, deliver content to jobs and release safely.',
  },
  {
    title: 'Integrations',
    href: '/docs/integrations/codex',
    body: 'Prepare content for Codex, the Claude Agent SDK, Pi and Cursor.',
  },
  {
    title: 'Operate',
    href: '/docs/operate/deploy',
    body: 'Deploy the service with PostgreSQL, Keycloak and TLS.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 py-16 md:py-24">
      <section className="flex flex-col gap-6">
        <p className="text-sm font-medium text-fd-muted-foreground">Acclimate documentation</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
          Change what your agent knows, with evidence before you ship it.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground text-pretty">
          Acclimate versions the instructions, skills and approved memory your agent uses. When you
          change them, your application runs the old and new versions on the same saved tasks and
          grades the results. Your team reviews the evidence before releasing the change.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/docs/get-started/quickstart"
            className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            href="/docs"
            className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            Read the docs
          </Link>
        </div>
      </section>

      <section aria-labelledby="loop-heading" className="flex flex-col gap-6">
        <h2 id="loop-heading" className="text-xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="grid gap-px overflow-hidden rounded-xl border bg-fd-border sm:grid-cols-2 lg:grid-cols-5">
          {loop.map((item, index) => (
            <li key={item.step} className="flex flex-col gap-2 bg-fd-card p-5">
              <span className="font-mono text-xs text-fd-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="font-medium">{item.step}</span>
              <span className="text-sm text-fd-muted-foreground">{item.body}</span>
            </li>
          ))}
        </ol>
        <p className="max-w-2xl text-sm text-fd-muted-foreground">
          Your application runs the agent. The service stores versions, comparisons and releases;
          it never receives your model provider credentials.
        </p>
      </section>

      <section aria-labelledby="start-heading" className="flex flex-col gap-6">
        <h2 id="start-heading" className="text-xl font-semibold tracking-tight">
          Where to start
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {entries.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="flex flex-col gap-1 rounded-xl border bg-fd-card p-5 transition-colors hover:bg-fd-accent"
            >
              <span className="font-medium">{entry.title}</span>
              <span className="text-sm text-fd-muted-foreground">{entry.body}</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
