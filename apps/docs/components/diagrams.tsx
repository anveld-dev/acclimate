import type { ReactNode } from 'react';

// Hand-drawn diagrams for the docs. Colours come from the theme's variables, so each
// diagram follows the light and dark themes. Every label is short; the caption under
// each figure carries the explanation.

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const line = 'var(--color-fd-muted-foreground)';
const border = 'var(--color-fd-border)';
const card = 'var(--color-fd-card)';
const page = 'var(--color-fd-background)';
const warn = 'var(--color-fd-error)';

type Tone = 'default' | 'warn' | 'quiet';

function Figure({
  id,
  width,
  height,
  label,
  caption,
  children,
}: {
  id: string;
  width: number;
  height: number;
  label: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="not-prose my-8">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className="h-auto w-full"
        style={{ maxWidth: width, fontFamily: 'inherit' }}
      >
        {children}
      </svg>
      <figcaption className="mt-3 text-sm text-fd-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

// Arrowheads are polygons at the end of the path's last segment, so no ids are shared
// between the figures on a page.
function head(d: string, color: string) {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
  const [x1, y1, x2, y2] = n.slice(-4);
  const a = Math.atan2(y2 - y1, x2 - x1);
  const point = (r: number, t: number) => `${x2 - r * Math.cos(a + t)},${y2 - r * Math.sin(a + t)}`;
  return <polygon points={`${x2},${y2} ${point(9, 0.4)} ${point(9, -0.4)}`} fill={color} />;
}

function Box({
  x,
  y,
  w,
  h,
  title,
  lines = [],
  mono = false,
  tone = 'default',
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines?: string[];
  mono?: boolean;
  tone?: Tone;
}) {
  const count = 1 + lines.length;
  const first = y + h / 2 - ((count - 1) * 15) / 2 + 4;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={card}
        stroke={tone === 'warn' ? warn : border}
        strokeWidth={tone === 'warn' ? 1.5 : 1.25}
      />
      <text
        x={x + w / 2}
        y={first}
        textAnchor="middle"
        fontSize={13}
        fontWeight={600}
        fill={tone === 'warn' ? warn : ink}
        fontFamily={mono ? 'var(--font-mono, ui-monospace, monospace)' : undefined}
      >
        {title}
      </text>
      {lines.map((text, i) => (
        <text key={text} x={x + w / 2} y={first + 15 * (i + 1)} textAnchor="middle" fontSize={11.5} fill={muted}>
          {text}
        </text>
      ))}
    </g>
  );
}

function Zone({ x, y, w, h, label, note }: { x: number; y: number; w: number; h: number; label: string; note?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke={border} strokeWidth={1.25} strokeDasharray="5 4" />
      <text x={x + 12} y={y + 18} fontSize={11.5} fontWeight={600} fill={muted} letterSpacing={0.4}>
        {label}
        {note && (
          <tspan fontWeight={400} dx={6}>
            {note}
          </tspan>
        )}
      </text>
    </g>
  );
}

function Arrow({
  d,
  label,
  lx,
  ly,
  anchor = 'middle',
  dashed = false,
  tone = 'default',
}: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  anchor?: 'start' | 'middle' | 'end';
  dashed?: boolean;
  tone?: Tone;
}) {
  const color = tone === 'warn' ? warn : line;
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={dashed ? '5 4' : undefined}
      />
      {head(d, color)}
      {label && (
        <Label x={lx ?? 0} y={ly ?? 0} anchor={anchor} tone={tone}>
          {label}
        </Label>
      )}
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
      fontSize={11.5}
      fill={tone === 'warn' ? warn : muted}
      stroke={page}
      strokeWidth={4}
      strokeLinejoin="round"
      paintOrder="stroke"
    >
      {children}
    </text>
  );
}

export function DeliveryDiagram() {
  return (
    <Figure
      id="delivery"
      width={760}
      height={300}
      label="A workspace holds bundles and connections. A release points the stable channel at a version. A job resolves the channel through its connection, downloads that version and verifies its digest."
      caption={
        <>
          A release points a channel at one immutable version. Rolling back is a new release that points the channel
          at an earlier version. Each job resolves the channel through its connection, downloads and verifies that
          version, and keeps it until the job ends.
        </>
      }
    >
      <Zone x={10} y={10} w={496} h={280} label="WORKSPACE" />
      <Zone x={26} y={40} w={300} h={236} label="BUNDLE" />
      <Box x={40} y={66} w={86} h={48} title="Version 1" lines={['immutable']} />
      <Box x={138} y={66} w={86} h={48} title="Version 2" lines={['immutable']} />
      <Box x={236} y={66} w={86} h={48} title="Version 3" lines={['sha256 digest']} />
      <Box x={40} y={200} w={96} h={40} title="stable" mono />
      <Label x={88} y={258}>
        channel
      </Label>
      <Arrow d="M128 200 L276 116" label="current release" lx={222} ly={172} anchor="start" />
      <Arrow d="M92 200 L178 116" dashed label="earlier release" lx={104} ly={152} anchor="end" />
      <Box x={350} y={176} w={140} h={84} title="Connection" lines={['names bundle + channel', 'connection credential', 'receipt credential']} />
      <Arrow d="M350 220 L138 220" label="names" lx={248} ly={213} />

      <Zone x={530} y={10} w={220} h={280} label="YOUR APPLICATION" />
      <Box x={566} y={120} w={160} h={64} title="Job" lines={['the version’s files', 'in a private directory']} />
      <Arrow d="M566 172 L492 198" label="1 resolve channel" lx={606} ly={214} />
      <Arrow d="M324 90 L564 120" label="2 download, verify digest" lx={446} ly={92} />
      <Arrow d="M690 184 L690 250 L492 250" dashed label="3 receipt (optional)" lx={620} ly={270} />
    </Figure>
  );
}

