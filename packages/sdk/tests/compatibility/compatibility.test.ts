import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compatibilityIssues, assertCompatible } from '../../src/compatibility.js';
import type { BundlePayload, CompatibilityTarget } from '../../src/types.js';
const fixtures = JSON.parse(
  await readFile(
    new URL('../../../../contracts/fixtures/native-compatibility.json', import.meta.url),
    'utf8',
  ),
) as Array<{
  name: string;
  target: CompatibilityTarget;
  files: BundlePayload['files'];
  codes: string[];
}>;
for (const fixture of fixtures)
  test(`compatibility parity: ${fixture.name}`, () => {
    const payload: BundlePayload = { schemaVersion: 1, files: fixture.files };
    assert.deepEqual(
      compatibilityIssues(payload, fixture.target).map((issue) => issue.code),
      fixture.codes,
    );
    if (fixture.codes.length) assert.throws(() => assertCompatible(payload, fixture.target));
    else assert.doesNotThrow(() => assertCompatible(payload, fixture.target));
  });

test('instruction count message names every instruction file', () => {
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [
      { path: 'a.md', kind: 'instruction', text: 'A' },
      { path: 'b.md', kind: 'instruction', text: 'B' },
    ],
  };
  const [issue] = compatibilityIssues(payload, 'claude');
  assert.equal(issue?.code, 'instruction_count');
  assert.match(issue.message, /found 2: a\.md, b\.md/);
});

test('assertCompatible names the rule and reason without quoting file text', () => {
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [
      {
        path: 'skills/check/SKILL.md',
        kind: 'skill',
        text: '---\nname: wrong\ndescription: Secret details\n---\nBody',
      },
    ],
  };
  assert.throws(
    () => assertCompatible(payload, 'codex'),
    (error: Error & { code?: string; issues?: unknown[] }) => {
      assert.equal(error.code, 'invalid_payload');
      assert.equal(error.issues?.length, 1);
      assert.match(error.message, /^skills\/check\/SKILL\.md: \[skill_metadata\] /);
      assert.match(error.message, /exactly one name: check \(found "wrong"\)/);
      assert.doesNotMatch(error.message, /Secret|Body/);
      return true;
    },
  );
});

test('metadata messages omit declared names that are not valid skill names', () => {
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [
      {
        path: 'skills/check/SKILL.md',
        kind: 'skill',
        text: '---\nname: Body text here\ndescription: Checks things\n---\nBody',
      },
    ],
  };
  const [issue] = compatibilityIssues(payload, 'codex');
  assert.equal(issue?.code, 'skill_metadata');
  assert.doesNotMatch(issue.message, /Body/);
});
