import { Geist, JetBrains_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import { appName, siteUrl } from '@/lib/shared';
import { siteImageUrl } from '@/lib/metadata';
import type { Metadata } from 'next';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { template: '%s | Acclimate', default: 'Acclimate documentation' },
  description:
    'Version and deliver your agent’s instructions, skills and memory, and improve them with a learning loop.',
  applicationName: appName,
  // Defaults for pages that set no preview of their own, such as the 404 page.
  openGraph: { type: 'website', siteName: appName, locale: 'en_US', images: siteImageUrl },
  twitter: { card: 'summary_large_image', images: siteImageUrl },
};

// Geist sets titles and reading, JetBrains Mono sets code and data. global.css maps these
// variables to Tailwind's --font-sans and --font-mono.
const sans = Geist({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-geist',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
