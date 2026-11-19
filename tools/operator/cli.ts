import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { operatorMain } from '../../packages/sdk/src/operator/cli.js';

// The operator CLI ships in @acclimate/sdk as `acclimate-operator`. This entry keeps
// `npm run operator` working from a checkout.
export { operatorMain, operatorUsage, parseArgs, run } from '../../packages/sdk/src/operator/cli.js';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await operatorMain(process.argv.slice(2));
