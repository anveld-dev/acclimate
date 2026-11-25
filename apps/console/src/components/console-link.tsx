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
  exactActive = false,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href: string;
  /** Mark the link current only for an exact path and search match; callers own aria-current. */
  exactActive?: boolean;
}) {
  return (
    <Link
      {...consoleDestination(href)}
      {...(exactActive ? { activeOptions: { exact: true, includeHash: false } } : {})}
      {...props}
    >
      {children}
    </Link>
  );
}
