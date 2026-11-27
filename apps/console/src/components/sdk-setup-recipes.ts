/** Minimal delivery check: resolve, prepare, read every staged file, then clean up. */
export function basicDeliveryRecipes(selection: {
  workspaceId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `import { readFile } from 'node:fs/promises';
import { AcclimateClient } from '@anveld/acclimate-sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_CONNECTION']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN, connectionId: process.env.ACCLIMATE_CONNECTION });
const selection = ${JSON.stringify(selection, null, 2)};
const prepared = await client.prepare({ ...selection, cacheDir: process.env.ACCLIMATE_CACHE,
  destination: process.env.ACCLIMATE_JOB_DIR });
try {
  for (const file of prepared.files) await readFile(file.absolutePath);
  const { id: version, digest } = prepared.version.version;
  console.log({ version, digest, checkedFiles: prepared.files.length });
} finally {
  await prepared.cleanup();
}`;
  const python = `import json, os
from pathlib import Path
from acclimate import AcclimateClient

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_CONNECTION'):
    if not os.environ.get(key):
        raise ValueError('Set ' + key)
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'],
                         connection_id=os.environ['ACCLIMATE_CONNECTION'])
workspace_id, bundle_id, channel = ${JSON.stringify(selection.workspaceId)}, ${JSON.stringify(selection.bundleId)}, ${JSON.stringify(selection.channel)}
with client.prepare(workspace_id, bundle_id, channel=channel, cache_dir=os.getenv('ACCLIMATE_CACHE'),
                    destination=os.getenv('ACCLIMATE_JOB_DIR')) as prepared:
    for file in prepared.files:
        Path(file['absolutePath']).read_bytes()
    version = prepared.version['version']
    print(json.dumps(dict(version=version['id'], digest=version['digest'],
                          checkedFiles=len(prepared.files))))
`;
  return { typescript, python };
}

export function agentConnectionRecipes(selection: {
  workspaceId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `// application.mjs exports runAgent, which runs your agent loop on one job.
import { runAgent } from './application.mjs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { AcclimateClient } from '@anveld/acclimate-sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_CONNECTION',
  'ACCLIMATE_JOB_DIR', 'AGENT_TASK']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN, connectionId: process.env.ACCLIMATE_CONNECTION });
const prepared = await client.prepare({ ...${JSON.stringify(selection, null, 2)},
  cacheDir: process.env.ACCLIMATE_CACHE, destination: process.env.ACCLIMATE_JOB_DIR });
const { instructions: instruction, skillFiles } = prepared;
const { id: versionId, digest } = prepared.version.version;
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
  await retained.writeFile(JSON.stringify({ versionId, digest,
    contextPolicy: 'explicit-no-memory-v1', result }) + '\\n');
  await retained.sync();
} finally { await retained.close(); }
await prepared.cleanup();
console.log({ versionId, digest,
  contextPolicy: 'explicit-no-memory-v1', appCallCompleted: true });
`;
  const python = `import json, os
from pathlib import Path
from acclimate import AcclimateClient

# application.py defines run_agent, which runs your agent loop on one job.
from application import run_agent

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_CONNECTION', 'ACCLIMATE_JOB_DIR', 'AGENT_TASK'):
    if not os.environ.get(key): raise ValueError('Set ' + key)
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'],
                         connection_id=os.environ['ACCLIMATE_CONNECTION'])
prepared = client.prepare(${JSON.stringify(selection.workspaceId)}, ${JSON.stringify(selection.bundleId)},
    channel=${JSON.stringify(selection.channel)}, cache_dir=os.getenv('ACCLIMATE_CACHE'),
    destination=os.environ['ACCLIMATE_JOB_DIR'])
version = prepared.version['version']
run = run_agent(instruction=prepared.instructions, skill_files=prepared.skill_files,
    approved_memory=[], task=os.environ['AGENT_TASK'])
if run.get('stopped') is not True:
    raise RuntimeError('Application termination is unknown; inspect the original job directory')
result = run['result']
# Retain privately outside the staged inventory; refuse any existing file or symlink.
result_path = Path(os.environ['ACCLIMATE_JOB_DIR']) / 'acclimate-agent-result.json'
result_fd = os.open(result_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(result_fd, 'w', encoding='utf-8') as retained:
    json.dump(dict(versionId=version['id'], digest=version['digest'],
        contextPolicy='explicit-no-memory-v1', result=result), retained, allow_nan=False)
    retained.write('\\n')
    retained.flush()
    os.fsync(retained.fileno())
prepared.cleanup()
print(json.dumps(dict(versionId=version['id'], digest=version['digest'],
    contextPolicy='explicit-no-memory-v1', appCallCompleted=True)))
# In an async app, offload the complete fetch/prepare/run/cleanup lifetime to a worker.
`;
  return { typescript, python };
}

export function applicationModuleRecipes() {
  return {
    typescript: `export async function runAgent({ instruction, skillFiles, approvedMemory, task, signal }) {
  // Run your agent and return { result, stopped: true } after it stops.
  throw new Error('Connect runAgent to your agent loop');
}
`,
    python: `def run_agent(*, instruction, skill_files, approved_memory, task):
    # Run your agent and return {"result": result, "stopped": True} after it stops.
    raise NotImplementedError('Connect run_agent to your agent loop')
`,
  };
}

export function deliveryRecipes(selection: {
  workspaceId: string;
  bundleId: string;
  channel: string;
}) {
  return {
    typescript: `import { AcclimateClient, createReceiptReporter } from '@anveld/acclimate-sdk';

export function createAppReporter() {
  const connectionId = process.env.ACCLIMATE_CONNECTION;
  const token = process.env.ACCLIMATE_RECEIPT_TOKEN;
  if (!connectionId || !token) return;
  try {
    return createReceiptReporter({
      workspaceId: ${JSON.stringify(selection.workspaceId)}, connectionId,
      client: new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL, token,
        scope: connectionId + ':receipts', timeoutMs: 1000, retries: 0 }),
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
    connection_id = os.environ.get("ACCLIMATE_CONNECTION")
    token = os.environ.get("ACCLIMATE_RECEIPT_TOKEN")
    if not connection_id or not token:
        return None
    try:
        client = AcclimateClient(os.environ["ACCLIMATE_URL"], token,
            connection_id + ":receipts", timeout=1, retries=0)
        return DeliveryReporter(client, ${JSON.stringify(selection.workspaceId)}, connection_id)
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
  selection: { workspaceId: string; bundleId: string; channel: string },
  runtime: 'codex' | 'claude' | 'pi' | 'cursor',
) {
  return `import { AcclimateClient } from '@anveld/acclimate-sdk';
import { prepare } from '@anveld/acclimate-${runtime}-plugin';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_CONNECTION']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({
  baseUrl: process.env.ACCLIMATE_URL,
  token: process.env.ACCLIMATE_TOKEN,
  connectionId: process.env.ACCLIMATE_CONNECTION,
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
