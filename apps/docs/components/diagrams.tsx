import type { ReactNode } from 'react';

// Hand-drawn diagrams for the docs. Colours come from the theme's variables, so each
// diagram follows the light and dark themes. Labels stay short; the caption under each
// figure carries the explanation. Connectors run on a grid with rounded corners.

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const border = 'var(--color-fd-border)';
const card = 'var(--color-fd-card)';
const page = 'var(--color-fd-background)';
const zone = 'var(--color-fd-muted)';
const accent = 'var(--color-fd-info)';
const warn = 'var(--color-fd-error)';
const good = 'var(--color-fd-success)';
const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)';

type Tone = 'default' | 'accent' | 'warn' | 'good';
type Point = [number, number];

const toneColor = (tone: Tone, fallback: string) =>
  tone === 'accent' ? accent : tone === 'warn' ? warn : tone === 'good' ? good : fallback;

function Figure({
  width,
  height,
  label,
  caption,
  children,
}: {
  width: number;
  height: number;
  label: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="not-prose my-8">
      <div className="rounded-xl border bg-fd-card/40 p-3 sm:p-5">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label}
          className="mx-auto h-auto w-full"
          style={{ maxWidth: width, fontFamily: 'inherit' }}
        >
          {children}
        </svg>
      </div>
      <figcaption className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

/** A shaded region, such as a process or a network, with a small label in its corner. */
function Zone({ x, y, w, h, label, note }: { x: number; y: number; w: number; h: number; label: string; note?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} fill={zone} fillOpacity={0.7} stroke={border} strokeOpacity={0.9} />
      <text x={x + 14} y={y + 22} fontSize={10.5} fontWeight={650} letterSpacing={0.9} fill={muted}>
        {label.toUpperCase()}
        {note && (
          <tspan fontWeight={400} letterSpacing={0.2} dx={8}>
            {note}
          </tspan>
        )}
      </text>
    </g>
  );
}

function Box({
  x,
  y,
  w,
  h,
  title,
  sub = [],
  code = false,
  tone = 'default',
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string[];
  code?: boolean;
  tone?: Tone;
}) {
  const lines = 1 + sub.length;
  const first = y + h / 2 - ((lines - 1) * 15) / 2 + 4.5;
  const edge = toneColor(tone, border);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={card} stroke={edge} strokeWidth={tone === 'default' ? 1 : 1.5} />
      {tone !== 'default' && <rect x={x} y={y + 8} width={3} height={h - 16} rx={1.5} fill={edge} />}
      <text
        x={x + w / 2}
        y={first}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        fill={ink}
        fontFamily={code ? mono : undefined}
      >
        {title}
      </text>
      {sub.map((text, i) => (
        <text key={text} x={x + w / 2} y={first + 15 * (i + 1)} textAnchor="middle" fontSize={11} fill={muted}>
          {text}
        </text>
      ))}
    </g>
  );
}

/** A path through the given points, with rounded corners and an arrowhead at the end. */
function Line({
  points,
  tone = 'default',
  dashed = false,
  head = true,
}: {
  points: Point[];
  tone?: Tone;
  dashed?: boolean;
  head?: boolean;
}) {
  const color = toneColor(tone, muted);
  const r = 8;
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    const next = points[i + 1];
    if (!next) {
      d += ` L${x} ${y}`;
      break;
    }
    const [px, py] = points[i - 1];
    const inLen = Math.hypot(x - px, y - py);
    const outLen = Math.hypot(next[0] - x, next[1] - y);
    const k = Math.min(r, inLen / 2, outLen / 2);
    const ax = x - ((x - px) / inLen) * k;
    const ay = y - ((y - py) / inLen) * k;
    const bx = x + ((next[0] - x) / outLen) * k;
    const by = y + ((next[1] - y) / outLen) * k;
    d += ` L${ax} ${ay} Q${x} ${y} ${bx} ${by}`;
  }
  const [x1, y1] = points[points.length - 2];
  const [x2, y2] = points[points.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1);
  const tip = (len: number, t: number) => `${x2 - len * Math.cos(a + t)},${y2 - len * Math.sin(a + t)}`;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={dashed ? '4 4' : undefined}
      />
      {head && <polygon points={`${x2},${y2} ${tip(8, 0.42)} ${tip(8, -0.42)}`} fill={color} />}
    </g>
  );
}

