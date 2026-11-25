import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesRelease } from '../src/lib/release-search';

const release = {
  revision: '2',
  version: {
    id: '62224193-0000-4000-8000-000000000000',
    digest: 'sha256:abcdef01',
    parentVersionId: null,
    bundleId: 'bundle',
    createdAt: '',
  },
};

test('displayed numeric version prefixes still find the release', () => {
  for (const query of ['62224193', ' 2 ', '#2', 'Revision 2', 'sha256:abcd', 'ABCDEF', '']) {
    assert.equal(matchesRelease(release, query), true, query);
  }
  for (const query of ['#62224193', 'revision 62224193', '#1', 'missing']) {
    assert.equal(matchesRelease(release, query), false, query);
  }
});

test('repeated content matches each revision independently', () => {
  const releases = [release, { ...release, revision: '3' }];
  assert.equal(releases.filter((item) => matchesRelease(item, '62224193')).length, 2);
  assert.equal(releases.filter((item) => matchesRelease(item, '#2')).length, 1);
});
