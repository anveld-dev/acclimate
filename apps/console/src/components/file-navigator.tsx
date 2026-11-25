import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const railPreference = 'acclimate.files.collapsed';

/** A persistent desktop file rail and a named, initially closed narrow picker. */
export function FileNavigator({
  children,
  collapsible = false,
  count,
  totalCount = count,
  filtered = false,
  selectedPath,
}: {
  children: ReactNode;
  collapsible?: boolean;
  count: number;
  totalCount?: number;
  filtered?: boolean;
  selectedPath?: string;
}) {
  const id = useId();
  const [compact, setCompact] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const railToggle = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const previousPath = useRef(selectedPath);
  const chosenPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    try {
      setRailCollapsed(sessionStorage.getItem(railPreference) === 'true');
    } catch {
      // Width can still be changed for the mounted explorer.
    }
    setReady(true);
  }, []);
  useLayoutEffect(() => {
    const frame = body.current?.closest<HTMLElement>('.content-workspace, .history-files-grid');
    const query = window.matchMedia('(max-width: 899px)');
    let measured = false;
    const fallback = () => {
      if (!measured) setCompact(query.matches);
    };
    const measure = () => {
      const width = frame?.clientWidth ?? 0;
      if (width > 0) {
        measured = true;
        setCompact(width <= 899);
      } else fallback();
    };
    fallback();
    if (frame && typeof ResizeObserver !== 'undefined') {
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(frame);
      query.addEventListener('change', fallback);
      return () => {
        observer.disconnect();
        query.removeEventListener('change', fallback);
      };
    }
    query.addEventListener('change', fallback);
    return () => query.removeEventListener('change', fallback);
  }, []);
  useLayoutEffect(() => {
    const changed = previousPath.current !== selectedPath;
    previousPath.current = selectedPath;
    // Observe the committed selection, not a link click: dirty-route guards can
    // cancel a published-content navigation. Renaming in a dialog is not selection.
    if (!changed || chosenPath.current !== selectedPath) return;
    chosenPath.current = null;
    if (!compact) return;
    if (body.current?.contains(document.activeElement)) toggle.current?.focus();
    setExpanded(false);
  }, [selectedPath, compact]);
  useLayoutEffect(() => {
    // Reflow must never leave keyboard focus inside the now-hidden desktop rail.
    if (compact && !expanded && body.current?.contains(document.activeElement))
      toggle.current?.focus();
  }, [compact, expanded]);
  const collapsed = !compact && collapsible && railCollapsed;
  const visible = compact ? expanded : !collapsed;
  const railAction = collapsed ? 'Expand file sidebar' : 'Collapse file sidebar';
  useLayoutEffect(() => {
    if (collapsed && body.current?.contains(document.activeElement)) railToggle.current?.focus();
    if (compact && document.activeElement === railToggle.current) toggle.current?.focus();
  }, [collapsed, compact]);

  return (
    <aside
      className="content-file-sidebar file-navigator file-navigator-polished"
      aria-label="Files"
      data-compact={compact}
      data-collapsible={collapsible || undefined}
      data-collapsed={collapsed || undefined}
    >
      <Button
        ref={toggle}
        type="button"
        variant="ghost"
        className="file-navigator-toggle"
        aria-expanded={visible}
        aria-controls={id}
        disabled={!ready}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Files</span>
        <ChevronDown aria-hidden="true" className={expanded ? 'rotate-180' : undefined} />
      </Button>
      {collapsible && (
        <Tooltip>
          <TooltipTrigger asChild data-slot="button">
            <Button
              ref={railToggle}
              type="button"
              variant="ghost"
              size="icon-sm"
              hidden={compact}
              className="desktop-file-rail-toggle"
              aria-label={railAction}
              disabled={!ready}
              aria-expanded={visible}
              aria-controls={id}
              onClick={() => {
                setRailCollapsed(!collapsed);
                try {
                  sessionStorage.setItem(railPreference, String(!collapsed));
                } catch {
                  // Storage is optional.
                }
              }}
            >
              {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              {collapsed && <span className="file-rail-caption" aria-hidden="true">File sidebar</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? 'bottom' : 'right'} align={collapsed ? 'start' : 'center'} className="file-rail-tooltip">
            <strong>{railAction}</strong>
            {collapsed && <span>{filtered ? `${count} of ${totalCount}` : count} {totalCount === 1 ? 'file' : 'files'}</span>}
            {collapsed && selectedPath && <code>{selectedPath}</code>}
          </TooltipContent>
        </Tooltip>
      )}
      <div
        ref={body}
        id={id}
        className="file-navigator-body"
        hidden={!visible}
        onKeyDown={(event) => {
          if (compact && expanded && event.key === 'Escape' && !event.defaultPrevented &&
              event.currentTarget.contains(event.target as Node) &&
              !(event.target instanceof HTMLInputElement && event.target.type === 'search' && event.target.value)) {
            event.preventDefault();
            setExpanded(false);
            toggle.current?.focus();
          }
        }}
        onClickCapture={(event) => {
          const entry = (event.target as HTMLElement).closest<HTMLElement>('[data-file-path]');
          const path = entry?.dataset.filePath;
          // An unchanged choice has already committed; it must not close a later search.
          chosenPath.current = path && path !== selectedPath ? path : null;
        }}
      >
        {children}
        <div className="file-navigator-footer" role="status">
          {filtered ? `${count} of ${totalCount}` : count} {totalCount === 1 ? 'file' : 'files'}
        </div>
      </div>
    </aside>
  );
}