function Label({
  x,
  y,
  anchor = 'middle',
  tone = 'default',
  children,
}: {
  x: number;
  y: number;
  anchor?: 'start' | 'middle' | 'end';
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={11}
      fontWeight={tone === 'default' ? 400 : 550}
      fill={tone === 'default' ? muted : toneColor(tone, muted)}
    >
      {children}
    </text>
  );
}

/** A numbered step marker. */
function Step({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={8.5} fill={accent} />
      <text x={x} y={y + 3.8} textAnchor="middle" fontSize={10.5} fontWeight={700} fill={page}>
        {n}
      </text>
    </g>
  );
}

/** A blocked crossing: a circle with a cross, on a line that must never carry data. */
function Blocked({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={9} fill={page} stroke={warn} strokeWidth={1.5} />
      <path
        d={`M${x - 3.5} ${y - 3.5} L${x + 3.5} ${y + 3.5} M${x + 3.5} ${y - 3.5} L${x - 3.5} ${y + 3.5}`}
        stroke={warn}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </g>
  );
}

export function DeliveryDiagram() {
  return (
    <Figure
      width={760}
      height={300}
      label="A workspace holds a bundle and a connection. A release points the stable channel at a version. A job resolves the channel through its connection, downloads that version, verifies its digest and can report a receipt."
      caption={
        <>
          A release points a channel at one immutable version, and rolling back is a new release that points it at an
          earlier one. Each job resolves the channel through its connection, downloads and verifies that version, and
          keeps it until the job ends.
        </>
      }
    >
      <Zone x={10} y={10} w={466} h={280} label="Workspace" />
      <Zone x={26} y={42} w={270} h={232} label="Bundle" />
      <Box x={42} y={70} w={120} h={46} title="Version 1" sub={['sha256:4a1e…']} />
      <Box x={42} y={128} w={120} h={46} title="Version 2" sub={['sha256:9ba1…']} />
      <Box x={42} y={186} w={120} h={46} title="Version 3" sub={['sha256:7073…']} />
      <Box x={206} y={186} w={74} h={46} title="stable" sub={['channel']} code />
      <Line points={[[206, 209], [162, 209]]} tone="accent" />
      <Label x={184} y={202} tone="accent">
        current
      </Label>
      <Line points={[[243, 186], [243, 151], [162, 151]]} dashed />
      <Label x={250} y={170} anchor="start">
        earlier
      </Label>

      <Box x={312} y={128} w={140} h={104} title="Connection" sub={['names bundle + channel', 'connection credential', 'receipt credential']} />
      <Line points={[[312, 209], [280, 209]]} />

      <Zone x={500} y={10} w={250} h={280} label="Your application" />
      <Box x={566} y={128} w={164} h={104} title="Job" sub={['the version’s files', 'in a private directory']} />

      <Line points={[[566, 150], [452, 150]]} tone="accent" />
      <Step x={540} y={140} n={1} />
      <Label x={509} y={168}>
        resolve channel
      </Label>
      <Line points={[[102, 232], [102, 262], [648, 262], [648, 232]]} tone="accent" />
      <Step x={372} y={262} n={2} />
      <Label x={388} y={279} anchor="start">
        download, verify digest
      </Label>
      <Line points={[[566, 212], [452, 212]]} dashed />
      <Step x={540} y={202} n={3} />
      <Label x={509} y={228}>
        receipt (optional)
      </Label>
    </Figure>
  );
}

