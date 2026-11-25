import Link from 'next/link';

const delivery = [
  {
    step: 'Version',
    body: 'Save instructions, skills and memory files as an immutable version of a bundle.',
  },
  {
    step: 'Release',
    body: 'Point a channel such as stable at a version, or roll back to an earlier one.',
  },
  {
    step: 'Deliver',
    body: 'Each new job fetches the released version, verifies it and prepares its files for your agent.',
  },
];

const entries = [
  {
    title: 'Quickstart',
    href: '/docs/get-started/quickstart',
    body: 'Start a local stack and deliver a verified version to your application.',
  },
  {
    title: 'First learning round',
    href: '/docs/get-started/first-learning-round',
    body: 'Connect a model and run a first round on 64 sample tickets.',
  },
  {
    title: 'Deliver content to jobs',
    href: '/docs/guides/deliver-content',
    body: 'Prepare the released version each time your application starts a job.',
  },
  {
    title: 'Run a learning loop',
    href: '/docs/guides/learning-loop',
    body: 'Add tasks to a bundle, start learning and follow each round.',
  },
  {
    title: 'Examples',
    href: '/docs/examples',
    body: 'Run a support agent and a ticket router in TypeScript or Python.',
  },
  {
    title: 'Integrations',
    href: '/docs/integrations/codex',
    body: 'Prepare content for Codex, the Claude Agent SDK, Pi and Cursor.',
  },
  {
    title: 'Self-host',
    href: '/docs/operate/self-host',
    body: 'Deploy the service with PostgreSQL, Keycloak and TLS.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-4 py-16 md:py-24">
      <section className="flex flex-col gap-6">
        <p className="text-sm font-medium text-fd-muted-foreground">Acclimate documentation</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
          Version, deliver and improve your agent’s instructions, skills and memory.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground text-pretty">
          Acclimate stores those files as versioned bundles and delivers the released version to
          each job your application starts. Its learning loop improves a bundle from example tasks
          and releases the changes that score better.
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
