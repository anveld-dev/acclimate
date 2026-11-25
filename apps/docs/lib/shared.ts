import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Acclimate';
/** Where the docs are deployed. Absolute URLs, such as social preview images, use it. */
export const siteUrl = process.env.DOCS_SITE_URL ?? 'https://acclimate.anveld.dev';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const contentPath = 'apps/docs/content/docs';

export const gitConfig = {
  user: 'anveld-dev',
  repo: 'acclimate',
  branch: 'main',
};

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
