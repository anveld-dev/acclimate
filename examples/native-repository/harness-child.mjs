// Entry point for one harness turn inside its own process group. See harness-process.mjs.
import { pathToFileURL } from 'node:url';

const controller = new AbortController();
const pending = new Map();
let nextId = 0;

function send(message) {
  return new Promise((resolve) => process.send(message, resolve));
}

function acknowledge(handle) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    void send({ type: 'acknowledge', id, handle });
  });
}

async function run({ module, exportName, task }) {
  try {
    const loaded = await import(module.startsWith('file:') ? module : pathToFileURL(module).href);
    const target = loaded[exportName];
    const fn = typeof target === 'function' ? target : target?.run?.bind(target);
    if (typeof fn !== 'function') throw Object.assign(new Error(`${exportName} is not a harness run function`), { code: 'native.harness_export' });
    const value = await fn({
      ...task,
      signal: controller.signal,
      acknowledge,
      progress: (output) => void send({ type: 'progress', output }),
    });
    await send({ type: 'result', value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (error) {
    await send({
      type: 'error',
      error: {
        name: String(error?.name ?? 'Error'),
        code: typeof error?.code === 'string' ? error.code : null,
        message: String(error?.message ?? error),
      },
    });
  }
  process.disconnect();
}

process.on('message', (message) => {
  if (message?.type === 'run') void run(message);
  else if (message?.type === 'abort') controller.abort(Object.assign(new Error(`harness ${message.reason}`), { code: `native.${message.reason}` }));
  else if (message?.type === 'acknowledged') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(Object.assign(new Error(message.error), { code: 'native.job_handle' }));
    else waiter?.resolve();
  }
});