export function RoundDiagram() {
  const x = 150;
  const w = 236;
  const h = 46;
  const gap = 22;
  const y = (i: number) => 16 + i * (h + gap);
  const mid = (i: number) => y(i) + h / 2;
  const cx = x + w / 2;
  const states: [string, string][] = [
    ['scoring_incumbent', 'score the current version'],
    ['proposing', 'the optimizer writes five candidates'],
    ['screening', 'secrets scan, hard-coding check'],
    ['evaluating', 'score the candidates that pass'],
    ['selecting', 'adopt one or keep the current version'],
    ['scoring_held_out', 'score the version on the channel'],
    ['completed', 'run another round or wait'],
  ];
  const side = 476;
  const sw = 264;
  return (
    <Figure
      width={760}
      height={y(6) + h + 16}
      label="A round moves through scoring_incumbent, proposing, screening, evaluating, selecting and scoring_held_out to completed. It fails if the current version cannot be scored, skips to held-out scoring when no candidate survives, releases an adopted candidate at once, and restores the previous version after a confirmed held-out drop."
      caption={
        <>
          Each box is a value of the round&apos;s <code>activeRound.state</code> in the API. A round with no
          candidates, or none that pass screening, keeps the current version and goes straight to held-out scoring. A
          stop request can end a round at any step, as <code>stopped</code>.
        </>
      }
    >
      {states.map(([state, note], i) => (
        <Box key={state} x={x} y={y(i)} w={w} h={h} title={state} sub={[note]} code tone={i === 6 ? 'good' : 'default'} />
      ))}
      {states.slice(0, -1).map(([state], i) => (
        <Line key={state} points={[[cx, y(i) + h], [cx, y(i + 1)]]} />
      ))}

      <Line points={[[x, mid(2)], [x - 30, mid(2)], [x - 30, mid(5)], [x, mid(5)]]} dashed />
      <Label x={x - 40} y={mid(3) + 10} anchor="end">
        nothing
      </Label>
      <Label x={x - 40} y={mid(3) + 24} anchor="end">
        survives
      </Label>

      <Box x={side} y={y(0)} w={sw} h={h} title="Round fails" sub={['incumbent-evaluation-failed']} tone="warn" />
      <Line points={[[x + w, mid(0)], [side, mid(0)]]} tone="warn" />
      <Label x={(x + w + side) / 2} y={mid(0) - 8} tone="warn">
        cannot score
      </Label>
      <Label x={side + sw / 2} y={y(0) + h + 16}>
        provider-unavailable is retried later
      </Label>

      <Box x={side} y={y(4)} w={sw} h={h} title="Release to the channel" sub={['at once, with no approval step']} tone="accent" />
      <Line points={[[x + w, mid(4)], [side, mid(4)]]} tone="accent" />
      <Label x={(x + w + side) / 2} y={mid(4) - 8} tone="accent">
        adopt
      </Label>

      <Box x={side} y={y(5) + 34} w={sw} h={h} title="Restore the previous version" sub={['a clear drop, measured twice']} tone="warn" />
      <Line points={[[x + w, mid(5)], [430, mid(5)], [430, y(5) + 34 + h / 2], [side, y(5) + 34 + h / 2]]} tone="warn" />
      <Label x={438} y={mid(5) - 8} anchor="start" tone="warn">
        held-out drop
      </Label>
    </Figure>
  );
}

export function TrustDiagram() {
  return (
    <Figure
      width={760}
      height={400}
      label="The optimizer receives the bundle, improvement memory and evolve results, never held-out tasks. The executor receives tasks from both splits and the provider key, and its sandboxes reach the model provider only through the gateway. Your application's model credentials never reach Acclimate."
      caption={
        <>
          Held-out tasks go only to the executor, which grades rollouts outside the sandbox. The sandbox gets the
          bundle and the task input, and its only way out is the gateway. Your application calls its own model with
          its own credentials, which never reach Acclimate.
        </>
      }
    >
      <Zone x={10} y={10} w={196} h={256} label="Your application" />
      <Box x={30} y={116} w={156} h={52} title="Agent" sub={['runs each job']} />
      <Box x={30} y={300} w={156} h={52} title="Your model" sub={['your own credentials']} />
      <Line points={[[108, 168], [108, 300]]} />

      <Zone x={226} y={10} w={270} h={256} label="Acclimate service" />
      <Box x={252} y={44} w={228} h={42} title="Bundles and versions" />
      <Box x={252} y={98} w={228} h={42} title="Evolve tasks" />
      <Box x={252} y={152} w={228} h={46} title="Held-out tasks" sub={['stored separately']} />
      <Box x={366} y={210} w={114} h={42} title="API key" sub={['encrypted']} />
      <Line points={[[252, 65], [108, 65], [108, 116]]} tone="accent" />
      <Label x={180} y={57} tone="accent">
        released version
      </Label>

      <Box x={252} y={300} w={228} h={52} title="Optimizer model" sub={['the operator’s endpoint']} />
      <Line points={[[252, 119], [238, 119], [238, 326], [252, 326]]} tone="accent" />
      <Label x={366} y={374}>
        bundle, memory and evolve results
      </Label>
      <Line points={[[310, 198], [310, 300]]} tone="warn" dashed />
      <Blocked x={310} y={246} />
      <Label x={322} y={282} anchor="start" tone="warn">
        never
      </Label>

      <Zone x={516} y={10} w={234} h={256} label="Executor" />
      <Box x={532} y={44} w={202} h={52} title="Grader" sub={['answers and criteria stay here']} />
      <Box x={532} y={112} w={202} h={52} title="Gateway" sub={['holds the key in memory']} />
      <Box x={532} y={190} w={202} h={52} title="Sandbox" sub={['bundle and input, no network']} />
      <Line points={[[480, 119], [498, 119], [498, 70], [532, 70]]} />
      <Line points={[[480, 175], [498, 175], [498, 119]]} head={false} />
      <Label x={506} y={88} anchor="start">
        both
      </Label>
      <Line points={[[480, 231], [508, 231], [508, 138], [532, 138]]} />
      <Line points={[[633, 190], [633, 164]]} />

      <Box x={532} y={300} w={202} h={52} title="Model provider" sub={['task and judge models']} />
      <Line points={[[734, 138], [744, 138], [744, 326], [734, 326]]} tone="accent" />
      <Label x={738} y={286} anchor="end" tone="accent">
        only way out
      </Label>
    </Figure>
  );
}

