import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function messages(bundle, input) {
  const prompt = ['instruction', 'skill', 'memory']
    .flatMap(kind => (bundle.files ?? []).filter(file => file.kind === kind))
    .map(file => `# ${file.path}\n${file.text}`).join('\n\n');
  return [{ role: 'system', content: prompt }, ...(Array.isArray(input?.messages)
    ? input.messages : [{ role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) }])];
}

async function run() {
  const { bundle, input, model, timeoutSeconds } = JSON.parse(await readFile('/lease/input', 'utf8'));
  // Also bound the runner's lifetime if its owner disappears.
  setTimeout(() => process.exit(124), timeoutSeconds * 1000).unref();
  const content = JSON.parse(await complete(JSON.stringify({ model, messages: messages(bundle, input) })))
    .choices[0].message.content;
  if (typeof content !== 'string') process.exit(65);
  process.stdout.write(JSON.stringify(content));
}

// The gateway can wait several minutes for a provider that asks it to retry. node:http sets no
// response timeout of its own, unlike fetch, so only the timer in run() bounds the call.
export function complete(body, socketPath = '/lease/gateway') {
  return new Promise((resolve, reject) => {
    const call = request({
      socketPath, path: '/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => (response.statusCode >= 200 && response.statusCode < 300
        ? resolve(Buffer.concat(chunks).toString('utf8'))
        : reject(new Error('Gateway refused request'))));
    });
    call.on('error', reject);
    call.end(body);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => process.exit(1));
}
