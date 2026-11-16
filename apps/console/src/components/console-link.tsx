import { Link } from '@tanstack/react-router';
import type { AnchorHTMLAttributes } from 'react';

export function consoleDestination(href: string) {
  const url = new URL(href, 'https://console.invalid');
  return {
    to: '/w/$' as const,
    params: { _splat: url.pathname.slice(3) },
    search: Object.fromEntries(url.searchParams),
    ...(url.hash ? { hash: url.hash.slice(1) } : {}),
  };
}
export function ConsoleLink({
  href,
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string }) {
  return (
    <Link {...consoleDestination(href)} {...props}>
      {children}
    </Link>
  );
}
