// Supplied over stdin to docker exec while the fake upstream holds the request.
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const markers = JSON.parse(Buffer.concat(chunks).toString()).map(text => Buffer.from(text));
if (markers.some(marker => JSON.stringify(process.env).includes(marker.toString()))) process.exit(1);

const overlap = Math.max(...markers.map(marker => marker.length)) - 1;
const buffer = Buffer.alloc(512 * 1024 + overlap);
function inspect(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      const next = path === '/' ? '/' + name : path + '/' + name;
      if (!['/sys', '/dev', '/proc'].includes(next)) inspect(next);
    }
  } else if (stat.isFile()) {
    const file = openSync(path, 'r');
    let carried = 0;
    try {
      for (;;) {
        const count = readSync(file, buffer, carried, buffer.length - carried, null);
        if (!count) break;
        const bytes = buffer.subarray(0, carried + count);
        if (markers.some(marker => bytes.includes(marker))) process.exit(1);
        carried = Math.min(bytes.length, overlap);
        bytes.copy(buffer, 0, bytes.length - carried);
      }
    } finally {
      closeSync(file);
    }
  }
}
inspect('/');
