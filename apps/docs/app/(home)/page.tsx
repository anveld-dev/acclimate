import Link from 'next/link';
import type { Metadata } from 'next';
import { AcclimateMark } from '@/components/mark';
import { githubUrl as github } from '@/lib/layout.shared';
import { gitConfig } from '@/lib/shared';
import { previewMetadata } from '@/lib/metadata';
import { run } from './climb';
import { homeDescription } from './copy';
import { Climb } from './climb-chart';
import { CodeBlock, type Snippet } from './code-block';
import './landing.css';

const pageTitle = 'Acclimate: agent instructions that improve themselves';

export const metadata: Metadata = {
  title: { absolute: pageTitle },
  description: homeDescription,
  ...previewMetadata({ title: pageTitle, description: homeDescription, path: '/' }),
};

const example = `${github}/tree/${gitConfig.branch}/examples/gear-returns`;
const license = `${github}/blob/${gitConfig.branch}/LICENSE`;
const paper = 'https://arxiv.org/abs/2611.18856';

const sdk: Snippet[] = [
  {
    id: 'ts',
    label: 'TypeScript',
    title: 'agent.ts',
    language: 'ts',
    code: `import { createAcclimate, systemPrompt } from '@anveld/acclimate-sdk';

const acclimate = createAcclimate();
const job = await acclimate.job('Gear returns', {
  channel: 'stable',
});
const prompt = systemPrompt(job.version.payload);
const reply = await runAgent(prompt, request);`,
  },
  {
    id: 'py',
    label: 'Python',
    title: 'agent.py',
    language: 'py',
    code: `from acclimate import Acclimate, system_prompt

acclimate = Acclimate.from_env()
job = acclimate.job('Gear returns', channel='stable')
prompt = system_prompt(job.version['payload'])
reply = run_agent(prompt, request)`,
  },
];

const laptop: Snippet = {
  id: 'laptop',
  label: 'Terminal',
  title: 'Run Acclimate locally',
  language: 'sh',
  code: `git clone ${github}.git
cd acclimate
npm run local:up`,
};

function Arrow() {
  return (
    <span className="lp-arrow" aria-hidden="true">
      →
    </span>
  );
}

export default function HomePage() {
  return (
    <div className="lp">
      <section className="lp-hero" aria-labelledby="hero-heading">
        <div className="lp-wrap lp-hero-grid">
          <div className="lp-hero-text">
            <p className="lp-eyebrow lp-hero-eyebrow lp-rise">Open source · Self-hosted</p>
            <h1 id="hero-heading" className="lp-rise">
              <span>Agent instructions</span> <span>that improve</span> <span>themselves.</span>
            </h1>
            <p className="lp-lede lp-rise">{homeDescription}</p>
            <div className="lp-actions lp-rise">
              <Link href="/docs/get-started/quickstart" className="lp-button">
                Quickstart <Arrow />
              </Link>
              <Link href="/docs" className="lp-link">
                Read the docs
              </Link>
            </div>
          </div>

          <figure className="lp-proof lp-rise" aria-labelledby="proof-label">
            <Climb />
            <figcaption className="lp-fine">
              Synthetic data · {run.trainTasks} labelled tasks · {run.taskModel} ·{' '}
              <a href={example}>examples/gear-returns</a>
            </figcaption>
          </figure>
        </div>
      </section>

      <section className="lp-beat" aria-labelledby="how-heading">
        <div className="lp-wrap lp-beat-grid">
          <div className="lp-index">
            <span className="lp-eyebrow">How it works</span>
            <span className="lp-eyebrow">01 Release · 02 Evaluate · 03 Learn</span>
          </div>
          <h2 id="how-heading" className="lp-beat-title">
            Release it like code. <span className="lp-soft">Improve it from evals.</span>
          </h2>
          <div className="lp-beat-text">
            <p className="lp-body">
              Publish instructions, skills and memory as a versioned bundle. Each job fetches the
              release on its channel and records the exact version it ran, so shipping takes no
              deploy and rolling back is one call.
            </p>
            <p className="lp-body">
              Import labelled evaluation tasks or author them in the console. The loop, after{' '}
              <a href={paper}>Self-Improvement Memory</a>, proposes candidate rewrites, filters them
              against noise and token budgets, and releases the winner. Held-out tasks score every
              release, and a confirmed drop rolls it back automatically.
            </p>
            <p className="lp-aside">
              Learning scores a single model call without tools, so it tunes the prompt, not
              multi-step tool use.
            </p>
          </div>
          <div className="lp-beat-code">
            <CodeBlock snippets={sdk} />
          </div>
        </div>
      </section>

      <section className="lp-run" aria-labelledby="run-heading">
        <div className="lp-wrap">
          <p className="lp-eyebrow">Get started</p>
          <h2 id="run-heading">
            Run it on your laptop. <span className="lp-soft">Self-host it for your team.</span>
          </h2>
          <CodeBlock snippets={[laptop]} terminal />
          <div className="lp-actions">
            <Link href="/docs/get-started/quickstart" className="lp-button">
              Quickstart <Arrow />
            </Link>
            <Link href="/docs/operate/self-host" className="lp-link">
              Self-host guide
            </Link>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-row">
          <Link href="/" className="lp-footer-brand">
            <AcclimateMark className="lp-footer-mark" />
            Acclimate
          </Link>
          <nav aria-label="Footer" className="lp-footer-links">
            <Link href="/docs">Docs</Link>
            <a href={github}>GitHub</a>
            <a href={paper}>Paper</a>
            <a href={license}>Apache-2.0</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
