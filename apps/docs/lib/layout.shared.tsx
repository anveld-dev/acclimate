import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { AcclimateMark } from '@/components/mark';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
          <AcclimateMark className="size-5" />
          {appName}
        </span>
      ),
    },
    links: [{ text: 'Documentation', url: '/docs', active: 'nested-url' }],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
