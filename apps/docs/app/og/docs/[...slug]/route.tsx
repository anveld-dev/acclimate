import { source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { findParent } from 'fumadocs-core/page-tree';
import { renderOgImage } from '@/lib/og';
import { getPageImageUrl } from '@/lib/shared';

export const revalidate = false;

// The sidebar folder a page sits in, such as "Get started", for the card's label.
function sectionOf(url: string): string | undefined {
  const parent = findParent(source.getPageTree(), url);
  return parent?.type === 'folder' && typeof parent.name === 'string' ? parent.name : undefined;
}

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const section = sectionOf(page.url);
  return renderOgImage({
    eyebrow: section ? `Docs / ${section}` : 'Docs',
    title: page.data.title,
    description: page.data.description,
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
