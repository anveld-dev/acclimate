import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/'>) {
  const options = baseOptions();
  // The bar is clear over the paper at the top and settles once the page scrolls. landing.css
  // narrows --fd-layout-width to the 74rem landing grid so the bar lines up with it.
  return (
    <HomeLayout {...options} nav={{ ...options.nav, transparentMode: 'top' }} className="lp-home">
      {children}
    </HomeLayout>
  );
}
