import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFileTree,
  fileTreeAncestors,
  fileTreeLeafId,
  fileTreeTypeahead,
  flattenFileTree,
  resolveFileTreeFocus,
  type FileTreeItem,
  type FileTreeNode,
} from '../src/lib/file-tree';

const item = (id: string, path: string): FileTreeItem => ({ id, path, kind: 'instruction' });
const label = (node: FileTreeNode) => `${node.type}:${node.name}`;
const leaves = (nodes: FileTreeNode[]) =>
  flattenFileTree(nodes).filter((node) => node.type === 'file');

test('hierarchy puts folders first without reordering entries within their sibling groups', () => {
  const input = [
    item('root-z', 'z.md'),
    item('skill-z', 'skills/z.md'),
    item('memory-a', 'memory/a.md'),
    item('skill-a', 'skills/a.md'),
    item('reference', 'skills/references/checks.md'),
    item('root-a', 'a.md'),
  ];
  const before = structuredClone(input);
  const tree = buildFileTree(input);
  assert.deepEqual(tree.map(label), ['folder:skills', 'folder:memory', 'file:z.md', 'file:a.md']);
  const skills = tree[0];
  assert.equal(skills.type, 'folder');
  if (skills.type !== 'folder') throw Error('Expected skills folder');
  assert.deepEqual(skills.children.map(label), ['folder:references', 'file:z.md', 'file:a.md']);
  assert.deepEqual(input, before, 'Building navigation must not normalize or reorder source entries');
  assert.deepEqual(buildFileTree(input), tree, 'The same inventory must produce stable navigation');
});

test('equal basenames in distinct branches retain distinct selection ancestry', () => {
  const tree = buildFileTree([
    item('skill-checks', 'skills/review/checks.md'),
    item('memory-checks', 'memory/checks.md'),
    item('root-checks', 'checks.md'),
  ]);
  assert.equal(leaves(tree).length, 3);
  const skillAncestors = fileTreeAncestors(tree, 'skill-checks');
  const memoryAncestors = fileTreeAncestors(tree, 'memory-checks');
  assert.equal(skillAncestors.length, 2);
  assert.equal(memoryAncestors.length, 1);
  assert.notEqual(skillAncestors[0], memoryAncestors[0]);
  assert.deepEqual(fileTreeAncestors(tree, 'root-checks'), []);
  assert.deepEqual(fileTreeAncestors(tree, 'not-present'), []);
  const byId = new Map(flattenFileTree(tree).map((node) => [node.id, node]));
  assert.deepEqual(skillAncestors.map((id) => byId.get(id)?.path), ['skills', 'skills/review']);
  assert.deepEqual(memoryAncestors.map((id) => byId.get(id)?.path), ['memory']);
});

test('file/folder collisions and duplicate draft paths never merge distinct editable entries', () => {
  const input = [
    item('skills', 'skills'),
    item('folder:["skills"]', 'skills/checks.md'),
    item('duplicate-a', 'skills/checks.md'),
    item('duplicate-b', 'skills/checks.md'),
    item('case-distinct', 'Skills/checks.md'),
  ];
  const tree = buildFileTree(input);
  const visible = flattenFileTree(tree);
  assert.equal(new Set(visible.map((node) => node.id)).size, visible.length);
  assert.deepEqual(
    leaves(tree).map((node) => node.item.id).sort(),
    input.map((entry) => entry.id).sort(),
  );
  assert.equal(visible.filter((node) => node.name === 'skills').length, 2);
  assert.deepEqual(fileTreeAncestors(tree, 'skills'), []);
  assert.notEqual(fileTreeLeafId('duplicate-a'), fileTreeLeafId('duplicate-b'));
  assert.notDeepEqual(
    fileTreeAncestors(tree, 'case-distinct'),
    fileTreeAncestors(tree, 'duplicate-a'),
    'Case-distinct paths must remain distinct rather than silently normalized',
  );
});

test('invalid and unnamed browser draft paths remain exact root leaves that can be repaired', () => {
  const paths = ['', '/absolute.md', 'skills//empty.md', 'skills/../escape.md',
    'skills/./dot.md', 'skills/', 'back\\slash.md', 'control\u0000.md'];
  const input = paths.map((path, index) => item(`invalid-${index}`, path));
  const tree = buildFileTree(input);
  assert.equal(tree.length, paths.length);
  assert.ok(tree.every((node) => node.type === 'file'));
  for (const [index, node] of tree.entries()) {
    assert.equal(node.path, paths[index]);
    assert.equal(node.name, paths[index] || 'Unnamed entry');
    assert.equal(node.id, fileTreeLeafId(input[index].id));
    assert.deepEqual(fileTreeAncestors(tree, input[index].id), []);
  }
});

