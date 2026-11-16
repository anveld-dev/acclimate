import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './ui/button';

/** A persistent desktop file rail and a named, initially closed narrow picker. */
export function FileNavigator({
  children,
  count,
  totalCount = count,
  filtered = false,
  selectedPath,
}: {
  children: ReactNode;
  count: number;
  totalCount?: number;
  filtered?: boolean;
  selectedPath?: string;
}) {
  const id = useId();
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const previousPath = useRef(selectedPath);
  const chosenPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    const frame = body.current?.closest<HTMLElement>('.content-workspace');
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
  const visible = !compact || expanded;
  return (
    <aside
      className="content-file-sidebar file-navigator file-navigator-polished"
      aria-label="Files"
      data-compact={compact}
    >
      <Button
        ref={toggle}
        type="button"
        variant="ghost"
        className="file-navigator-toggle"
        aria-expanded={visible}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>Files</span>
        <ChevronDown aria-hidden="true" className={expanded ? 'rotate-180' : undefined} />
      </Button>
      <div
        ref={body}
        id={id}
        className="file-navigator-body"
        hidden={!visible}
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
