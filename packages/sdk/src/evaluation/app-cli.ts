import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { bindResidentBuild, importInstalledApplication } from './application-modules.js';
import { assertCaseInventory, defineEvaluation } from './definition.js';
import { canonicalEvaluationJson, createEvaluationManifest } from './manifest.js';
import {
  ADAPTER_FREE_COMMANDS,
  evaluationMain,
  evaluationReadMain,
  parseEvaluatorArguments,
  reportEvaluatorError,
  sdkVersion,
} from './cli.js';
import { TRY_USAGE } from './local-cli.js';
import { pullHelp } from './pull.js';
import { AppSetupError as SetupError, DefinitionError, EvaluationError, EXIT_CODES } from './errors.js';
import type { ApplicationAdapter } from './application.js';
import type { EvaluationCase } from './types.js';

export { defineApplication } from './application.js';
export type { ApplicationAdapter } from './application.js';

const adapterExports = [
  'cases',
  'execute',
  'grade',
  'revisionFiles',
  'configId',
  'concurrency',
  'gradeRetries',
  'grader',
  'runtime',
  'toReviewArtifact',
  'execution',
];

const help = `Compare your agent using its installed application.mjs or application.mts.
Export cases, execute and grade from that module in your current directory, or export a
default object built with defineApplication({ cases, execute, grade }).
Select a different entry with --app PATH, for example: acclimate-eval describe --app dist/application.mjs.

Try it locally first. These need no service, config or handoff:

  acclimate-eval try [--live] [--case ID] [--payload FILE|DIR]
  acclimate-eval compare --local --parent FILE|DIR --candidate FILE|DIR [--live] [--policy POLICY]

Then compare against the service to gate a release:

  acclimate-eval compare --config CONFIG --handoff HANDOFF [--live] [--policy POLICY] [--json]
  acclimate-eval compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME [--name RUN_NAME]) [--live] [--policy POLICY] [--json]

Run controls for compare and run: --deadline 30m, --case-timeout 2m, --max-cost-usd 5,
--cases ID,ID or --shard 1/4 (partial, never full coverage), --progress or --quiet.
Use pull to save a published bundle as a payload file to edit.

Commands: try, compare, describe, coverage, doctor, request, run, check, status, interrupt, export, verify-export, pull.
status, verify-export, interrupt and pull run without loading application code.
Run acclimate-eval COMMAND --help for one command's flags.

Global flags: --json (machine-readable errors on stderr), --verbose (stack traces; or set
ACCLIMATE_DEBUG=1), --version, --help.
Exit codes: 0 ok, 1 fix command/config/application, 2 quality gate failed, 3 indeterminate,
4 run or service failed, 5 recovery required.`;

const commandHelp: Record<string, string> = {
  compare: help,
  describe: 'describe [--app PATH]  Print the public descriptor for these callbacks and cases.',
  try: TRY_USAGE,
  coverage: 'coverage [--app PATH]  Inspect bound local sources, imported packages and declared revisions.',
  doctor: 'doctor --config CONFIG (--bundle ID | --handoff FILE | --name RUN_NAME) [--policy POLICY]',
  request: 'request --config CONFIG --bundle ID --channel CHANNEL --payload FILE --intent FILE --out HANDOFF [--policy POLICY]',
  run: 'run --config CONFIG (--handoff FILE | --name RUN_NAME) [--live]',
  status: 'status (--config CONFIG | --read-config READER) --handoff FILE\nstatus --config CONFIG --name RUN_NAME\nRuns without loading application code.',
  check: 'check (--config CONFIG | --read-config READER) --handoff FILE --policy POLICY\ncheck --config CONFIG --name RUN_NAME --policy POLICY',
  export: 'export (--config CONFIG | --read-config READER) --handoff FILE --out DIRECTORY [--selection FILE]\nexport --config CONFIG --name RUN_NAME --out DIRECTORY [--selection FILE]',
  interrupt: 'interrupt --config CONFIG (--handoff FILE | --name RUN_NAME) --reason REASON\nRuns without loading application code.',
  'verify-export': 'verify-export --manifest FILE [--read-config READER --handoff FILE]\nRuns without loading application code.',
  pull: pullHelp + '\nRuns without loading application code.',
};

