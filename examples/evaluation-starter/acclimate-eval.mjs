import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationMain, loadApplication as load } from '@acclimate/sdk/evaluation/app-cli';

const directory = fileURLToPath(new URL('.', import.meta.url));
export const loadApplication = () => load(directory);
export const main = (argv = process.argv.slice(2)) => applicationMain(argv, directory);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