export function TopologyDiagram() {
  return (
    <Figure
      width={760}
      height={450}
      label="Caddy publishes ports 80 and 443 and routes the console and API hosts on the internal backend network. The executor joins the service on the internal executor network on port 3001, starts sandboxes through the host's Docker socket and reaches model providers over its own egress network."
      caption={
        <>
          Only Caddy publishes ports. The <code>backend</code> and <code>executor</code> networks are internal, so
          PostgreSQL and the executor listener have no route out. The console, the service and a co-hosted Keycloak
          reach the identity issuer, the optimizer and mail over a separate outbound network, and Caddy also serves
          Keycloak&apos;s sign-in pages. The Docker socket gives the executor administrator authority on the host.
        </>
      }
    >
      <Box x={10} y={125} w={112} h={56} title="Internet" sub={['browsers, apps']} />
      <Box x={150} y={125} w={112} h={56} title="Caddy" sub={['ports 80 and 443']} tone="accent" />
      <Line points={[[122, 153], [150, 153]]} tone="accent" />

      <Zone x={300} y={10} w={300} h={300} label="backend" note="internal" />
      <Box x={320} y={50} w={130} h={46} title="Console" sub={[':3100']} />
      <Box x={320} y={130} w={130} h={46} title="Service" sub={['API :3000']} />
      <Box x={480} y={130} w={104} h={46} title="PostgreSQL" sub={['no route out']} />
      <Line points={[[262, 136], [282, 136], [282, 73], [320, 73]]} tone="accent" />
      <Label x={276} y={104} anchor="end" tone="accent">
        console host
      </Label>
      <Line points={[[262, 153], [320, 153]]} tone="accent" />
      <Label x={295} y={146} tone="accent">
        API host
      </Label>
      <Line points={[[450, 153], [480, 153]]} />

      <Zone x={300} y={330} w={300} h={110} label="executor" note="internal" />
      <Box x={320} y={366} w={150} h={56} title="Executor" sub={['root, outbound access']} tone="warn" />
      <Line points={[[385, 366], [385, 176]]} />
      <Label x={393} y={322} anchor="start">
        :3001
      </Label>

      <Box x={630} y={50} w={120} h={56} title="Outbound" sub={['issuer, optimizer, mail']} />
      <Line points={[[450, 73], [630, 73]]} />
      <Label x={540} y={66}>
        outbound network
      </Label>

      <Box x={630} y={300} w={120} h={56} title="Host Docker" sub={['starts sandboxes']} tone="warn" />
      <Line points={[[470, 382], [612, 382], [612, 328], [630, 328]]} tone="warn" />
      <Label x={540} y={375} tone="warn">
        Docker socket
      </Label>
      <Box x={630} y={384} w={120} h={46} title="Model providers" />
      <Line points={[[470, 407], [630, 407]]} />
      <Label x={540} y={425}>
        executor-egress
      </Label>
    </Figure>
  );
}
