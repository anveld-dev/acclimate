// Supplied to docker exec only while the fake upstream holds the request.
import { opendir, open, lstat } from 'node:fs/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const marker = Buffer.concat(chunks);
if (JSON.stringify(process.env).includes(marker.toString())) process.exit(1);

async function inspect(path) {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    for await (const entry of await opendir(path)) {
      const next = path === '/' ? '/' + entry.name : path + '/' + entry.name;
      if (!['/sys', '/dev', '/proc'].includes(next)) await inspect(next);
    }
  } else if (stat.isFile()) {
    const file = await open(path);
    let tail = Buffer.alloc(0);
    try {
      for await (const chunk of file.createReadStream()) {
        const bytes = Buffer.concat([tail, chunk]);
        if (bytes.includes(marker)) process.exit(1);
        tail = bytes.subarray(-marker.length);
      }
    } finally {
      await file.close();
    }
  }
}
await inspect('/');