async function readCases(filename: string): Promise<EvaluationCase[]> {
  if (!isAbsolute(filename)) {
    throw new SetupError(
      'Set ACCLIMATE_EVALUATOR_CASES to the absolute path of your private case file.',
      { field: 'ACCLIMATE_EVALUATOR_CASES' },
    );
  }
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    throw new SetupError('Cannot open the private case file. Check its path and access.', {
      field: 'ACCLIMATE_EVALUATOR_CASES',
      reason: filename,
      cause: error,
    });
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid?.()) {
      throw new SetupError(
        'The case file must be a regular file owned by this user, with mode 0400 or 0600.',
      );
    }
    if (info.size > 16 * 1024 * 1024) throw new SetupError('The case file exceeds 16 MiB.');
    const text = await file.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SetupError('The private case file must contain a valid JSON array.', {
        field: 'ACCLIMATE_EVALUATOR_CASES',
        cause: error,
      });
    }
  } finally {
    await file.close();
  }
}

async function hashRevisionFiles(directory: string, files: readonly string[]) {
  if (
    !Array.isArray(files) ||
    files.some((file) => typeof file !== 'string' || !file || isAbsolute(file)) ||
    new Set(files).size !== files.length
  ) {
    throw new SetupError(
      'revisionFiles must contain distinct file paths relative to your application module.',
      { field: 'revisionFiles' },
    );
  }
  const digests = new Map<string, string>();
  for (const file of files) {
    const hash = createHash('sha256');
    try {
      for await (const bytes of createReadStream(resolve(directory, file))) hash.update(bytes);
    } catch (error) {
      throw new SetupError(
        'Cannot read a declared revisionFiles entry. Check the paths relative to your application module.',
        { field: `revisionFiles: ${file}`, cause: error },
      );
    }
    digests.set(file, hash.digest('hex'));
  }
  return (
    'sha256:' +
    createHash('sha256')
      .update(canonicalEvaluationJson(Object.fromEntries(digests)))
      .digest('hex')
  );
}

