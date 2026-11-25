import { ConsoleLink } from './console-link';

/** Secondary navigation inside a page, such as the Learning tab's Overview and Tasks. */
export function SubTabs<T extends string>({
  label,
  tabs,
  current,
  href,
}: {
  label: string;
  tabs: readonly { id: T; label: string; count?: number }[];
  current: T;
  href: (id: T) => string;
}) {
  return (
    <nav aria-label={label} className="sub-tabs">
      {tabs.map((tab) => (
        <ConsoleLink
          key={tab.id}
          href={href(tab.id)}
          exactActive
          aria-current={tab.id === current ? 'page' : undefined}>
          {tab.label}
          {tab.count !== undefined && <span className="sub-tab-count">{tab.count}</span>}
        </ConsoleLink>
      ))}
    </nav>
  );
}
