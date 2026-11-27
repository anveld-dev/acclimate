import { renderOgImage } from '@/lib/og';
import { homeHighlight, homeTitle } from '@/app/(home)/copy';

export const dynamic = 'force-static';

export function GET() {
  return renderOgImage({
    eyebrow: 'Open source · Self-hosted',
    // The lede is already the preview's description text, so the card shows the result instead.
    title: homeTitle,
    highlight: homeHighlight,
  });
}
