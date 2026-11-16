/** Minimal delivery check: resolve, prepare, read every staged file, then clean up. */
export function basicDeliveryRecipes(selection: {
  projectId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `import { readFile } from 'node:fs/promises';
import { AcclimateClient, resolveAndCache, prepareFiles } from '@acclimate/sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
  'ACCLIMATE_CACHE', 'ACCLIMATE_JOB_DIR']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!, scope: process.env.ACCLIMATE_SCOPE! });
const selection = ${JSON.stringify(selection, null, 2)};
const bundle = await resolveAndCache(client, selection,
  { cacheDir: process.env.ACCLIMATE_CACHE! });
const prepared = await prepareFiles(bundle, process.env.ACCLIMATE_JOB_DIR!);
try {
  for (const file of prepared.files) await readFile(file.absolutePath);
  console.log({ version: bundle.version.id, digest: bundle.version.digest,
    checkedFiles: prepared.files.length });
} finally {
  await prepared.cleanup();
}`;
  const python = `import json, os
from pathlib import Path
from acclimate import AcclimateClient, resolve_and_cache, prepare_files

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
            'ACCLIMATE_CACHE', 'ACCLIMATE_JOB_DIR'):
    if not os.environ.get(key):
        raise ValueError('Set ' + key)
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'],
                         os.environ['ACCLIMATE_SCOPE'])
project, bundle_id, channel = ${JSON.stringify(selection.projectId)}, ${JSON.stringify(selection.bundleId)}, ${JSON.stringify(selection.channel)}
bundle = resolve_and_cache(client, project, bundle_id, channel=channel,
    cache_dir=os.environ['ACCLIMATE_CACHE'])
with prepare_files(bundle, os.environ['ACCLIMATE_JOB_DIR']) as prepared:
    for file in prepared.files:
        Path(file['absolutePath']).read_bytes()
    print(json.dumps(dict(version=bundle['version']['id'], digest=bundle['version']['digest'],
                          checkedFiles=len(prepared.files))))
`;
  return { typescript, python };
}

/** Complete copyable examples, using only public installed package APIs. */
export function deliveryRecipes(selection: {
  projectId: string;
  bundleId: string;
  channel: string;
}) {
  const typescript = `import { spawn } from 'node:child_process';
import { AcclimateClient, createReceiptReporter, resolveAndCache, prepareFiles } from '@acclimate/sdk';

for (const key of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
  'ACCLIMATE_CACHE', 'ACCLIMATE_JOB_DIR']) {
  if (!process.env[key]) throw new Error('Set ' + key);
}
const selection = ${JSON.stringify(selection, null, 2)};
const client = new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL!,
  token: process.env.ACCLIMATE_TOKEN!, scope: process.env.ACCLIMATE_SCOPE! });
let reporter: ReturnType<typeof createReceiptReporter> | undefined;
try {
  if (process.env.ACCLIMATE_RECEIPT_TOKEN && process.env.ACCLIMATE_INTEGRATION) {
    reporter = createReceiptReporter({ projectId: selection.projectId,
      integrationId: process.env.ACCLIMATE_INTEGRATION,
      client: new AcclimateClient({ baseUrl: process.env.ACCLIMATE_URL!,
        token: process.env.ACCLIMATE_RECEIPT_TOKEN,
        scope: process.env.ACCLIMATE_SCOPE! + ':receipts', timeoutMs: 1000, retries: 0 }) });
  }
} catch { console.error('Optional reporting unavailable.'); }
function report(action: () => unknown) {
  try { Promise.resolve(action()).catch(() => {}); } catch {}
}
const bundle = await resolveAndCache(client, selection,
  { cacheDir: process.env.ACCLIMATE_CACHE!, reporter });
const prepared = await prepareFiles(bundle, process.env.ACCLIMATE_JOB_DIR!);
report(() => reporter?.reportPrepared(bundle));
try {
  // A real model-free app starts and reads its pinned files.
  const app = spawn(process.execPath, ['-e',
    "console.log('app started'); for (const p of process.argv.slice(1)) require('node:fs').readFileSync(p)",
    ...prepared.files.map(file => file.absolutePath)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '', started = false;
  app.stdout.setEncoding('utf8');
  app.stdout.on('data', chunk => {
    output += chunk;
    if (!started && output.includes('app started\\n')) {
      started = true;
      report(() => reporter?.reportStarted(bundle));
    }
  });
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.once('close', code => code === 0 ? resolve() : reject(new Error('App failed')));
  });
  if (!started) throw new Error('Application start was not observed');
  console.log({ version: bundle.version.id, digest: bundle.version.digest, started });
} finally {
  await prepared.cleanup();
  if (reporter) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reporter.flush(), new Promise<void>(resolve => {
      timer = setTimeout(resolve, 1200);
    })]); } catch {} finally {
      if (timer) clearTimeout(timer);
      reporter.close();
    }
  }
}`;
  const python = `import json, os, subprocess, sys
from acclimate import AcclimateClient, DeliveryReporter, resolve_and_cache, prepare_files

for key in ('ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE',
            'ACCLIMATE_CACHE', 'ACCLIMATE_JOB_DIR'):
    if not os.environ.get(key):
        raise ValueError('Set ' + key)
project, bundle_id, channel = ${JSON.stringify(selection.projectId)}, ${JSON.stringify(selection.bundleId)}, ${JSON.stringify(selection.channel)}
client = AcclimateClient(os.environ['ACCLIMATE_URL'], os.environ['ACCLIMATE_TOKEN'],
                         os.environ['ACCLIMATE_SCOPE'])
reporter = None
try:
    if os.environ.get('ACCLIMATE_RECEIPT_TOKEN') and os.environ.get('ACCLIMATE_INTEGRATION'):
        receipt_client = AcclimateClient(os.environ['ACCLIMATE_URL'],
            os.environ['ACCLIMATE_RECEIPT_TOKEN'], os.environ['ACCLIMATE_SCOPE'] + ':receipts',
            timeout=1, retries=0)
        reporter = DeliveryReporter(receipt_client, project, os.environ['ACCLIMATE_INTEGRATION'])
except Exception:
    print('Optional reporting unavailable.', file=sys.stderr)
try:
    bundle = resolve_and_cache(client, project, bundle_id, channel=channel,
        cache_dir=os.environ['ACCLIMATE_CACHE'], reporter=reporter)
    with prepare_files(bundle, os.environ['ACCLIMATE_JOB_DIR']) as prepared:
        # prepare_files reports prepared only after all files are staged.
        code = "import pathlib,sys; print('app started',flush=True); [pathlib.Path(p).read_text() for p in sys.argv[1:]]"
        with subprocess.Popen([sys.executable, '-c', code,
                *[file['absolutePath'] for file in prepared.files]],
                stdout=subprocess.PIPE, text=True) as app:
            started = app.stdout.readline().strip() == 'app started'
            if started and bundle.get('reporter'):
                try:
                    bundle['reporter'].report_started()
                except Exception:
                    pass
            if app.wait(timeout=10) != 0 or not started:
                raise RuntimeError('Application start or file read failed')
        print(json.dumps(dict(version=bundle['version']['id'], digest=bundle['version']['digest'],
                              started=started)))
finally:
    if reporter:
        reporter.wait(1.2)
        reporter.close(0)
`;
  return { typescript, python };
}
