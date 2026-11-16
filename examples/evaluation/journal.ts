import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicPrivateWrite, privateDirectory } from '../../scripts/private-state.js';
import type { ComparisonRequest } from '../../packages/sdk/src/types.js';
import type { EvaluationDescriptor } from './descriptor.js';

export interface JournalScope {
  serviceUrl: string; projectId: string; bundleId: string; requestId: string; evaluatorPrincipalId: string;
}
export interface AttemptJournal {
  schemaVersion: 1;
  scope: JournalScope;
  /** Present on explicit-app journals; prevents relocating an unfinished attempt. */
  journalRoot?: string;
  request: EvaluationDescriptor & {
    parentVersionId: string; candidateVersionId: string; parentDigest: string; candidateDigest: string;
  };
  attemptId: string;
  keys: { start: string; submit: string; finish: string };
  executionStarted?: true;
  report?: ComparisonRequest;
  comparisonId?: string;
  completed?: true;
}

// Advisory OS ownership, not a PID-file inference. The kernel releases this lock on
// helper death; the durable execution marker independently forbids reexecution.
const LOCK_PROGRAM = `import fcntl,os,stat,sys
p=sys.argv[1]
fd=os.open(p,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077:
 sys.exit(2)
try:
 fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print('busy',flush=True)
 sys.exit(0)
print('owned',flush=True)
while sys.stdin.buffer.read(4096): pass
`;

export class EvaluationBusyError extends Error {
  constructor() { super('Another evaluator process owns this request; no execution was started here'); }
}

export async function openJournal(root: string, scope: JournalScope) {
  if (!path.isAbsolute(root)) throw new Error('Journal root must be absolute');
  await privateDirectory(root);
  if (await realpath(root) !== path.resolve(root)) throw new Error('Journal root must not contain symlinks');
  const journalRoot = path.resolve(root);
  const identity = JSON.stringify(scope);
  const directory = path.join(root, createHash('sha256').update(identity).digest('hex'));
  await privateDirectory(directory);
  const lock = spawn('python3', ['-I', '-c', LOCK_PROGRAM, path.join(directory, 'ownership.lock')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  lock.stdin.on('error', () => {});
  let owned = false;
  const exited = new Promise<void>((resolve) => lock.once('exit', () => { owned = false; resolve(); }));
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      lock.once('error', () => reject(new Error('Evaluator process ownership requires python3 with fcntl')));
      lock.once('exit', () => { if (!buffer.includes('owned\n')) reject(new Error('Could not acquire evaluator process ownership')); });
      lock.stdout.on('data', (data: Buffer) => {
        buffer += data.toString();
        if (buffer === 'owned\n') { owned = true; resolve(); }
        else if (buffer === 'busy\n') reject(new EvaluationBusyError());
        else if (buffer.length > 32) reject(new Error('Invalid evaluator ownership response'));
      });
      lock.stderr.resume();
    });
  } catch (error) {
    lock.stdin.end();
    lock.kill();
    throw error;
  }
  const assertOwned = () => { if (!owned) throw new Error('Evaluator process ownership was lost'); };
  const filename = path.join(directory, 'attempt.json');
  return {
    directory,
    assertOwned,
    async read(): Promise<AttemptJournal | undefined> {
      assertOwned();
      let handle;
      try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4 * 1024 * 1024)
          throw new Error('Unsafe evaluator journal');
        const value = JSON.parse(await handle.readFile('utf8')) as AttemptJournal;
        if (value.schemaVersion !== 1 || JSON.stringify(value.scope) !== identity || !value.attemptId ||
            !value.keys?.start || !value.keys.submit || !value.keys.finish || !value.request)
          throw new Error('Evaluator journal scope or identity is invalid');
        if (value.journalRoot !== undefined && value.journalRoot !== journalRoot)
          throw new Error('Evaluator journal root changed; restore the original private journal root before recovery');
        return value;
      } finally { await handle.close(); }
    },
    async save(value: AttemptJournal) {
      assertOwned();
      if (JSON.stringify(value.scope) !== identity) throw new Error('Evaluator journal scope mismatch');
      if (value.journalRoot !== undefined && value.journalRoot !== journalRoot)
        throw new Error('Evaluator journal root changed; restore the original private journal root before recovery');
      await atomicPrivateWrite(filename, JSON.stringify({ ...value, journalRoot }) + '\n');
      assertOwned();
    },
    async output(value: unknown) {
      assertOwned();
      const filename = path.join(directory, `output-${randomUUID()}.json`);
      await atomicPrivateWrite(filename, JSON.stringify(value) + '\n');
      assertOwned();
      return filename;
    },
    async close() {
      lock.stdin.end();
      const timer = setTimeout(() => lock.kill('SIGKILL'), 1000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}
