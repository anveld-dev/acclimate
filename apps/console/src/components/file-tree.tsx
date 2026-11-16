import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ConsoleLink } from './console-link';
import { FileGlyph } from './shared';
import {
  buildFileTree,
  fileTreeAncestors,
  fileTreeLeafId,
  fileTreeTypeahead,
  flattenFileTree,
  resolveFileTreeFocus,
  type FileTreeItem,
  type FileTreeNode,
} from '../lib/file-tree';

export type { FileTreeItem } from '../lib/file-tree';

type FileTreeProps = {
  items: FileTreeItem[];
  selectedId?: string;
  scopeKey: string;
  filtered?: boolean;
  filterKey?: string;
  disabled?: boolean;
  hrefForItem?: (item: FileTreeItem) => string;
  onSelectItem?: (item: FileTreeItem) => void;
};

/** Scope changes reset folds; path changes do not change draft entry identity. */
export function FileTree(props: FileTreeProps) {
  return <ScopedFileTree key={props.scopeKey} {...props} />;
}

function ScopedFileTree({
  items,
  selectedId,
  filtered = false,
  filterKey,
  disabled = false,
  hrefForItem,
  onSelectItem,
}: FileTreeProps) {
  const treeId = useId();
  const root = useRef<HTMLUListElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const focusWithin = useRef(false);
  const pendingFocus = useRef<string | undefined>(undefined);
  const pendingReveal = useRef<string | undefined>(undefined);
  const nodes = useMemo(() => buildFileTree(items), [items]);
  const itemSignature = JSON.stringify(items.map((item) => [item.id, item.path, item.kind]));
  const filterSignature = JSON.stringify([filterKey, itemSignature]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [filterFolds, setFilterFolds] = useState<{ key: string; ids: Set<string> }>(() => ({
    key: filterSignature,
    ids: new Set(),
  }));
  const effectiveFolds = filtered
    ? filterFolds.key === filterSignature ? filterFolds.ids : new Set<string>()
    : collapsed;
  const visible = flattenFileTree(nodes, effectiveFolds);
  const visibleSignature = JSON.stringify(visible.map((node) => node.id));
  const [preferredId, setPreferredId] = useState<string | undefined>(() =>
    resolveFileTreeFocus(nodes, new Set(), undefined, selectedId),
  );
  const focusId = resolveFileTreeFocus(nodes, effectiveFolds, preferredId, selectedId);
  const previousSelection = useRef<string | undefined>(undefined);
  const previousFiltered = useRef(filtered);
  const previousUnfilteredSelection = useRef<string | undefined>(undefined);
  const previousUnfiltered = useRef(new Map<string, string>());
  const selectedNodeId = selectedId === undefined ? undefined : fileTreeLeafId(selectedId);
  const selectionSignature = JSON.stringify([selectedId, items.find((item) => item.id === selectedId)?.path]);
  const selectedNode = useRef(selectedNodeId);
  selectedNode.current = selectedNodeId;
  const typeahead = useRef({ text: '', at: 0 });

  /** Reveal within the tree's own scroller, never scroll the document or a dialog. */
  function revealRow(element: HTMLElement | undefined) {
    if (!element || !element.getClientRects().length) return;
    let scroller: HTMLElement | null = root.current;
    while (scroller && scroller !== document.body && scroller !== document.documentElement) {
      const overflow = getComputedStyle(scroller).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && scroller.scrollHeight > scroller.clientHeight) {
        const itemRect = element.getBoundingClientRect();
        const scrollRect = scroller.getBoundingClientRect();
        const top = scrollRect.top + scroller.clientTop;
        const bottom = top + scroller.clientHeight;
        if (itemRect.top < top) scroller.scrollTop += itemRect.top - top;
        else if (itemRect.bottom > bottom) scroller.scrollTop += itemRect.bottom - bottom;
        return;
      }
      scroller = scroller.parentElement;
      if (scroller && !scroller.classList.contains('file-navigator') &&
          !scroller.classList.contains('file-navigator-body') && scroller !== root.current) return;
    }
  }

  function focusNode(id: string | undefined) {
    if (!id || disabled) return;
    setPreferredId(id);
    const element = rows.current.get(id);
    element?.focus({ preventScroll: true });
    revealRow(element);
  }

  function updateFolds(update: (current: Set<string>) => Set<string>) {
    if (filtered) {
      setFilterFolds((previous) => ({
        key: filterSignature,
        ids: update(previous.key === filterSignature ? previous.ids : new Set()),
      }));
    } else setCollapsed(update);
  }

  function toggleFolder(id: string) {
    if (disabled) return;
    updateFolds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useLayoutEffect(() => {
    const clearedFilters = previousFiltered.current && !filtered;
    const enteredFilters = !previousFiltered.current && filtered;
    const restoredSelection = clearedFilters && previousUnfilteredSelection.current === selectionSignature;
    const changedSelection = previousSelection.current !== selectionSignature && !restoredSelection;
    if (previousSelection.current !== selectionSignature) {
      pendingFocus.current = undefined;
      pendingReveal.current = undefined;
    }
    previousSelection.current = selectionSignature;
    previousFiltered.current = filtered;
    if (!filtered) previousUnfilteredSelection.current = selectionSignature;
    if (enteredFilters) setFilterFolds({ key: filterSignature, ids: new Set() });
    const revealIds = new Set<string>();
    if (changedSelection && selectedId !== undefined) {
      fileTreeAncestors(nodes, selectedId).forEach((id) => revealIds.add(id));
      setPreferredId(fileTreeLeafId(selectedId));
      pendingReveal.current = fileTreeLeafId(selectedId);
      if (root.current?.contains(document.activeElement)) pendingFocus.current = fileTreeLeafId(selectedId);
    }
    // Filtering must not make every returning entry look like a newly added file.
    if (!filtered) {
      for (const item of items) {
        if (previousUnfiltered.current.get(item.id) !== item.path)
          fileTreeAncestors(nodes, item.id).forEach((id) => revealIds.add(id));
      }
      previousUnfiltered.current = new Map(items.map((item) => [item.id, item.path]));
    }
    if (revealIds.size) updateFolds((previous) => {
      if (![...revealIds].some((id) => previous.has(id))) return previous;
      return new Set([...previous].filter((id) => !revealIds.has(id)));
    });
  }, [selectionSignature, itemSignature, filtered]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    if (focusWithin.current && active !== document.body && !root.current?.contains(active))
      focusWithin.current = false;
    const next = pendingFocus.current;
    if (next && rows.current.has(next) && visible.some((node) => node.id === next)) {
      pendingFocus.current = undefined;
      if (focusWithin.current) focusNode(next);
    } else if (focusWithin.current && active === document.body) focusNode(focusId);
    const reveal = pendingReveal.current;
    if (reveal && visible.some((node) => node.id === reveal)) {
      revealRow(rows.current.get(reveal));
      pendingReveal.current = undefined;
    }
  }, [visibleSignature, focusId, selectedNodeId, selectionSignature]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    let resized = false;
    let wasVisible = element.getBoundingClientRect().height > 0;
    const measure = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const visibleNow = rect.height > 0;
      const height = `${Math.max(176, Math.min(650, Math.floor(innerHeight - rect.top - 16)))}px`;
      const changed = element.style.getPropertyValue('--file-tree-max-height') !== height;
      if (changed) element.style.setProperty('--file-tree-max-height', height);
      if (visibleNow && (changed || resized || !wasVisible)) {
        const focused = document.activeElement;
        revealRow(focusWithin.current && focused instanceof HTMLElement && element.contains(focused)
          ? focused
          : rows.current.get(selectedNode.current ?? ''));
      }
      resized = false;
      wasVisible = visibleNow;
    };
    const schedule = (fromResize = false) => {
      resized ||= fromResize;
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const onResize = () => schedule(true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => schedule());
    const workspace = element.closest('.content-workspace');
    const workbench = element.closest('.draft-workbench');
    const controls = element.parentElement?.querySelector('.file-navigator-controls');
    const toolbar = workbench?.querySelector('.draft-toolbar');
    [element, workspace, workbench, controls, toolbar].forEach((node) => {
      if (node) observer?.observe(node);
    });
    window.addEventListener('resize', onResize);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      element.style.removeProperty('--file-tree-max-height');
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLElement>, node: FileTreeNode) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.length !== 1 || event.key === ' ') typeahead.current = { text: '', at: 0 };
    const position = visible.findIndex((entry) => entry.id === node.id);
    const expanded = node.type === 'folder' && !effectiveFolds.has(node.id);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusNode(visible[Math.min(position + 1, visible.length - 1)]?.id);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusNode(visible[Math.max(0, position - 1)]?.id);
        return;
      case 'Home':
        event.preventDefault(); focusNode(visible[0]?.id); return;
      case 'End':
        event.preventDefault(); focusNode(visible.at(-1)?.id); return;
      case 'ArrowRight':
        event.preventDefault();
        if (node.type === 'folder') {
          if (expanded) focusNode(node.children[0]?.id);
          else toggleFolder(node.id);
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (expanded) toggleFolder(node.id);
        else focusNode(node.parentId);
        return;
      case 'Enter':
      case ' ':
        if (node.type === 'folder') {
          event.preventDefault(); toggleFolder(node.id);
        } else if (event.key === ' ') {
          event.preventDefault(); event.currentTarget.click();
        }
        return;
      default:
        if (event.key.length === 1 && !event.nativeEvent.isComposing) {
          const now = Date.now();
          const previous = now - typeahead.current.at < 700 ? typeahead.current.text : '';
          const text = previous + event.key.toLowerCase();
          typeahead.current = { text, at: now };
          const query = [...text].every((character) => character === text[0]) ? text[0] : text;
          const match = fileTreeTypeahead(visible, node.id, query);
          if (match) { event.preventDefault(); focusNode(match); }
        }
    }
  }

  function renderNodes(siblings: FileTreeNode[], depth: number) {
    return siblings.map((node, index) => {
      const expanded = node.type === 'folder' && !effectiveFolds.has(node.id);
      const selected = node.type === 'file' && node.item.id === selectedId;
      const groupId = `${treeId}-group-${encodeURIComponent(node.id)}`;
      const common = {
        role: 'treeitem' as const,
        tabIndex: !disabled && focusId === node.id ? 0 : -1,
        'aria-level': depth + 1,
        'aria-posinset': index + 1,
        'aria-setsize': siblings.length,
        'data-tree-node-id': node.id,
        style: { '--depth': depth, '--file-tree-depth': depth } as CSSProperties,
        ref: (element: HTMLElement | null) => {
          if (element) rows.current.set(node.id, element);
          else rows.current.delete(node.id);
        },
        onFocus: () => { setPreferredId(node.id); },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => onKeyDown(event, node),
      };
      const label = <span className="file-tree-label">{node.name}</span>;
      return (
        <li key={node.id} role="none" className="file-tree-branch">
          <Tooltip>
            <TooltipTrigger asChild data-slot="button">
              {node.type === 'folder' ? (
                <Button
                  {...common}
                  type="button"
                  variant="ghost"
                  className="file-tree-row file-tree-folder"
                  aria-label={`Folder ${node.path}`}
                  aria-expanded={expanded}
                  aria-owns={expanded ? groupId : undefined}
                  disabled={disabled}
                  onClick={() => { focusNode(node.id); toggleFolder(node.id); }}
                >
                  <ChevronRight className={`file-tree-chevron size-4${expanded ? ' rotate-90' : ''}`} aria-hidden="true" />
                  {expanded ? <FolderOpen className="file-tree-icon size-4" aria-hidden="true" /> : <Folder className="file-tree-icon size-4" aria-hidden="true" />}
                  {label}
                </Button>
              ) : hrefForItem ? (
                <Button asChild variant="ghost" className={`file-tree-row content-file-button${selected ? ' is-selected' : ''}`}>
                  <ConsoleLink
                    {...common}
                    href={hrefForItem(node.item)}
                    aria-label={`Open ${node.path || 'unnamed entry'}`}
                    aria-selected={selected}
                    aria-current={selected ? 'true' : undefined}
                    aria-disabled={disabled || undefined}
                    data-file-path={node.path}
                    onClick={(event) => {
                      if (disabled) event.preventDefault();
                      else onSelectItem?.(node.item);
                    }}
                  >
                    <span className="file-tree-spacer" aria-hidden="true" />
                    <FileGlyph kind={node.item.kind} />{label}
                  </ConsoleLink>
                </Button>
              ) : (
                <Button
                  {...common}
                  type="button"
                  variant="ghost"
                  className={`file-tree-row content-file-button${selected ? ' is-selected' : ''}`}
                  aria-label={`Open ${node.path || 'unnamed entry'}`}
                  aria-selected={selected}
                  data-file-path={node.path}
                  disabled={disabled}
                  onClick={() => onSelectItem?.(node.item)}
                >
                  <span className="file-tree-spacer" aria-hidden="true" />
                  <FileGlyph kind={node.item.kind} />{label}
                </Button>
              )}
            </TooltipTrigger>
            <TooltipContent side="right" className="file-tree-tooltip max-w-[min(28rem,calc(100vw-2rem))] break-all text-sm">
              {node.path || 'Unnamed entry'}
            </TooltipContent>
          </Tooltip>
          {node.type === 'folder' && expanded && (
            <ul role="group" id={groupId} className="file-tree-group" style={{ '--file-tree-depth': depth + 1 } as CSSProperties}>
              {renderNodes(node.children, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  return (
    <ul
      ref={root}
      role="tree"
      aria-label="Files"
      aria-disabled={disabled || undefined}
      tabIndex={disabled && items.length ? 0 : undefined}
      className="file-tree"
      onFocusCapture={() => { focusWithin.current = true; }}
      onBlurCapture={(event) => {
        focusWithin.current = event.relatedTarget
          ? event.currentTarget.contains(event.relatedTarget as Node)
          : !(event.target as HTMLElement).isConnected;
        if (!focusWithin.current) typeahead.current = { text: '', at: 0 };
      }}
    >
      {renderNodes(nodes, 0)}
    </ul>
  );
}
