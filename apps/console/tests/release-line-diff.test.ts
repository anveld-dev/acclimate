import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseLineDiff } from '../src/lib/release-line-diff';
test('split release diff keeps matching parent and selected coordinates around replacements', () => {
  const rows = releaseLineDiff('a\nb\nc', 'a\nx\ny\nc');
  assert.deepEqual(
    rows.map((row) => [row.before?.number, row.after?.number, row.before?.text, row.after?.text]),
    [
      [1, 1, 'a', 'a'],
      [2, 2, 'b', 'x'],
      [undefined, 3, undefined, 'y'],
      [3, 4, 'c', 'c'],
    ],
  );
  assert.equal(rows[1].before?.changed, true);
  assert.equal(rows[0].after?.changed, false);
});
test('long context is folded without shifting source positions and first release files have only additions', () => {
  const lines = Array.from({ length: 10 }, (_, i) => String(i)).join('\n');
  const rows = releaseLineDiff(lines, lines + '\nadded');
  assert.equal(rows[2].skipped, 6);
  assert.equal(rows.at(-1)?.after?.number, 11);
  assert.deepEqual(releaseLineDiff(undefined, 'first'), [
    { before: undefined, after: { number: 1, text: 'first', changed: true } },
  ]);
});
