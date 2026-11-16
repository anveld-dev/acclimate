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
