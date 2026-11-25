import Link from 'next/link';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Instrument_Serif } from 'next/font/google';
import { contours } from '@/components/landing-contours';
import { gitConfig } from '@/lib/shared';
import './landing.css';

const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--lp-display',
});
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--lp-mono' });

const github = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

const snippet = `import { createAcclimate, systemPrompt } from '@acclimate/sdk';

// Reads ACCLIMATE_URL, _WORKSPACE and _TOKEN.
const acclimate = createAcclimate();

// Each job pins the version released on its channel.
const job = await acclimate.job('Support agent', {
  channel: 'stable',
  input: request,
});
const prompt = systemPrompt(job.version.payload);
const reply = await runAgent(prompt, request);

// A correction becomes a task the loop learns from.
await job.expect(correctedReply, { output: reply });`;

const selfHost = `git clone ${github}.git
cd acclimate
deploy/init.sh --domain example.com \\
  --email you@example.com
docker compose up -d --build --wait`;

const trail = [
  {
    name: 'Version',
    body: 'Instructions, skills and memory files become an immutable version, identified by a digest of its exact bytes.',
    detail: 'sha256:10f60b34…',
  },
  {
    name: 'Release',
    body: 'Point a channel such as stable at a version. Rolling back is one call.',
    detail: 'stable → version 14',
  },
  {
    name: 'Deliver',
    body: 'Each job resolves the channel, verifies the digest and keeps that version until it ends.',
    detail: 'job.version',
  },
  {
    name: 'Learn',
    body: 'Rounds propose changes, score them on your tasks and release the best one. Held-out tasks measure every release.',
    detail: 'round 3 · adopted',
  },
];

const next = [
  {
    title: 'Quickstart',
    href: '/docs/get-started/quickstart',
    body: 'Start a local stack and deliver a verified version to an application.',
  },
  {
    title: 'Run your first learning round',
    href: '/docs/tutorials/first-learning-round',
    body: 'Connect a model and run the round charted above on 64 sample tickets.',
  },
  {
    title: 'Improve a support agent',
    href: '/docs/tutorials/support-agent',
    body: 'Run an application on a released bundle and teach it with corrections.',
  },
  {
    title: 'Deliver content to jobs',
    href: '/docs/guides/deliver-content',
    body: 'Prepare the released version each time your application starts a job.',
  },
  {
    title: 'Use a coding agent',
    href: '/docs/guides/coding-agents',
    body: 'Prepare bundles for Codex, the Claude Agent SDK, Pi and Cursor.',
  },
  {
    title: 'Self-host',
    href: '/docs/operate/self-host',
    body: 'Run the service, console and sign-in on one host with Docker Compose.',
  },
];

// Minimal highlighting for the two snippets: comments, strings and a few keywords.
function highlight(code: string): ReactNode[] {
  const pattern =
    /(\/\/[^\n]*)|('[^'\n]*')|\b(import|from|const|await)\b|(--[a-z-]+)|^(git|deploy\/init\.sh|docker)\b/gm;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push(code.slice(last, index));
    const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'keyword' : match[4] ? 'flag' : 'command';
    out.push(
      <span key={index} className={`lp-tok-${kind}`}>
        {match[0]}
      </span>,
    );
    last = index + match[0].length;
  }
  out.push(code.slice(last));
  return out;
}

function Contours() {
  return (
    <svg className="lp-contours" viewBox="0 0 1400 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {contours.map((ring, index) => (
        <path key={index} d={ring.d} className={ring.kind === 'index' ? 'lp-contour-index' : undefined} />
      ))}
    </svg>
  );
}

// The ticket-triage run from the first-learning-round tutorial, as an elevation profile.
const climb = [
  { label: 'Start', evolve: 0, heldOut: null, note: 'Before' },
  { label: 'Round 1', evolve: 100, heldOut: 100, note: 'Adopted' },
  { label: 'Round 2', evolve: 100, heldOut: 100, note: 'Kept' },
  { label: 'Round 3', evolve: 100, heldOut: 100, note: 'Adopted' },
];

