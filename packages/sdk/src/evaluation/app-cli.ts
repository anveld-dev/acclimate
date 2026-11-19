import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  AppSetupError as SetupError,
  bindResidentBuild,
  importInstalledApplication,
} from './application-modules.js';
import { defineEvaluation } from './definition.js';
import { canonicalEvaluationJson, createEvaluationManifest } from './manifest.js';
import { evaluationMain, evaluationReadMain } from './cli.js';
import { EvaluationError } from './errors.js';
import type { EvaluationManifestInput } from './manifest.js';
import type { EvaluationCase, EvaluationDefinition, Json } from './types.js';
import type { ReviewMapper } from './artifacts.js';

export interface ApplicationAdapter<I = Json, E = Json, O = Json>
  extends Pick<EvaluationDefinition<I, E, O>, 'execute' | 'grade'> {
  cases?: readonly EvaluationCase<I, E>[];
  revisionFiles?: readonly string[];
  configId?: string;
  grader?: EvaluationManifestInput['grader'];
  runtime?: Partial<EvaluationManifestInput['runtime']>;
  toReviewArtifact?: ReviewMapper;
}

const help = `Compare your agent using its installed application.mjs or application.mts.
Export cases, execute and grade from that module in your current directory.
Select a different entry with --app PATH, for example: acclimate-eval describe --app dist/application.mjs.
Run coverage to inspect bound sources and packages. status and verify-export run without application code.

  acclimate-eval compare --config CONFIG --handoff HANDOFF --live [--policy POLICY] [--json]
  acclimate-eval compare --config CONFIG --bundle ID --channel CHANNEL --payload FILE (--name RUN_NAME | --retry-after PRIOR_NAME) --live [--policy POLICY] [--json]

Reuse RUN_NAME to recover the same change. Use describe for your public descriptor,
doctor to check setup, plan to size the evaluation for your policy, or request, run, check,
status, interrupt, export and verify-export.`;

const commandHelp: Record<string, string> = {
  compare: help,
  describe: 'describe [--app PATH]  Print the public descriptor for these callbacks and cases.',
  coverage: 'coverage [--app PATH]  Inspect bound local sources, imported packages and declared revisions.',
  doctor: 'doctor --config CONFIG (--bundle ID | --handoff FILE | --name RUN_NAME) [--policy POLICY]',
  request: 'request --config CONFIG --bundle ID --channel CHANNEL --payload FILE --intent FILE --out HANDOFF [--policy POLICY]',
  run: 'run --config CONFIG (--handoff FILE | --name RUN_NAME) --live',
  status: 'status (--config CONFIG | --read-config READER) --handoff FILE\nstatus --config CONFIG --name RUN_NAME',
  check: 'check (--config CONFIG | --read-config READER) --handoff FILE --policy POLICY\ncheck --config CONFIG --name RUN_NAME --policy POLICY',
  export: 'export (--config CONFIG | --read-config READER) --handoff FILE --out DIRECTORY [--selection FILE]\nexport --config CONFIG --name RUN_NAME --out DIRECTORY [--selection FILE]',
  interrupt: 'interrupt --config CONFIG (--handoff FILE | --name RUN_NAME) --reason REASON',
  'verify-export': 'verify-export --manifest FILE [--read-config READER --handoff FILE]',
  plan: 'plan --policy POLICY [--aa A_A_COMPARISON.json] [--effects 0,0.05] [--simulations N] [--seed N]\nEstimate the minimum detectable effect and simulate pass rates before running anything.',
};

