/** Minimal delivery check: resolve, prepare, read every staged file, then clean up. */
export function basicDeliveryRecipes(selection: {
  projectId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '@acclimate/sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN, scope: process.env.ACCLIMATE_SCOPE });
const selection = ${JSON.stringify(selection, null, 2)};
const prepared = await client.prepare({ ...selection, cacheDir: process.env.ACCLIMATE_CACHE,
  destination: process.env.ACCLIMATE_JOB_DIR });
try {
  for (const file of prepared.files) await readFile(file.absolutePath);
  console.log({ version: prepared.version.id, digest: prepared.version.digest,
    checkedFiles: prepared.files.length });
} finally {
  await prepared.cleanup();
}`;
  const python = `import json, os
from pathlib import Path
from acclimate import AcclimateClient

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE'):
    if not os.environ.get(key):
        raise ValueError('Set ' + key)
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'],
                         os.environ['ACCLIMATE_SCOPE'])
project, bundle_id, channel = ${JSON.stringify(selection.projectId)}, ${JSON.stringify(selection.bundleId)}, ${JSON.stringify(selection.channel)}
with client.prepare(project, bundle_id, channel=channel, cache_dir=os.getenv('ACCLIMATE_CACHE'),
                    destination=os.getenv('ACCLIMATE_JOB_DIR')) as prepared:
    for file in prepared.files:
        Path(file['absolutePath']).read_bytes()
    print(json.dumps(dict(version=prepared.version['id'], digest=prepared.version['digest'],
                          checkedFiles=len(prepared.files))))
`;
  return { typescript, python };
}

export function agentConnectionRecipes(selection: {
  projectId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `// application.mjs exports runAgent for delivery and cases, execute and grade for
// acclimate-eval. Its execute() calls the same runAgent, so both use one contract.
import { runAgent } from './application.mjs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { AcclimateClient } from '@acclimate/sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
  'ACCLIMATE_JOB_DIR', 'AGENT_TASK']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN, scope: process.env.ACCLIMATE_SCOPE,
  integrationId: process.env.ACCLIMATE_INTEGRATION });
const prepared = await client.prepare({ ...${JSON.stringify(selection, null, 2)},
  cacheDir: process.env.ACCLIMATE_CACHE, destination: process.env.ACCLIMATE_JOB_DIR });
const { instructions: instruction, skillFiles } = prepared;
const approvedMemory = [];
// Keep inputs available until the real job has stopped and its output is retained.
const run = await runAgent({ instruction, skillFiles, approvedMemory,
  task: process.env.AGENT_TASK });
if (run.stopped !== true) throw new Error('Application termination is unknown; inspect the original job directory');
const result = run.result;
// A separate owner-only file survives prepared.cleanup(); never overwrite an earlier run.
const retained = await open(join(process.env.ACCLIMATE_JOB_DIR,
  'acclimate-agent-result.json'), 'wx', 0o600);
try {
  await retained.writeFile(JSON.stringify({ versionId: prepared.version.id,
    digest: prepared.version.digest, contextPolicy: 'explicit-no-memory-v1', result }) + '\\n');
  await retained.sync();
} finally { await retained.close(); }
await prepared.cleanup();
console.log({ versionId: prepared.version.id, digest: prepared.version.digest,
  contextPolicy: 'explicit-no-memory-v1', appCallCompleted: true });
`;
  const python = `import json, os
from pathlib import Path
from acclimate import AcclimateClient

# application.py defines run_agent for delivery and cases, execute and grade for
# python -m acclimate. Its execute() calls the same run_agent.
from application import run_agent

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
            'ACCLIMATE_JOB_DIR', 'AGENT_TASK'):
    if not os.environ.get(key): raise ValueError('Set ' + key)
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'], os.environ['ACCLIMATE_SCOPE'])
prepared = client.prepare(${JSON.stringify(selection.projectId)}, ${JSON.stringify(selection.bundleId)},
    channel=${JSON.stringify(selection.channel)}, cache_dir=os.getenv('ACCLIMATE_CACHE'),
    destination=os.environ['ACCLIMATE_JOB_DIR'])
run = run_agent(instruction=prepared.instructions, skill_files=prepared.skill_files,
    approved_memory=[], task=os.environ['AGENT_TASK'])
if run.get('stopped') is not True:
    raise RuntimeError('Application termination is unknown; inspect the original job directory')
result = run['result']
# Retain privately outside the staged inventory; refuse any existing file or symlink.
result_path = Path(os.environ['ACCLIMATE_JOB_DIR']) / 'acclimate-agent-result.json'
result_fd = os.open(result_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(result_fd, 'w', encoding='utf-8') as retained:
    json.dump(dict(versionId=prepared.version['id'], digest=prepared.version['digest'],
        contextPolicy='explicit-no-memory-v1', result=result), retained, allow_nan=False)
    retained.write('\\n')
    retained.flush()
    os.fsync(retained.fileno())
prepared.cleanup()
print(json.dumps(dict(versionId=prepared.version['id'], digest=prepared.version['digest'],
    contextPolicy='explicit-no-memory-v1', appCallCompleted=True)))
# In an async app, offload the complete fetch/prepare/run/cleanup lifetime to a worker.
`;
  return { typescript, python };
}

/**
 * The one application module both paths load: delivery calls runAgent, and the
 * evaluator calls execute, which stages the version and calls the same runAgent.
 */
export function applicationModuleRecipes() {
  const typescript = `import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFiles } from '@acclimate/sdk';
import { ExecutionUncertainError } from '@acclimate/sdk/evaluation';

