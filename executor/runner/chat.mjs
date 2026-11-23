import { createConnection, createServer } from 'node:net';
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
  const server = createServer(socket => {
    const peer = createConnection('/lease/gateway');
    peer.on('error', () => socket.destroy());
    socket.on('error', () => peer.destroy());
    socket.on('close', () => peer.destroy());
    socket.pipe(peer).pipe(socket);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model, messages: messages(bundle, input) }),
    });
    if (!response.ok) throw new Error('Gateway refused request');
    const content = (await response.json()).choices[0].message.content;
    if (typeof content !== 'string') process.exit(65);
    process.stdout.write(JSON.stringify(content));
  } finally {
    server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => process.exit(1));
}
