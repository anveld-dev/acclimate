import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalEvaluationJson,
  createEvaluationManifest,
  restoreEvaluationManifest,
  type EvaluationManifestInput,
} from '../../src/evaluation/manifest.js';
import { defineEvaluation } from '../../src/evaluation/definition.js';
import { EvaluationError } from '../../src/evaluation/errors.js';
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../tests/conformance/evaluation-manifest-v1.json', import.meta.url),
    'utf8',
  ),
);
const input = (): EvaluationManifestInput => structuredClone(fixture.input);
const invalid = (action: () => unknown) =>
  assert.throws(
    action,
    (e: unknown) =>
      e instanceof EvaluationError && e.code === 'config.schema' && !String(e).includes('canary'),
  );

test('shared canonical bytes, binary64 vectors and descriptor match Python', () => {
  for (const vector of fixture.canonicalVectors) {
    const canonical = canonicalEvaluationJson(vector.value);
    assert.equal(canonical, vector.canonical, vector.name);
    assert.equal('sha256:' + createHash('sha256').update(canonical).digest('hex'), vector.sha256);
  }
  const manifest = createEvaluationManifest(input());
  assert.equal(manifest.privateManifestJson, fixture.privateManifestJson);
  assert.deepEqual(manifest.descriptor, fixture.descriptor);
  assert.deepEqual(
    restoreEvaluationManifest(fixture.privateManifestJson).descriptor,
    manifest.descriptor,
  );
  const app = defineEvaluation({
    ...manifest.definition,
    execute: async ({ input }) => ({ output: input }),
    grade: async () => ({ reward: 1 }),
  });
  assert.deepEqual(app.descriptor, manifest.descriptor);
  assert.ok(!JSON.stringify(manifest.descriptor).includes('private-'));
  assert.ok(manifest.privateManifestJson.includes('private-expected-canary'));
});

test('captures inputs and isolates every structured accessor', () => {
  const original = input(),
    manifest = createEvaluationManifest(original),
    frozen = manifest.privateManifestJson;
  original.cases[0].expected = 'changed';
  original.runtime.settings.temperature = 0.8;
  manifest.definition.cases[0].expected = 'changed';
  manifest.privateManifest.cases[0].input = 'changed';
  manifest.descriptor.runtime.configRevision = 'changed';
  assert.equal(manifest.privateManifestJson, frozen);
  assert.deepEqual(manifest.descriptor, fixture.descriptor);
  assert.deepEqual(
    createEvaluationManifest({ ...input(), cases: [...input().cases].reverse() }).descriptor,
    manifest.descriptor,
  );
  const reordered = input();
  reordered.runtime.settings = Object.fromEntries(
    Object.entries(reordered.runtime.settings).reverse(),
  );
  assert.deepEqual(createEvaluationManifest(reordered).descriptor, manifest.descriptor);
});

test('content, repetition, settings, grader and build changes bind distinct revisions', () => {
  const original = createEvaluationManifest(input()).descriptor;
  const changes: Array<[string, (x: EvaluationManifestInput) => void]> = [
    [
      'datasetRevision',
      (x) => {
        x.cases[0].input = 'changed';
      },
    ],
    [
      'datasetRevision',
      (x) => {
        x.cases[0].expected = 'changed';
      },
    ],
    [
      'datasetRevision',
      (x) => {
        x.cases[0].repetitions = 3;
      },
    ],
    [
      'graderRevision',
      (x) => {
        x.grader = { sourceUtf8: '# changed\n' };
      },
    ],
    [
      'graderRevision',
      (x) => {
        x.grader = { artifactDigest: 'sha256:' + 'c'.repeat(64) };
      },
    ],
    [
      'runtime',
      (x) => {
        x.runtime.settings.temperature = 0.2;
      },
    ],
    [
      'runtime',
      (x) => {
        x.runtime.artifacts.executor = 'sha256:' + 'c'.repeat(64);
      },
    ],
  ];
  for (const [field, change] of changes) {
    const value = input();
    change(value);
    const descriptor = createEvaluationManifest(value).descriptor;
    assert.notDeepEqual(
      descriptor[field as keyof typeof descriptor],
      original[field as keyof typeof original],
    );
    assert.notEqual(descriptor.runtime.configRevision, original.runtime.configRevision);
  }
  assert.equal(canonicalEvaluationJson({ x: -0 }), canonicalEvaluationJson({ x: 0 }));
  assert.notEqual(canonicalEvaluationJson([1, 2]), canonicalEvaluationJson([2, 1]));
});