/** Delivery and evaluation both call this. Return stopped: true only after your agent ends. */
export async function runAgent({ instruction, skillFiles, approvedMemory, task, signal }) {
  // Start your existing agent loop with the instruction, skill files and task here.
  throw new Error('Connect runAgent to your agent loop');
}

// Private saved tasks; ACCLIMATE_EVALUATOR_CASES can point to a JSON file instead.
export const cases = [
  { caseId: 'first-task', input: { task: 'A task your agent handles' },
    expected: { includes: 'a phrase a good answer contains' } },
];

export async function execute({ bundle, input, signal }) {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-eval-'));
  const staged = await prepareFiles(bundle, directory);
  const instruction = bundle.payload.files.filter((file) => file.kind === 'instruction')
    .map((file) => file.text).join('\\n\\n');
  const run = await runAgent({ instruction, approvedMemory: [], task: input.task, signal,
    skillFiles: staged.files.filter((file) => file.kind === 'skill') });
  // Keep the inputs when the agent's end is unknown.
  if (run.stopped !== true) throw new ExecutionUncertainError();
  await staged.cleanup();
  await rm(directory, { recursive: true, force: true });
  return { output: run.result };
}

export async function grade({ output, expected }) {
  return { reward: Number(JSON.stringify(output).includes(expected.includes)) };
}
`;
  const python = `import json, shutil, tempfile
from acclimate import prepare_files
from acclimate.evaluation import ExecutionResult, ExecutionUncertainError, GradeResult


def run_agent(*, instruction, skill_files, approved_memory, task):
    """Delivery and evaluation both call this. Return stopped=True only after your agent ends."""
    raise NotImplementedError('Connect run_agent to your agent loop')


# Private saved tasks; ACCLIMATE_EVALUATOR_CASES can point to a JSON file instead.
cases = [
    dict(caseId='first-task', input=dict(task='A task your agent handles'),
         expected=dict(includes='a phrase a good answer contains')),
]


def execute(request):
    directory = tempfile.mkdtemp(prefix='acclimate-eval-')
    staged = prepare_files(request.bundle, directory)
    instruction = '\\n\\n'.join(f['text'] for f in request.bundle['payload']['files']
                               if f['kind'] == 'instruction')
    run = run_agent(instruction=instruction, approved_memory=[], task=request.input['task'],
                    skill_files=[f for f in staged.files if f['kind'] == 'skill'])
    if run.get('stopped') is not True:
        raise ExecutionUncertainError()  # keep the inputs for inspection
    staged.cleanup()
    shutil.rmtree(directory, ignore_errors=True)
    return ExecutionResult(output=run['result'])


def grade(request):
    return GradeResult(reward=float(request.expected['includes'] in json.dumps(request.output)))
`;
  return { typescript, python };
}

/** Install this callback beside the code that observes the application's actual start. */
export function deliveryRecipes(selection: {
  projectId: string;
  bundleId: string;
  channel: string;
}) {
  return {
    typescript: `import { AcclimateClient, createReceiptReporter } from '@acclimate/sdk';

export function createAppReporter() {
  const integrationId = process.env.ACCLIMATE_INTEGRATION;
  const token = process.env.ACCLIMATE_RECEIPT_TOKEN;
  if (!integrationId || !token) return;
  try {
    return createReceiptReporter({
      projectId: ${JSON.stringify(selection.projectId)}, integrationId,
      client: new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL, token,
        scope: process.env.ACCLIMATE_SCOPE + ':receipts', timeoutMs: 1000, retries: 0 }),
    });
  } catch { return undefined; }
}

// Pass the reporter to client.prepare({ ...selection, reporter }).
// At the actual agent-start event, save prepared.reportStarted() with the job.
// It returns the queued receipt for a field audit, or null when unavailable.
// Flush and close the reporter when the job ends.`,
    python: `import os
from acclimate import AcclimateClient, DeliveryReporter

def create_app_reporter():
    integration_id = os.environ.get("ACCLIMATE_INTEGRATION")
    token = os.environ.get("ACCLIMATE_RECEIPT_TOKEN")
    if not integration_id or not token:
        return None
    try:
        client = AcclimateClient(os.environ["ACCLIMATE_URL"], token,
            os.environ["ACCLIMATE_SCOPE"] + ":receipts", timeout=1, retries=0)
        return DeliveryReporter(client, ${JSON.stringify(selection.projectId)}, integration_id)
    except Exception:
        return None

# Pass reporter=reporter to client.prepare(...).
# At the actual agent-start event, save prepared.report_started() with the job.
# It returns the queued receipt for a field audit, or None when unavailable.
# Drain and close the reporter when the job ends.`,
  };
}

/** Verify the selected channel using the actual runtime plugin without starting a model. */
export function nativeDeliveryRecipe(
  selection: { projectId: string; bundleId: string; channel: string },
  runtime: 'codex' | 'claude' | 'pi' | 'cursor',
) {
  return `import { AcclimateClient } from '@acclimate/sdk';
import { prepare } from '@acclimate/${runtime}-plugin';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN,
  scope: process.env.ACCLIMATE_SCOPE,
});
const selection = ${JSON.stringify(selection, null, 2)};
// ACCLIMATE_CACHE is optional; the default is ~/.cache/acclimate/typescript.
const delivery = await client.prepare({ ...selection, cacheDir: process.env.ACCLIMATE_CACHE });
// The plugin accepts the delivery, so prepared.reportStarted() still records start receipts.
const prepared = await prepare(delivery);
try {
  console.log({
    version: prepared.versionId,
    digest: prepared.digest,
    instructionPrepared: prepared.instructionPath !== null,
    skillManifests: prepared.skillPaths.length,
    memoryFiles: prepared.memoryFiles.length,
  });
} finally {
  await prepared.cleanup();
}
`;
}
