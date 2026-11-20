#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EvaluationError, exitCodeFor, toSafeDiagnostic } from '../evaluation/errors.js';
import { captureLearningApp, serveLearningLoop, type LearningLoopApp } from './loop.js';

const usage = `Usage
  acclimate-learning --config /private/evaluator.json --bundle UUID --app ./learning-app.mjs [--live]
  acclimate-learning held-out --app ./learning-app.mjs

Default-export { execute, grade, heldOut } and set execution to 'model-free' or 'live'.`;

async function main(argv: string[]) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const heldOut = argv[0] === 'held-out';
  let values;
  try {
    const args = parseArgs({
      args: heldOut ? argv.slice(1) : argv,
      options: {
        app: { type: 'string' },
        config: { type: 'string' },
        bundle: { type: 'string' },
        live: { type: 'boolean' },
      },
    });
    if (
      !args.values.app ||
      (heldOut
        ? args.values.config || args.values.bundle || args.values.live
        : !args.values.config || !args.values.bundle)
    )
      throw new Error();
    values = args.values;
  } catch {
    console.error(usage);
    return 1;
  }
  try {
    let app: LearningLoopApp;
    try {
      app = (await import(pathToFileURL(path.resolve(values.app!)).href)).default;
    } catch {
      throw new EvaluationError('application.import_failed');
    }
    if (heldOut) {
      const { cases, digest } = captureLearningApp(app);
      console.log(JSON.stringify({ digest, cases: cases.length }));
      return 0;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await serveLearningLoop({
        configPath: path.resolve(values.config!),
        bundleId: values.bundle!,
        app,
        allowLive: values.live,
        signal: controller.signal,
        onDiagnostic: (diagnostic) => console.error(JSON.stringify(diagnostic)),
      });
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return 0;
  } catch (error) {
    const diagnostic = toSafeDiagnostic(error, 'configure');
    console.error(JSON.stringify(diagnostic));
    console.error(usage);
    return exitCodeFor(diagnostic);
  }
}

process.exitCode = await main(process.argv.slice(2));
