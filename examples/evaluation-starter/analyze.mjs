// Run from an application that installed @acclimate/sdk. No checkout imports.
//
//   node analyze.mjs --name RUN_NAME --config EVALUATOR_CONFIG [analysis-config.json]
//   node analyze.mjs comparison.json descriptor.json trusted-binding.json [analysis-config.json]
//
// --name reads the run's handoff from the evaluator journal and fetches the request and
// comparison from the service, so you do not assemble the trusted binding by hand.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AcclimateClient } from '@acclimate/sdk';
import { analyzeComparison } from '@acclimate/sdk/evaluation/analysis';

const usage =
  'Usage: node analyze.mjs --name RUN_NAME --config EVALUATOR_CONFIG [analysis-config.json]\n' +
  '       node analyze.mjs comparison.json descriptor.json trusted-binding.json [analysis-config.json]\n';
const bindingFields = [
  'parentVersionId',
  'candidateVersionId',
  'parentDigest',
  'candidateDigest',
  'requestId',
  'attemptId',
  'comparisonId',
];

class InputError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
const read = async (file) => {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new InputError('analysis.file_unreadable', { file });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError('analysis.file_not_json', { file });
  }
};

async function fromJournal(name, configFile) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new InputError('analysis.run_name_invalid', { name });
  const config = await read(configFile);
  if (config && typeof config === 'object' && Object.hasOwn(config, 'projectId'))
    throw new InputError('analysis.config_invalid', {
      file: configFile,
      field: 'projectId',
      reason: 'projectId was renamed to workspaceId in 0.2.0',
    });
  if (!config?.serviceUrl || !config?.workspaceId || !config?.evaluatorToken || !config?.journalRoot)
    throw new InputError('analysis.config_invalid', { file: configFile });
  const handoffFile = path.join(config.journalRoot, 'comparisons', name, 'request.json');
  const handoff = await read(handoffFile);
  // A run started before 0.2.0 recorded its workspace as projectId in this journal file.
  const workspaceId = handoff.workspaceId ?? handoff.projectId;
  const client = new AcclimateClient({
    baseUrl: config.serviceUrl,
    token: config.evaluatorToken,
    scope: config.evaluatorPrincipalId ?? 'evaluator',
  });
  const request = await client.getEvaluation(workspaceId, handoff.bundleId, handoff.requestId);
  if (!request.comparisonId || !request.attemptId)
    throw new InputError('evidence.not_terminal', { requestId: request.id, status: request.status });
  const comparison = await client.getComparison(
    workspaceId,
    handoff.bundleId,
    request.comparisonId,
  );
  return {
    comparison,
    expectedDescriptor: {
      datasetRevision: request.datasetRevision,
      graderRevision: request.graderRevision,
      runtime: request.runtime,
      expectedCases: request.expectedCases,
    },
    expectedBinding: {
      parentVersionId: request.parentVersionId,
      candidateVersionId: request.candidateVersionId,
      parentDigest: request.parentDigest,
      candidateDigest: request.candidateDigest,
      requestId: request.id,
      attemptId: request.attemptId,
      comparisonId: request.comparisonId,
      ...(request.evaluatorPrincipal && { submitter: request.evaluatorPrincipal }),
    },
  };
}

const args = process.argv.slice(2);
try {
  let evidence, configFile;
  if (args[0] === '--name') {
    if (args[2] !== '--config' || !args[1] || !args[3] || args.length > 5)
      throw new InputError('analysis.usage');
    evidence = await fromJournal(args[1], args[3]);
    configFile = args[4];
  } else {
    if (args.length < 3 || args.length > 4) throw new InputError('analysis.usage');
    const [comparison, expectedDescriptor, expectedBinding] = await Promise.all(
      args.slice(0, 3).map(read),
    );
    const missingFields = bindingFields.filter(
      (field) => typeof expectedBinding?.[field] !== 'string' || !expectedBinding[field],
    );
    if (missingFields.length)
      throw new InputError('analysis.binding_invalid', { file: args[2], missingFields });
    evidence = { comparison, expectedDescriptor, expectedBinding };
    configFile = args[3];
  }
  const config = configFile ? await read(configFile) : {};
  const unknown = Object.keys(config ?? {}).filter(
    (name) => !['metrics', 'observations', 'uncertainty'].includes(name),
  );
  if (!config || typeof config !== 'object' || Array.isArray(config) || unknown.length)
    throw new InputError('analysis.invalid_config', { file: configFile, unknownFields: unknown });
  const result = analyzeComparison({ ...config, ...evidence });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  if (error?.code === 'analysis.usage') process.stderr.write(usage);
  process.stderr.write(
    JSON.stringify({
      code:
        typeof error?.code === 'string' && /^(analysis|evidence|policy)\.[a-z_]+$/.test(error.code)
          ? error.code
          : 'analysis.input_invalid',
      ...(error instanceof InputError && error.detail),
    }) + '\n',
  );
  process.exitCode = 1;
}
