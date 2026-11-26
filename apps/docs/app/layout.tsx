import { Recursive } from 'next/font/google';
import { Provider } from '@/components/provider';
import { siteUrl } from '@/lib/shared';
import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { template: '%s | Acclimate', default: 'Acclimate documentation' },
  description:
    'Version and deliver your agent’s instructions, skills and memory, and improve them with a learning loop.',
};

// One variable family for the whole site: the MONO axis turns the sans into the code face.
const recursive = Recursive({
  subsets: ['latin'],
  axes: ['MONO', 'CASL'],
  variable: '--font-recursive',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${recursive.variable} ${recursive.className}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