export function RoundDiagram() {
  const x = 120;
  const w = 210;
  const h = 34;
  const rows = ['scoring_incumbent', 'proposing', 'screening', 'evaluating', 'selecting', 'scoring_held_out', 'completed'];
  const notes = [
    'current version scored',
    'five candidates written',
    'secrets scan, hard-coding check',
    'survivors scored',
    'adopt or keep',
    'held-out tasks scored',
  ];
  const y = (i: number) => 20 + i * 62;
  const mid = x + w / 2;
  const side = 500;
  return (
    <Figure
      id="round"
      width={760}
      height={440}
      label="A round moves through scoring_incumbent, proposing, screening, evaluating, selecting and scoring_held_out to completed. It fails if the current version cannot be scored, skips to held-out scoring when no candidate survives, releases an adopted candidate at once, and restores the previous version after a confirmed held-out drop."
      caption={
        <>
          The left column is the round&apos;s <code>activeRound.state</code> in the API. A round with no candidates,
          or none that pass screening, keeps the current version and goes straight to held-out scoring. A stop
          request can end a round at any step, as <code>stopped</code>.
        </>
      }
    >
      {rows.map((state, i) => (
        <Box key={state} x={x} y={y(i)} w={w} h={h} title={state} mono />
      ))}
      {notes.map((note, i) => (
        <g key={note}>
          <Arrow d={`M${mid} ${y(i) + h} L${mid} ${y(i + 1)}`} />
          <Label x={mid + 10} y={y(i + 1) - 10} anchor="start">
            {note}
          </Label>
        </g>
      ))}

      <Arrow d={`M${x} ${y(2) + h / 2} L${x - 22} ${y(2) + h / 2} L${x - 22} ${y(5) + h / 2} L${x} ${y(5) + h / 2}`} dashed />
      <Label x={x - 28} y={y(3) + 34} anchor="end">
        none
      </Label>
      <Label x={x - 28} y={y(3) + 49} anchor="end">
        survive
      </Label>

      <Box x={side} y={y(0) - 4} w={240} h={42} title="failed" mono tone="warn" lines={['incumbent-evaluation-failed']} />
      <Arrow d={`M${x + w} ${y(0) + h / 2} L${side} ${y(0) + h / 2}`} tone="warn" label="cannot score" lx={414} ly={y(0) + h / 2 - 7} />
      <Label x={side + 120} y={y(0) + 56}>
        or provider-unavailable, retried later
      </Label>

      <Box x={side} y={y(4) - 4} w={240} h={42} title="Release to the channel" lines={['at once, no approval step']} />
      <Arrow d={`M${x + w} ${y(4) + h / 2} L${side} ${y(4) + h / 2}`} label="adopt" lx={414} ly={y(4) + h / 2 - 7} />

      <Box x={side} y={y(5) + 30} w={240} h={56} title="Restore the previous version" lines={['after a clear drop that a', 'second measurement confirms']} tone="warn" />
      <Arrow d={`M${x + w} ${y(5) + h / 2} L420 ${y(5) + h / 2} L420 ${y(5) + 58} L${side} ${y(5) + 58}`} tone="warn" label="drop" lx={430} ly={y(5) + 51} anchor="start" />
    </Figure>
  );
}