test('rejects ambiguous and nonportable data without reading accessors/proxies', () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    1e100,
    undefined,
    BigInt(1),
    new Date(),
    '\ud800',
    { '\udfff': 1 },
    new Array(1),
    Object.assign([1], { extra: 1 }),
  ])
    invalid(() => canonicalEvaluationJson(value));
  const cycle: unknown[] = [];
  cycle.push(cycle);
  invalid(() => canonicalEvaluationJson(cycle));
  let read = false;
  invalid(() =>
    canonicalEvaluationJson({
      get secret() {
        read = true;
        return 1;
      },
    }),
  );
  invalid(() =>
    canonicalEvaluationJson(
      new Proxy(
        {},
        {
          ownKeys() {
            read = true;
            return [];
          },
        },
      ),
    ),
  );
  assert.equal(read, false);
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = [deep];
  invalid(() => canonicalEvaluationJson(deep));
  invalid(() => canonicalEvaluationJson(Array(100001).fill(null)));
  invalid(() => canonicalEvaluationJson(Array(17000).fill(Number.MIN_VALUE)));
});

test('closed manifests reject unknown fields, duplicate decoded keys and invalid inventory', () => {
  for (const change of [
    (x: any) => {
      x.extra = true;
    },
    (x: any) => {
      x.cases[0].extra = true;
    },
    (x: any) => {
      x.runtime.extra = true;
    },
    (x: any) => {
      x.grader.extra = true;
    },
    (x: any) => {
      x.cases.push(x.cases[0]);
    },
    (x: any) => {
      x.cases[0].repetitions = 1001;
    },
    (x: any) => {
      x.runtime.artifacts = {};
    },
    (x: any) => {
      x.grader.artifactDigest = 'sha256:' + 'a'.repeat(64);
    },
  ]) {
    const x = input();
    change(x);
    invalid(() => createEvaluationManifest(x));
  }
  for (const text of [
    fixture.privateManifestJson.replace('{', '{"schema":"wrong",'),
    '{"schema":"a","sch\\u0065ma":"b"}',
    fixture.privateManifestJson.replace('"schema":', '"unknown":'),
    fixture.privateManifestJson.replace('acclimate-evaluation-manifest-v1', 'v2'),
    fixture.privateManifestJson.replace(
      '0.1000000000000000055511151231257827021181583404541015625',
      '1e999',
    ),
  ])
    invalid(() => restoreEvaluationManifest(text));
});

test('shared restoration vectors normalize integer/exponent spellings throughout private payloads', () => {
  const vector = fixture.restoration;
  for (const spelling of vector.integralSpellings) {
    const text = vector.privateManifestJson
      .replace('"repetitions":1', '"repetitions":' + spelling)
      .replaceAll('"nested":[1,0]', '"nested":[' + spelling + ',-0.0]');
    const restored = restoreEvaluationManifest(text);
    assert.equal(restored.privateManifestJson, vector.privateManifestJson);
    assert.deepEqual(restored.descriptor, vector.descriptor);
    assert.deepEqual(restored.definition.cases, JSON.parse(vector.privateManifestJson).cases);
  }
  for (const spelling of vector.invalidRepetitionSpellings) {
    invalid(() =>
      restoreEvaluationManifest(
        vector.privateManifestJson.replace('"repetitions":1', '"repetitions":' + spelling),
      ),
    );
  }
  invalid(() =>
    restoreEvaluationManifest(
      vector.privateManifestJson.replace('"repetitions":1', '"repetitions":1.0,"repetitions":1'),
    ),
  );
});

test('shared explicit blank identity classification is independent of native trim', () => {
  const blanks = fixture.restoration.blankIdentityCodepoints.map((code: number) =>
    String.fromCodePoint(code),
  );
  for (const blank of [...blanks, blanks.join('')]) {
    for (const field of ['configId', 'caseId']) {
      const value = input();
      if (field === 'configId') value.configId = blank;
      else value.cases[0].caseId = blank;
      invalid(() => createEvaluationManifest(value));
      const saved = JSON.parse(fixture.privateManifestJson);
      if (field === 'configId') saved.configId = blank;
      else saved.cases[0].caseId = blank;
      invalid(() => restoreEvaluationManifest(JSON.stringify(saved)));
    }
  }
  for (const blank of ['\u0085', '\ufeff']) {
    const value = input();
    value.configId = 'x' + blank;
    value.cases[0].caseId = blank + 'x';
    const captured = createEvaluationManifest(value);
    assert.deepEqual(
      restoreEvaluationManifest(captured.privateManifestJson).descriptor,
      captured.descriptor,
    );
    assert.equal(captured.descriptor.runtime.configId, 'x' + blank);
  }
});
