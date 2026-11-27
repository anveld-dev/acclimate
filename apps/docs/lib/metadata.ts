import type { Metadata } from 'next';
import { appName } from './shared';

/** The home page's preview card, also the fallback for pages without their own. */
export const siteImageUrl = '/og/image.png';

/**
 * Link-preview tags for one page. Next.js replaces rather than merges a page's `openGraph` and
 * `twitter` with the layout's, so each page states all of them. Relative URLs resolve against
 * `metadataBase` in the root layout.
 */
export function previewMetadata({
  title,
  description,
  path,
  image = siteImageUrl,
  type = 'website',
}: {
  title: string;
  description: string;
  path: string;
  image?: string;
  type?: 'website' | 'article';
}): Metadata {
  const images = [{ url: image, width: 1200, height: 630, alt: title, type: 'image/png' }];
  return {
    alternates: { canonical: path },
    openGraph: { type, siteName: appName, locale: 'en_US', url: path, title, description, images },
    twitter: { card: 'summary_large_image', title, description, images },
  };
}
