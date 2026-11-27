import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { siteUrl } from './shared';

// Social preview cards: 1200×630, the size Open Graph and X's large card both crop well.
export const ogSize = { width: 1200, height: 630 };

// The dark Swiss landing palette, so a card reads as Acclimate in a light or a dark feed.
const color = {
  background: '#0a0a0a',
  rule: '#222222',
  ink: '#f5f5f5',
  muted: '#a3a3a3',
  signal: '#f25733',
  mark: '#f5f5f5',
};

// Satori cannot read woff2, so the cards use static TrueType instances of Recursive (OFL, see
// assets/fonts/OFL.txt). The build runs from apps/docs.
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 500 | 700 }[]> | undefined;
function loadFonts() {
  const font = (file: string) => readFile(join(process.cwd(), 'assets/fonts', file));
  fonts ??= Promise.all([
    font('Recursive-Regular.ttf').then((data) => ({ name: 'Recursive', data, weight: 400 as const })),
    font('Recursive-Bold.ttf').then((data) => ({ name: 'Recursive', data, weight: 700 as const })),
    font('RecursiveMono-Medium.ttf').then((data) => ({ name: 'Recursive Mono', data, weight: 500 as const })),
  ]);
  return fonts;
}

const host = new URL(siteUrl).host;

export type OgCard = {
  /** A short label above the title, such as the docs section. */
  eyebrow: string;
  title: string;
  description?: string;
  /** An optional figure under the description, set in lichen. */
  highlight?: string;
};

export async function renderOgImage({ eyebrow, title, description, highlight }: OgCard) {
  const titleSize = title.length > 48 ? 64 : title.length > 28 && description ? 76 : 88;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '64px 80px',
        background: color.background,
        color: color.ink,
        fontFamily: 'Recursive',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <svg width="52" height="52" viewBox="0 0 40 40">
          <path d="M7.5 7.5H32.5" stroke={color.signal} strokeWidth="5" strokeLinecap="round" />
          <path
            d="M7.5 32.5L20 15L32.5 32.5M20 15V32.5"
            fill="none"
            stroke={color.mark}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em' }}>Acclimate</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'Recursive Mono', fontSize: 24, color: color.muted }}>
          {eyebrow}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 'auto', marginBottom: 'auto' }}>
        <div
          style={{
            fontSize: titleSize,
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: '-0.03em',
          }}
        >
          {title}
        </div>
        {description ? (
          <div
            style={{
              display: 'block',
              marginTop: 28,
              fontSize: 30,
              lineHeight: 1.4,
              color: color.muted,
              lineClamp: 3,
            }}
          >
            {description}
          </div>
        ) : null}
        {highlight ? (
          <div style={{ marginTop: 36, fontFamily: 'Recursive Mono', fontSize: 36, color: color.signal }}>
            {highlight}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          paddingTop: 24,
          borderTop: `2px solid ${color.rule}`,
          fontFamily: 'Recursive Mono',
          fontSize: 24,
          color: color.muted,
        }}
      >
        {host}
      </div>
    </div>,
    { ...ogSize, fonts: await loadFonts() },
  );
}
