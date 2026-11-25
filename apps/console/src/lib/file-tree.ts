import type { FileKind } from '@acclimate/sdk';

export type FileTreeItem = {
  id: string;
  path: string;
  kind: FileKind;
  changeDescription?: 'Added' | 'Changed';
};
export type FileTreeFolder = {
  type: 'folder';
  id: string;
  name: string;
  path: string;
  parentId?: string;
  children: FileTreeNode[];
  fileCount: number;
};
export type FileTreeLeaf = {
  type: 'file';
  id: string;
  name: string;
  path: string;
  parentId?: string;
  item: FileTreeItem;
};
export type FileTreeNode = FileTreeFolder | FileTreeLeaf;

export function fileTreeLeafId(itemId: string): string {
  return `file:${JSON.stringify(itemId)}`;
}

/** Keep invalid paths as exact root leaves. */
function pathSegments(path: string): string[] | undefined {
  if (!path.trim() || /[\\\u0000-\u001f\u007f]/.test(path)) return;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return;
  return parts;
}

/** Folders precede files; source order inside either group remains stable. */
export function buildFileTree(items: readonly FileTreeItem[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeFolder>();
  for (const item of items) {
    const parts = pathSegments(item.path);
    let children = roots;
    let parentId: string | undefined;
    if (parts) {
      for (let depth = 0; depth < parts.length - 1; depth++) {
        const segments = parts.slice(0, depth + 1);
        const id = `folder:${JSON.stringify(segments)}`;
        let folder = folders.get(id);
        if (!folder) {
          folder = {
            type: 'folder',
            id,
            name: parts[depth],
            path: segments.join('/'),
            parentId,
            children: [],
            fileCount: 0,
          };
          folders.set(id, folder);
          children.push(folder);
        }
        folder.fileCount++;
        children = folder.children;
        parentId = id;
      }
    }
    children.push({
      type: 'file',
      id: fileTreeLeafId(item.id),
      name: parts?.at(-1) ?? (item.path.trim() ? item.path : 'Unnamed entry'),
      path: item.path,
      parentId,
      item,
    });
  }
  const order = (nodes: FileTreeNode[]): FileTreeNode[] => [
    ...nodes
      .filter((node) => node.type === 'folder')
      .map((node) => {
        const folder = node as FileTreeFolder;
        folder.children = order(folder.children);
        return folder;
      }),
    ...nodes.filter((node) => node.type === 'file'),
  ];
  return order(roots);
}

export function flattenFileTree(
  nodes: readonly FileTreeNode[],
  collapsedIds: ReadonlySet<string> = new Set(),
  forceExpanded = false,
): FileTreeNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.type === 'folder' && (forceExpanded || !collapsedIds.has(node.id))
      ? flattenFileTree(node.children, collapsedIds, forceExpanded)
      : []),
  ]);
}

export function fileTreeAncestors(nodes: readonly FileTreeNode[], itemId: string): string[] {
  for (const node of nodes) {
    if (node.type === 'file' && node.item.id === itemId) return [];
    if (node.type === 'folder') {
      const descendants = flattenFileTree(node.children);
      if (descendants.some((child) => child.type === 'file' && child.item.id === itemId))
        return [node.id, ...fileTreeAncestors(node.children, itemId)];
    }
  }
  return [];
}

/** Retain focus on a collapsed ancestor rather than jumping to another selected file. */
export function resolveFileTreeFocus(
  nodes: readonly FileTreeNode[],
  collapsedIds: ReadonlySet<string>,
  preferredNodeId?: string,
  selectedItemId?: string,
  forceExpanded = false,
): string | undefined {
  const all = new Map(flattenFileTree(nodes).map((node) => [node.id, node]));
  const visible = flattenFileTree(nodes, collapsedIds, forceExpanded);
  const visibleIds = new Set(visible.map((node) => node.id));
  const nearest = (id: string | undefined): string | undefined => {
    while (id) {
      if (visibleIds.has(id)) return id;
      id = all.get(id)?.parentId;
    }
    return;
  };
  return (
    nearest(preferredNodeId) ??
    nearest(selectedItemId === undefined ? undefined : fileTreeLeafId(selectedItemId)) ??
    visible[0]?.id
  );
}

export function fileTreeTypeahead(
  visible: readonly FileTreeNode[],
  currentNodeId: string | undefined,
  query: string,
): string | undefined {
  if (!query || !visible.length) return;
  const prefix = query.toLocaleLowerCase();
  const start = visible.findIndex((node) => node.id === currentNodeId);
  for (let offset = 1; offset <= visible.length; offset++) {
    const node = visible[(start + offset) % visible.length];
    if (node.name.toLocaleLowerCase().startsWith(prefix)) return node.id;
  }
  return;
}
