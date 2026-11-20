import Link from 'next/link';

const delivery = [
  {
    step: 'Version',
    body: 'Save instructions, skills and approved memory as an immutable bundle version.',
  },
  {
    step: 'Release',
    body: 'Point a channel such as stable at an immutable version, or restore an earlier one.',
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
    body: 'Start a local stack and deliver a verified version to your application.',
  },
  {
    title: 'Guides',
    href: '/docs/guides/deliver-content',
    body: 'Release versions to channels and prepare them for jobs.',
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
          Improve your agent’s harness and deliver each version to your jobs.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground text-pretty">
          Acclimate versions and delivers your agent’s instructions, skills and memory. The
          self-improvement loop ships in a later phase. It will propose five changes per round,
          evaluate those that pass screening and remember what adopted changes fixed.
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

      <section aria-labelledby="delivery-heading" className="flex flex-col gap-6">
        <h2 id="delivery-heading" className="text-xl font-semibold tracking-tight">
          Versioned delivery
        </h2>
        <ol className="grid gap-px overflow-hidden rounded-xl border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
          {delivery.map((item) => (
            <li key={item.step} className="flex flex-col gap-2 bg-fd-card p-5">
              <span className="font-medium">{item.step}</span>
              <span className="text-sm text-fd-muted-foreground">{item.body}</span>
            </li>
          ))}
        </ol>
        <p className="max-w-2xl text-sm text-fd-muted-foreground">
          Your application runs the agent and keeps its model provider credentials. Acclimate stores
          bundles, versions and releases.
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
