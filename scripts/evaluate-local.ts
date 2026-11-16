// Retired entrypoint: do not inspect or migrate legacy launcher state automatically.
console.error('evaluate:local is retired. Configure a private schemaVersion 1 evaluator file, then use npm run evaluate:app -- --config /absolute/private/config.json --bundleID UUID --requestID UUID --adapter NAME. See examples/evaluation/README.md for explicit migration and journal recovery.');
process.exitCode = 1;