async function readCases(filename: string): Promise<EvaluationCase[]> {
  if (!isAbsolute(filename)) {
    throw new SetupError(
      'Set ACCLIMATE_EVALUATOR_CASES to the absolute path of your private case file.',
    );
  }
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new SetupError('Cannot open the private case file. Check its path and access.');
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
    } catch {
      throw new SetupError('The private case file must contain a valid JSON array.');
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
    );
  }
  const digests = new Map<string, string>();
  for (const file of files) {
    const hash = createHash('sha256');
    try {
      for await (const bytes of createReadStream(resolve(directory, file))) hash.update(bytes);
    } catch {
      throw new SetupError(
        'Cannot read a declared revisionFiles entry. Check the paths relative to your application module.',
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

async function applicationFile(directory: string, explicit?: string) {
  if (explicit) {
    try {
      return await realpath(resolve(directory, explicit));
    } catch {
      throw new SetupError(
        'Cannot read --app PATH. Supply the path to your installed application module.',
      );
    }
  }
  for (const name of ['application.mjs', 'application.mts']) {
    try {
      return await realpath(resolve(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new SetupError('Cannot read the installed application module.');
    }
  }
  throw new SetupError(
    'Add application.mjs or application.mts to your application directory with cases, execute and grade exports, or pass --app PATH.',
  );
}

export async function loadApplication(directory = process.cwd(), appPath?: string) {
  const filename = await applicationFile(directory, appPath);
  const { adapter, installedAdapter, imports, packages } =
    await importInstalledApplication(filename);
  if (typeof adapter.execute !== 'function' || typeof adapter.grade !== 'function') {
    throw new SetupError('Your application module must export execute and grade functions.');
  }
  const cases = process.env.ACCLIMATE_EVALUATOR_CASES
    ? await readCases(process.env.ACCLIMATE_EVALUATOR_CASES)
    : adapter.cases;
  if (!Array.isArray(cases) || !cases.length) {
    throw new SetupError(
      'Export your cases array or set ACCLIMATE_EVALUATOR_CASES to its private JSON file.',
    );
  }
  const artifacts = adapter.runtime?.artifacts ?? {};
  if (
    Object.hasOwn(artifacts, 'installedAdapter') ||
    Object.hasOwn(artifacts, 'revisionFiles') ||
    Object.hasOwn(artifacts, 'importedFiles')
  ) {
    throw new SetupError(
      'The SDK supplies installedAdapter, importedFiles and revisionFiles artifact identities.',
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
  const manifest = createEvaluationManifest({
    configId: adapter.configId ?? 'application',
    execution: 'live',
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
  bindResidentBuild(
    filename,
    manifest.descriptor.runtime.runtimeRevision + '/' + manifest.descriptor.graderRevision,
  );
  const app = defineEvaluation({
    ...manifest.definition,
    execute: adapter.execute,
    grade: adapter.grade,
  });
  const mapper = adapter.toReviewArtifact;
  if (mapper !== undefined && typeof mapper !== 'function') {
    throw new SetupError('toReviewArtifact must be a function when supplied.');
  }
  const coverage = {
    adapter: relative(await realpath(directory), filename),
    importedFiles: Object.keys(imports).sort(),
    packageImports: packages,
    revisionFiles: [...(adapter.revisionFiles ?? [])].sort(),
    artifacts: Object.keys(artifacts).sort(),
    limits:
      'Local imports reached while loading the adapter are bound. List package builds, deferred imports and runtime-read assets in revisionFiles or runtime.artifacts.',
  };
  return { app, review: mapper && { toReviewArtifact: mapper }, coverage };
}

export async function applicationMain(argv = process.argv.slice(2), directory = process.cwd()) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(Object.hasOwn(commandHelp, argv[0]) ? commandHelp[argv[0]] : help);
    return 0;
  }
  let installed;
  try {
    const flag = argv.indexOf('--app');
    let appPath: string | undefined;
    if (flag >= 0) {
      appPath = argv[flag + 1];
      if (!appPath || appPath.startsWith('-') || argv.lastIndexOf('--app') !== flag) {
        throw new SetupError('Supply --app PATH once with your application module path.');
      }
      argv = [...argv.slice(0, flag), ...argv.slice(flag + 2)];
    }
    if (argv[0] === 'verify-export' || argv[0] === 'status') return evaluationReadMain(argv);
    installed = await loadApplication(directory, appPath);
    if (argv[0] === 'coverage') {
      if (argv.length !== 1)
        throw new SetupError('Use coverage [--app PATH] to list local code and revision files.');
      console.log(JSON.stringify(installed.coverage, null, 2));
      return 0;
    }
  } catch (error) {
    const message =
      error instanceof SetupError
        ? error.message
        : 'Check the private case array, configId, grader identity, runtime settings and artifact digests.';
    console.error(
      error instanceof EvaluationError && error.code === 'definition.report_budget_exceeded'
        ? 'The case inventory exceeds the comparison report size limit. Split the cases into smaller evaluations.'
        : message,
    );
    return 1;
  }
  return evaluationMain(installed.app, argv, { review: installed.review });
}
