/** Qualification-only fault worker: commits real evidence, then exits before acknowledging it. */
import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { openLearningStore, type LearningOperation } from '@acclimate/sdk/learning';
import { applicationAdapter, type ApplicationConfig } from './application.js';

const index = process.argv.indexOf('--config');
assert(index > 0 && process.argv[index + 1], 'Explicit private worker configuration is required');
const filename = process.argv[index + 1]!;
const info = await lstat(filename);
assert(
  info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077),
  'Worker configuration must be owner-only',
);
const config = JSON.parse(await readFile(filename, 'utf8')) as {
  application: ApplicationConfig;
  directory: string;
  operation: LearningOperation;
};
const store = await openLearningStore(config.directory);
const receipt = await applicationAdapter(config.application).dispatch(config.operation, {
  artifacts: store,
  signal: AbortSignal.timeout(90_000),
});
assert.equal(receipt.status, 'succeeded');
assert.equal(receipt.output?.kind, 'evaluation');
await store.putArtifact({ schemaVersion: 1, kind: 'fault-worker-completed-receipt', receipt });
// The parent observes a failed worker, not this receipt. Recovery must inspect the retained operation.
process.exit(86);
