import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluationRequestLabels } from '../src/lib/evaluation-request-labels';

test('a requested handoff reports intent without claiming evaluator readiness', () => {
  const labels = evaluationRequestLabels(
    { id: 'request', datasetRevision: 'saved-app', status: 'requested' },
    false,
  );
  assert.equal(labels.status, 'Requested');
  assert.doesNotMatch(Object.values(labels).join(' '), /ready/i);
});

test('same datasets and colliding display prefixes retain distinct full actionable identities', () => {
  const requests = [
    '12345678-1111-4111-8111-111111111111',
    '12345678-2222-4222-8222-222222222222',
  ].map((id) => ({ id, datasetRevision: 'same-dataset', status: 'completed' as const }));
  const labels = requests.map((request, i) => evaluationRequestLabels(request, i === 0));
  assert.notEqual(labels[0].details, labels[1].details);
  assert.notEqual(labels[0].inspect, labels[1].inspect);
  requests.forEach((request, i) => {
    assert.ok(labels[i].details.includes(request.id));
    assert.ok(labels[i].inspect.includes(request.id));
    assert.ok(labels[i].inspect.includes(request.datasetRevision));
  });
  assert.match(labels[0].inspect, /Selected evidence/);
  assert.doesNotMatch(labels[1].inspect, /Selected evidence/);
});