test('a filtered deep match retains only its necessary ancestors and exact selected leaf', () => {
  const tree = buildFileTree([
    item('selected', 'skills/review/references/checks.md'),
  ]);
  const visible = flattenFileTree(tree);
  assert.deepEqual(visible.map((node) => node.path), [
    'skills', 'skills/review', 'skills/review/references',
    'skills/review/references/checks.md',
  ]);
  assert.deepEqual(fileTreeAncestors(tree, 'selected'), visible.slice(0, -1).map((node) => node.id));
  assert.equal(visible.at(-1)?.id, fileTreeLeafId('selected'));
});

test('collapse removes descendants from keyboard order while filtered expansion leaves saved collapse state intact', () => {
  const tree = buildFileTree([
    item('selected', 'skills/review/checks.md'),
    item('memory', 'memory/team.md'),
    item('root', 'AGENTS.md'),
  ]);
  const ancestors = fileTreeAncestors(tree, 'selected');
  const collapsed = new Set([ancestors[0]]);
  const visible = flattenFileTree(tree, collapsed);
  assert.ok(visible.some((node) => node.id === ancestors[0]));
  assert.ok(!visible.some((node) => node.id === fileTreeLeafId('selected')));
  assert.ok(!visible.some((node) => node.id === ancestors[1]));
  assert.ok(visible.some((node) => node.id === fileTreeLeafId('memory')));
  assert.deepEqual(flattenFileTree(tree, collapsed, true), flattenFileTree(tree));
  assert.deepEqual([...collapsed], [ancestors[0]], 'Filtering must not overwrite the saved collapse choice');
});

test('roving focus follows the nearest visible ancestor before falling back to the selected entry', () => {
  const tree = buildFileTree([
    item('selected', 'skills/review/references/checks.md'),
    item('other', 'memory/team.md'),
  ]);
  const [skills, review, references] = fileTreeAncestors(tree, 'selected');
  assert.equal(
    resolveFileTreeFocus(tree, new Set([review]), fileTreeLeafId('selected'), 'other'),
    review,
    'Collapsing an ancestor must not jump focus to an unrelated selected branch',
  );
  assert.equal(
    resolveFileTreeFocus(tree, new Set([skills, references]), references, 'other'),
    skills,
  );
  assert.equal(
    resolveFileTreeFocus(tree, new Set([review]), 'removed-node', 'selected'),
    review,
  );
  assert.equal(
    resolveFileTreeFocus(tree, new Set([skills]), fileTreeLeafId('selected'), 'other', true),
    fileTreeLeafId('selected'),
    'Filtered expansion must allow focus on an otherwise collapsed match',
  );
  assert.equal(resolveFileTreeFocus([], new Set(), 'removed-node', 'missing-entry'), undefined);
  assert.equal(resolveFileTreeFocus(tree, new Set(), 'removed-node', 'missing-entry'), tree[0].id);
});

test('selection can follow an entry moved to a new branch without focusing a stale folder', () => {
  const before = buildFileTree([item('moved', 'skills/review/checks.md')]);
  const oldFolder = fileTreeAncestors(before, 'moved').at(-1);
  const after = buildFileTree([
    item('other', 'AGENTS.md'),
    item('moved', 'memory/archive/checks.md'),
  ]);
  assert.equal(
    resolveFileTreeFocus(after, new Set(), oldFolder, 'moved'),
    fileTreeLeafId('moved'),
  );
  const newAncestors = fileTreeAncestors(after, 'moved');
  assert.deepEqual(
    newAncestors.map((id) => flattenFileTree(after).find((node) => node.id === id)?.path),
    ['memory', 'memory/archive'],
  );
});

test('typeahead cycles visible basename matches, including folders, without entering collapsed descendants', () => {
  const tree = buildFileTree([
    item('hidden', 'checks/hidden.md'),
    item('first', 'checks.md'),
    item('second', 'CHECKLIST.md'),
    item('third', 'notes.md'),
  ]);
  const checksFolder = fileTreeAncestors(tree, 'hidden')[0];
  const visible = flattenFileTree(tree, new Set([checksFolder]));
  assert.equal(fileTreeTypeahead(visible, checksFolder, 'ch'), fileTreeLeafId('first'));
  assert.equal(fileTreeTypeahead(visible, fileTreeLeafId('first'), 'CH'), fileTreeLeafId('second'));
  assert.equal(fileTreeTypeahead(visible, fileTreeLeafId('second'), 'ch'), checksFolder);
  assert.equal(fileTreeTypeahead(visible, checksFolder, 'checkl'), fileTreeLeafId('second'));
  assert.equal(fileTreeTypeahead(visible, checksFolder, 'hidden'), undefined);
  assert.equal(fileTreeTypeahead(visible, checksFolder, 'missing'), undefined);
});
