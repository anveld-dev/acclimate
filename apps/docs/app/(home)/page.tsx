import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Instrument_Serif } from 'next/font/google';
import { gitConfig } from '@/lib/shared';
import { run, stages } from './climb';
import { Climb } from './climb-chart';
import './landing.css';

export const metadata: Metadata = {
  title: { absolute: 'Acclimate: agent instructions that improve themselves' },
};

const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--lp-display',
});
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: '400', variable: '--lp-mono' });

const github = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const example = `${github}/tree/main/examples/gear-returns`;

const snippet = `import { createAcclimate, systemPrompt } from '@acclimate/sdk';

const acclimate = createAcclimate();
const job = await acclimate.job('Gear returns', {
  channel: 'stable',
  input: request,
});
const prompt = systemPrompt(job.version.payload);
const reply = await runAgent(prompt, request);

// A correction becomes a new task.
await job.expect(correctedReply, { output: reply });`;

const selfHost = `git clone ${github}.git
cd acclimate
deploy/init.sh --domain example.com \\
  --email you@example.com
docker compose up -d --build --wait`;

const reasons = [
  ['Release without a deploy', 'The next job runs the new version. Rolling back is one call.'],
  ['Know what ran', 'Each job pins a version, identified by a digest of its exact bytes.'],
  ['Improve automatically', 'The loop writes changes and reverts a release whose held-out score drops.'],
  ['One honest limit', 'Learning scores one model call with no tools. It tunes the prompt, not tool use.'],
];

// Minimal highlighting for the snippets: comments, strings and a few keywords.
function highlight(code: string): ReactNode[] {
  const pattern =
    /(\/\/[^\n]*)|('[^'\n]*')|\b(import|from|const|await)\b|(--[a-z-]+)|^(git|cd|deploy\/init\.sh|docker)\b/gm;
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

function Code({ name, code }: { name: string; code: string }) {
  return (
    <figure className="lp-code">
      <figcaption className="lp-code-bar">{name}</figcaption>
      {/* Focusable so keyboard users can scroll a long line. */}
      <pre tabIndex={0} aria-label={name}>
        <code>{highlight(code)}</code>
      </pre>
    </figure>
  );
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export default function HomePage() {
  const first = stages[0];
  const final = stages[stages.length - 1];
  return (
    <div className={`lp ${display.variable} ${mono.variable}`}>
      <section className="lp-hero">
        <div className="lp-contours" aria-hidden="true" />
        <div className="lp-wrap">
          <h1 className="lp-title lp-rise">
            Agent instructions that <em>improve themselves.</em>
          </h1>
          <div className="lp-hero-row">
            <p className="lp-lede lp-rise" style={{ animationDelay: '80ms' }}>
              Acclimate versions your agent’s instructions, skills and memory and delivers each release to the next
              job. A learning loop rewrites them against your labelled tasks.
            </p>
            <div className="lp-hero-actions lp-rise" style={{ animationDelay: '160ms' }}>
              <div className="lp-actions">
                <Link href="/docs/get-started/quickstart" className="lp-button lp-button-primary">
                  Quickstart <span aria-hidden="true">→</span>
                </Link>
                <a href={github} className="lp-button">
                  GitHub
                </a>
              </div>
              <p className="lp-meta">
                Open source · Self-hosted · <a href={`${github}/releases/tag/v0.1.0`}>v0.1.0</a>
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-wrap lp-proof" aria-labelledby="proof-heading">
        <div className="lp-proof-head lp-rise" style={{ animationDelay: '240ms' }}>
          <h2 id="proof-heading" className="lp-h2">
            {percent(first.passRate)} to {percent(final.passRate)} on tasks it never saw.
          </h2>
          <p className="lp-body">
            {run.story} Pick a batch to read what was released.
          </p>
        </div>
        <Climb />
        <p className="lp-fineprint">
          {run.details} <a href={example}>Reproduce it</a>
        </p>
      </section>

      <section className="lp-wrap lp-section lp-split" aria-labelledby="git-heading">
        <div>
          <h2 id="git-heading" className="lp-h2">
            Why not keep prompts in git?
          </h2>
          <p className="lp-body">Keep them there and publish from CI. Acclimate adds:</p>
          <dl className="lp-reasons">
            {reasons.map(([term, detail]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Code name="agent.ts" code={snippet} />
      </section>

      <section className="lp-summit" aria-labelledby="summit-heading">
        <div className="lp-contours" aria-hidden="true" />
        <div className="lp-wrap lp-summit-grid">
          <div className="lp-summit-copy">
            <h2 id="summit-heading" className="lp-summit-title">
              Run it on your own server.
            </h2>
            <div className="lp-actions">
              <Link href="/docs/get-started/quickstart" className="lp-button lp-button-lichen">
                Try it on your laptop <span aria-hidden="true">→</span>
              </Link>
              <Link href="/docs/operate/self-host" className="lp-summit-link">
                Self-host guide
              </Link>
            </div>
          </div>
          <Code name="shell" code={selfHost} />
        </div>
      </section>
    </div>
  );
}