export function TrustDiagram() {
  return (
    <Figure
      id="trust"
      width={760}
      height={380}
      label="The optimizer receives the bundle, improvement memory and evolve tasks, never held-out tasks. The executor receives tasks from both splits and the provider key, and its sandboxes reach the model provider only through the gateway. Your application's model credentials never reach Acclimate."
      caption={
        <>
          Held-out tasks go only to the executor, which grades rollouts outside the sandbox. The sandbox gets the
          bundle and the task input, and its only way out is the gateway. Your application calls its own model with
          its own credentials, which never reach Acclimate.
        </>
      }
    >
      <Zone x={10} y={10} w={170} h={360} label="YOUR APPLICATION" />
      <Box x={24} y={150} w={142} h={64} title="Agent" lines={['its own model', 'credentials']} />
      <Arrow d="M212 62 L120 62 L120 150" label="released version" lx={160} ly={54} />

      <Zone x={200} y={10} w={200} h={262} label="ACCLIMATE SERVICE" />
      <Box x={212} y={40} w={176} h={44} title="Bundles and versions" />
      <Box x={212} y={96} w={176} h={44} title="Evolve tasks" />
      <Box x={212} y={152} w={176} h={44} title="Held-out tasks" lines={['stored separately']} />
      <Box x={300} y={208} w={88} h={44} title="API key" lines={['encrypted']} />

      <Box x={212} y={296} w={176} h={44} title="Optimizer model" lines={['operator’s endpoint']} />
      <Arrow d="M212 118 L204 118 L204 318 L212 318" />
      <Label x={300} y={360}>
        bundle, memory, evolve rollouts
      </Label>
      <Arrow d="M250 196 L250 296" tone="warn" dashed />
      <Label x={250} y={254} tone="warn">
        never
      </Label>

      <Zone x={460} y={10} w={290} h={232} label="EXECUTOR" />
      <Box x={476} y={34} w={258} h={58} title="Grader" lines={['tasks from both splits, with', 'answers and criteria']} />
      <Box x={476} y={106} w={258} h={50} title="Gateway" lines={['holds the API key in memory']} />
      <Box x={476} y={172} w={258} h={50} title="Sandbox, no network" lines={['bundle and task input only']} />
      <Arrow d="M388 118 L476 64" />
      <Arrow d="M388 174 L476 76" />
      <Arrow d="M388 230 L476 138" label="key" lx={440} ly={204} />
      <Arrow d="M605 172 L605 156" />

      <Box x={476} y={290} w={258} h={46} title="Model provider" lines={['task and judge models']} />
      <Arrow d="M734 131 L744 131 L744 313 L734 313" label="only way out" lx={738} ly={270} anchor="end" />
    </Figure>
  );
}

export function TopologyDiagram() {
  return (
    <Figure
      id="topology"
      width={760}
      height={430}
      label="Caddy publishes ports 80 and 443 and routes the console, API and identity hosts on the internal backend network. The service also joins the internal executor network on port 3001. The executor mounts the host's Docker socket to start sandboxes and reaches model providers over its own egress network."
      caption={
        <>
          Only Caddy publishes ports. The <code>backend</code> and <code>executor</code> networks are internal, so
          PostgreSQL and the executor listener have no route out. The service, the console and Keycloak reach the
          identity issuer, the optimizer and mail over a separate outbound network. The Docker socket gives the
          executor administrator authority on the host.
        </>
      }
    >
      <Box x={10} y={129} w={110} h={60} title="Internet" lines={['browsers, apps']} />
      <Box x={156} y={129} w={112} h={60} title="Caddy" lines={['ports 80, 443']} />
      <Arrow d="M120 159 L156 159" />

      <Zone x={296} y={10} w={270} h={290} label="backend" note="internal" />
      <Box x={316} y={40} w={124} h={46} title="Console" lines={[':3100']} />
      <Box x={316} y={136} w={124} h={46} title="Service" lines={['API :3000']} />
      <Box x={456} y={136} w={96} h={46} title="PostgreSQL" />
      <Box x={456} y={232} w={96} h={46} title="Keycloak" lines={['optional']} />
      <Arrow d="M268 140 L316 66" label="console host" lx={284} ly={100} anchor="end" />
      <Arrow d="M268 159 L316 159" label="API host" lx={292} ly={177} />
      <Arrow d="M268 180 L456 252" label="identity host" lx={300} ly={236} anchor="start" />
      <Arrow d="M440 159 L456 159" />

      <Zone x={296} y={320} w={270} h={100} label="executor" note="internal" />
      <Box x={316} y={350} w={124} h={52} title="Executor" lines={['root, outbound']} tone="warn" />
      <Arrow d="M378 350 L378 182" label=":3001" lx={386} ly={314} anchor="start" />

      <Box x={606} y={40} w={144} h={64} title="Outbound" lines={['identity issuer,', 'optimizer, mail']} />
      <Arrow d="M440 72 L606 72" label="outbound network" lx={522} ly={65} />
      <Arrow d="M420 136 L420 112 L606 96" />

      <Box x={606} y={250} w={144} h={64} title="Host Docker" lines={['starts sandboxes', 'with no network']} tone="warn" />
      <Arrow d="M440 366 L606 296" tone="warn" label="Docker socket" lx={540} ly={312} />

      <Box x={606} y={350} w={144} h={52} title="Model providers" />
      <Arrow d="M440 388 L606 378" label="executor-egress" lx={522} ly={400} />
    </Figure>
  );
}
