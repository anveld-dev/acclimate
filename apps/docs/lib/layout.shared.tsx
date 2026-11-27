import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { AcclimateMark } from '@/components/mark';
import { appName, gitConfig } from './shared';

export const githubUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2.5 text-[0.9375rem] font-semibold tracking-[-0.015em]">
          <AcclimateMark className="size-[1.125rem]" />
          {appName}
        </span>
      ),
    },
    links: [
      { text: 'Docs', url: '/docs', active: 'nested-url' },
      { text: 'Quickstart', url: '/docs/get-started/quickstart' },
      { text: 'Examples', url: `${githubUrl}/tree/${gitConfig.branch}/examples`, external: true },
    ],
    githubUrl,
  };
}