function ClimbChart() {
  const width = 640;
  const height = 300;
  const left = 64;
  const right = 44;
  const top = 28;
  const bottom = 56;
  const x = (i: number) => left + (i * (width - left - right)) / (climb.length - 1);
  const y = (value: number) => top + ((100 - value) * (height - top - bottom)) / 100;
  const ridge = climb.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(point.evolve)}`).join(' ');
  const area = `${ridge} L${x(climb.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`;
  return (
    <svg className="lp-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="climb-title climb-desc">
      <title id="climb-title">Evolve and held-out pass rates by round</title>
      <desc id="climb-desc">
        Evolve pass rate rose from 0 percent with the starting instructions to 100 percent in round 1 and stayed
        there in rounds 2 and 3. The held-out pass rate was 100 percent in all three rounds.
      </desc>
      {[0, 50, 100].map((tick) => (
        <g key={tick}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="lp-chart-grid" />
          <text x={left - 12} y={y(tick) + 4} textAnchor="end" className="lp-chart-axis">
            {tick}%
          </text>
        </g>
      ))}
      <path d={area} className="lp-chart-area" />
      <path d={ridge} className="lp-chart-ridge" pathLength={1} />
      {climb.map((point, i) => (
        <g key={point.label}>
          <circle cx={x(i)} cy={y(point.evolve)} r={5} className="lp-chart-evolve" />
          {point.heldOut !== null && (
            <rect x={x(i) - 5} y={y(point.heldOut) - 19} width={10} height={10} className="lp-chart-heldout" />
          )}
          <text x={x(i)} y={height - bottom + 24} textAnchor="middle" className="lp-chart-label">
            {point.label}
          </text>
          <text x={x(i)} y={height - bottom + 42} textAnchor="middle" className="lp-chart-axis">
            {point.note}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function HomePage() {
  return (
    <div className={`lp ${display.variable} ${mono.variable}`}>
      <section className="lp-hero">
        <Contours />
        <div className="lp-wrap lp-hero-grid">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow lp-rise" style={{ animationDelay: '0ms' }}>
              <span className="lp-dot" /> Open source · Apache-2.0 · v0.1.0
            </p>
            <h1 className="lp-title lp-rise" style={{ animationDelay: '80ms' }}>
              Agent instructions that ship like code, and <em>get better on their own.</em>
            </h1>
            <p className="lp-lede lp-rise" style={{ animationDelay: '160ms' }}>
              Acclimate versions your agent’s instructions, skills and memory, delivers the released version to every
              job, and runs a learning loop that proposes, scores and releases improvements against your own tasks.
            </p>
            <div className="lp-actions lp-rise" style={{ animationDelay: '240ms' }}>
              <Link href="/docs/get-started/quickstart" className="lp-button lp-button-primary">
                Start the quickstart <span aria-hidden="true">→</span>
              </Link>
              <Link href="/docs" className="lp-button">
                Read the docs
              </Link>
              <a href={github} className="lp-link">
                GitHub
              </a>
            </div>
          </div>
          <figure className="lp-code lp-rise" style={{ animationDelay: '320ms' }}>
            <figcaption className="lp-code-bar">
              <span className="lp-code-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              agent.ts
            </figcaption>
            <pre>
              <code>{highlight(snippet)}</code>
            </pre>
          </figure>
        </div>
      </section>

      <section className="lp-wrap lp-section" aria-labelledby="trail-heading">
        <div className="lp-section-head">
          <p className="lp-kicker">How it works</p>
          <h2 id="trail-heading" className="lp-h2">
            One loop, from a file to a better file.
          </h2>
        </div>
        <ol className="lp-trail">
          {trail.map((step, index) => (
            <li key={step.name} className="lp-waypoint">
              <span className="lp-waypoint-mark" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="lp-waypoint-name">{step.name}</h3>
              <p className="lp-waypoint-body">{step.body}</p>
              <code className="lp-waypoint-detail">{step.detail}</code>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-climb" aria-labelledby="climb-heading">
        <div className="lp-wrap lp-climb-grid">
          <div>
            <p className="lp-kicker">Measured, not promised</p>
            <h2 id="climb-heading" className="lp-h2">
              One round took a triage agent from <em>0%</em> to <em>100%</em>.
            </h2>
            <dl className="lp-stats">
              <div>
                <dt>Evolve pass rate</dt>
                <dd>0 → 100%</dd>
              </div>
              <div>
                <dt>Held-out tickets it never saw</dt>
                <dd>100%</dd>
              </div>
              <div>
                <dt>Rollouts in round 1, in 14 minutes</dt>
                <dd>1,280</dd>
              </div>
            </dl>
            <p className="lp-fineprint">
              The <Link href="/docs/tutorials/first-learning-round">first-learning-round tutorial</Link>: 64 labelled
              tickets, split into 32 evolve and 32 held-out tasks. Round 2 kept the version and round 3 adopted a shorter wording that scored the same. Not every round generalizes, and held-out tasks are
              how you find out. The <Link href="/docs/tutorials/support-agent">support agent tutorial</Link> shows a
              round that fit its evolve tasks but not its held-out ones, and how to close the gap.
            </p>
          </div>
          <figure className="lp-chart-card">
            <ClimbChart />
            <figcaption className="lp-legend">
              <span>
                <i className="lp-legend-evolve" /> Evolve tasks
              </span>
              <span>
                <i className="lp-legend-heldout" /> Held-out tasks
              </span>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="lp-wrap lp-section lp-split" aria-labelledby="fit-heading">
        <div>
          <p className="lp-kicker">Where it fits</p>
          <h2 id="fit-heading" className="lp-h2">
            Your agent stays yours.
          </h2>
          <p className="lp-body">
            Acclimate never runs your application. It hands each job a verified copy of the released files, and the
            learning loop works on copies in sandboxes.
          </p>
          <ul className="lp-chips" aria-label="Integrations">
            {['TypeScript SDK', 'Python SDK', 'Codex', 'Claude Agent SDK', 'Pi', 'Cursor', 'HTTP API'].map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        </div>
        <div className="lp-ledger">
          <div>
            <h3>Your application</h3>
            <ul>
              <li>Runs the agent and decides when a job starts</li>
              <li>Keeps its own model provider credentials</li>
              <li>Sends corrections when an answer was wrong</li>
            </ul>
          </div>
          <div>
            <h3>Acclimate</h3>
            <ul>
              <li>Stores bundles, versions and releases</li>
              <li>Delivers and verifies the released version for each job</li>
              <li>Runs learning rollouts in sandboxes, on models a workspace admin allows</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="lp-wrap lp-section lp-split" aria-labelledby="host-heading">
        <div>
          <p className="lp-kicker">Self-hosted</p>
          <h2 id="host-heading" className="lp-h2">
            Three commands to your own instance.
          </h2>
          <p className="lp-body">
            The service, console, PostgreSQL, Keycloak sign-in and TLS on one host with Docker Compose. Turning on
            learning adds the sandboxed executor.
          </p>
          <Link href="/docs/operate/self-host" className="lp-link">
            Self-host Acclimate →
          </Link>
        </div>
        <figure className="lp-code lp-code-terminal">
          <figcaption className="lp-code-bar">
            <span className="lp-code-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            shell
          </figcaption>
          <pre>
            <code>{highlight(selfHost)}</code>
          </pre>
        </figure>
      </section>

      <section className="lp-wrap lp-section" aria-labelledby="next-heading">
        <div className="lp-section-head">
          <p className="lp-kicker">Where to go next</p>
          <h2 id="next-heading" className="lp-h2">
            Pick a trail.
          </h2>
        </div>
        <ol className="lp-index">
          {next.map((entry, index) => (
            <li key={entry.href}>
              <Link href={entry.href}>
                <span className="lp-index-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="lp-index-title">{entry.title}</span>
                <span className="lp-index-body">{entry.body}</span>
                <span className="lp-index-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section className="lp-summit" aria-labelledby="summit-heading">
        <Contours />
        <div className="lp-wrap lp-summit-inner">
          <h2 id="summit-heading" className="lp-summit-title">
            Deliver your first version in a few minutes.
          </h2>
          <Link href="/docs/get-started/quickstart" className="lp-button lp-button-lichen">
            Start the quickstart <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