/** Find the application entry. Adds a warning when both .mjs and .mts entries exist. */
export async function resolveApplicationFile(
  directory: string,
  explicit?: string,
  warnings: string[] = [],
) {
  if (explicit) {
    try {
      return await realpath(resolve(directory, explicit));
    } catch (error) {
      throw new SetupError('Cannot read --app PATH. Supply the path to your installed application module.', {
        field: '--app',
        reason: resolve(directory, explicit),
        cause: error,
      });
    }
  }
  const found: string[] = [];
  for (const name of ['application.mjs', 'application.mts']) {
    try {
      found.push(await realpath(resolve(directory, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new SetupError('Cannot read the installed application module.', {
          field: name,
          cause: error,
        });
    }
  }
  if (found.length > 1)
    warnings.push(
      'Found both application.mjs and application.mts. Using application.mjs. Pass --app to choose the other.',
    );
  if (found.length) return found[0];
  throw new SetupError(
    'Add application.mjs or application.mts to your application directory with cases, execute and grade exports, or pass --app PATH.',
    { hint: `Looked in ${directory}.` },
  );
}

/** Use named exports when present, otherwise a default-exported adapter object. */
function selectAdapter(module: Record<string, unknown>): ApplicationAdapter {
  const named = adapterExports.some((name) => Object.hasOwn(module, name));
  const fallback = module.default;
  if (!named && fallback && typeof fallback === 'object') return fallback as ApplicationAdapter;
  return module as unknown as ApplicationAdapter;
}

function wrapDefinitionError(error: unknown, prefix = ''): never {
  if (error instanceof DefinitionError)
    throw new SetupError(`The application's evaluation definition is invalid. ${prefix + error.field}: ${error.reason}`, {
      code: 'definition.invalid',
      field: prefix + error.field,
      reason: error.reason,
      cause: error,
    });
  throw error;
}

export async function loadApplication(directory = process.cwd(), appPath?: string) {
  const warnings: string[] = [];
  const filename = await resolveApplicationFile(directory, appPath, warnings);
  const imported = await importInstalledApplication(filename);
  const { installedAdapter, imports, packages } = imported;
  const adapter = selectAdapter(imported.adapter as unknown as Record<string, unknown>);
  const missing = (['execute', 'grade'] as const).filter((name) => typeof adapter[name] !== 'function');
  if (missing.length)
    throw new SetupError(
      `Your application module does not export ${missing.join(' or ')} as a function.`,
      {
        field: missing[0],
        hint: 'Export execute and grade functions by name, or export default defineApplication({ cases, execute, grade }).',
      },
    );
  const execution = adapter.execution ?? 'live';
  if (execution !== 'live' && execution !== 'model-free')
    throw new SetupError('The execution export must be "live" or "model-free".', { field: 'execution' });
  const caseFile = process.env.ACCLIMATE_EVALUATOR_CASES;
  const cases = caseFile ? await readCases(caseFile) : adapter.cases;
  if (cases === undefined)
    throw new SetupError('Export your cases array or set ACCLIMATE_EVALUATOR_CASES to its private JSON file.', {
      field: 'cases',
    });
  try {
    assertCaseInventory(cases, caseFile ? 'ACCLIMATE_EVALUATOR_CASES' : 'cases');
  } catch (error) {
    wrapDefinitionError(error);
  }
  if (adapter.configId !== undefined && (typeof adapter.configId !== 'string' || !adapter.configId.trim()))
    throw new SetupError('configId must be a nonempty string.', { field: 'configId' });
  const artifacts = adapter.runtime?.artifacts ?? {};
  for (const [name, digest] of Object.entries(artifacts))
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest))
      throw new SetupError('Each runtime.artifacts entry must map a short name to a sha256:<64 hex> digest.', {
        field: `runtime.artifacts.${name}`,
      });
  if (
    Object.hasOwn(artifacts, 'installedAdapter') ||
    Object.hasOwn(artifacts, 'revisionFiles') ||
    Object.hasOwn(artifacts, 'importedFiles')
  ) {
    throw new SetupError(
      'The SDK supplies installedAdapter, importedFiles and revisionFiles artifact identities.',
      { field: 'runtime.artifacts' },
    );
  }
  const revisionFiles =
    adapter.revisionFiles === undefined
      ? undefined
      : await hashRevisionFiles(dirname(filename), adapter.revisionFiles);
  // Already-declared files were bound by earlier releases. Preserve their original
  // descriptor and only add an identity for previously uncovered imports.
  const declaredPaths = new Set(
    (adapter.revisionFiles ?? []).map((file) => resolve(dirname(filename), file)),
  );
  const additional = Object.fromEntries(
    Object.entries(imports).filter(
      ([file]) => !declaredPaths.has(resolve(dirname(filename), file)),
    ),
  );
  const importedFiles = Object.keys(additional).length
    ? 'sha256:' + createHash('sha256').update(canonicalEvaluationJson(additional)).digest('hex')
    : undefined;
  const revisions = [installedAdapter, revisionFiles, importedFiles].filter(Boolean);
  const graderDigest =
    revisions.length === 1
      ? installedAdapter
      : 'sha256:' + createHash('sha256').update(revisions.join('\n')).digest('hex');
  let manifest;
  try {
    manifest = createEvaluationManifest({
      configId: adapter.configId ?? 'application',
      execution,
      ...(adapter.concurrency !== undefined ? { concurrency: adapter.concurrency } : {}),
      ...(adapter.gradeRetries !== undefined ? { gradeRetries: adapter.gradeRetries } : {}),
      cases,
      grader: adapter.grader ?? { artifactDigest: graderDigest },
      runtime: {
        settings: adapter.runtime?.settings ?? {},
        artifacts: {
          ...artifacts,
          installedAdapter,
          ...(revisionFiles ? { revisionFiles } : {}),
          ...(importedFiles ? { importedFiles } : {}),
        },
      },
    });
  } catch (error) {
    if (!(error instanceof EvaluationError) || error.code !== 'config.schema') throw error;
    throw new SetupError('The application exports cannot form an evaluation manifest.', {
      code: 'definition.invalid',
      field: 'grader, runtime.settings or configId',
      reason:
        'Use JSON runtime.settings, a grader of { sourceUtf8 } or { artifactDigest: "sha256:..." }, and a configId of at most 128 bytes.',
      cause: error,
    });
  }
  bindResidentBuild(
    filename,
    manifest.descriptor.runtime.runtimeRevision + '/' + manifest.descriptor.graderRevision,
  );
  let app;
  try {
    app = defineEvaluation({
      ...manifest.definition,
      execute: adapter.execute,
      grade: adapter.grade,
    });
  } catch (error) {
    wrapDefinitionError(error);
  }
  const mapper = adapter.toReviewArtifact;
  if (mapper !== undefined && typeof mapper !== 'function') {
    throw new SetupError('toReviewArtifact must be a function when supplied.', {
      field: 'toReviewArtifact',
    });
  }
  const coverage = {
    adapter: relative(await realpath(directory), filename),
    execution,
    importedFiles: Object.keys(imports).sort(),
    packageImports: packages,
    revisionFiles: [...(adapter.revisionFiles ?? [])].sort(),
    artifacts: Object.keys(artifacts).sort(),
    limits:
      'Local imports reached while loading the adapter are bound. List package builds, deferred imports and runtime-read assets in revisionFiles or runtime.artifacts.',
  };
  return { app, review: mapper && { toReviewArtifact: mapper }, coverage, warnings };
}

function coverageText(coverage: Awaited<ReturnType<typeof loadApplication>>['coverage']) {
  const list = (items: readonly string[]) => (items.length ? items.join(', ') : 'none');
  return [
    `Adapter          ${coverage.adapter}`,
    `Execution        ${coverage.execution}`,
    `Imported files   ${list(coverage.importedFiles)}`,
    `Package imports  ${list(coverage.packageImports)}`,
    `Revision files   ${list(coverage.revisionFiles)}`,
    `Artifacts        ${list(coverage.artifacts)}`,
    '',
    coverage.limits,
  ].join('\n');
}

export async function applicationMain(argv = process.argv.slice(2), directory = process.cwd()) {
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (!wantsHelp && (argv.includes('--version') || argv.includes('-V'))) {
    console.log(sdkVersion());
    return EXIT_CODES.ok;
  }
  if (wantsHelp) {
    console.log(Object.hasOwn(commandHelp, argv[0]) ? commandHelp[argv[0]] : help);
    return EXIT_CODES.ok;
  }
  if (argv.length === 0) {
    // An empty $CMD in CI must fail, not pass.
    process.stderr.write(help + '\n\n');
    return reportEvaluatorError(
      new EvaluationError('usage.missing_command', { hint: 'Choose a command, for example describe or compare.' }),
      argv,
    );
  }
  let installed;
  let command = 'invalid';
  try {
    const flag = argv.indexOf('--app');
    let appPath: string | undefined;
    if (flag >= 0) {
      appPath = argv[flag + 1];
      if (!appPath || appPath.startsWith('-') || argv.lastIndexOf('--app') !== flag) {
        throw new SetupError('Supply --app PATH once with your application module path.', {
          code: 'application.invalid',
          field: '--app',
        });
      }
      argv = [...argv.slice(0, flag), ...argv.slice(flag + 2)];
    }
    // Validate the command line before importing application code.
    command = parseEvaluatorArguments(argv).command;
    if (ADAPTER_FREE_COMMANDS.includes(command)) return evaluationReadMain(argv);
    installed = await loadApplication(directory, appPath);
    for (const warning of installed.warnings) process.stderr.write(`warning: ${warning}\n`);
    if (command === 'coverage') {
      const terminal = process.stdout.isTTY === true && !argv.includes('--json');
      console.log(terminal ? coverageText(installed.coverage) : JSON.stringify(installed.coverage, null, 2));
      return EXIT_CODES.ok;
    }
  } catch (error) {
    return reportEvaluatorError(error, argv, command);
  }
  return evaluationMain(installed.app, argv, { review: installed.review });
}
