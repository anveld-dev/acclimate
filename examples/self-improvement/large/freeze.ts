import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { largeDataset } from './domain.js';
const args = process.argv.slice(2);
if (!args.includes('--output')) throw new Error('Use --output NEW_PRIVATE_DIRECTORY');
const output = path.resolve(args[args.indexOf('--output') + 1]!);
await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
const frozen = largeDataset(randomUUID());
if (args.includes('--with-future')) frozen.future = largeDataset(randomUUID()).batches[0]!;
const raw = JSON.stringify(frozen);
await writeFile(path.join(output, 'frozen-dataset.json'), raw + '\n', { mode: 0o600, flag: 'wx' });
await writeFile(
  path.join(output, 'experiment.json'),
  JSON.stringify(
    {
      frozenAt: new Date().toISOString(),
      datasetDigest: createHash('sha256').update(raw).digest('hex'),
      metrics: frozen.metrics,
      repetitions: 2,
      maximumSdkTurns: 20,
      jobDeadlineSeconds: 360,
      futureJobViews: frozen.future?.incidents.length ?? 0,
      releaseGate:
        'complete inventory, >=95% exact decisions, zero unsafe decisions, higher accuracy than original, all 32 alias pairs checked and consistent per repetition',
      policy: 'same fixed v2 contract; no new facts or audit feedback reach the learning loop',
      purpose:
        'large distributed evidence, irrelevant receipt history, cross-job consistency and transfer to new currencies/regions',
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600, flag: 'wx' },
);
console.log(JSON.stringify({ output, metrics: frozen.metrics }, null, 2));
