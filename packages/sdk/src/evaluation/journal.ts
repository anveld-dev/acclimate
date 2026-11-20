import { spawn } from 'node:child_process';
import path from 'node:path';
import { privateDirectory } from './private-state.js';
import { EvaluationError } from './errors.js';

const LOCK = `import fcntl,os,stat,sys
p=sys.argv[1]
fd=os.open(p,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077: sys.exit(2)
try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print('busy',flush=True)
 sys.exit(0)
print('owned',flush=True)
while sys.stdin.buffer.read(4096): pass
`;
export class EvaluationBusyError extends EvaluationError {
  constructor() {
    super('journal.busy');
    this.name = 'EvaluationBusyError';
    this.message = 'Another evaluator process holds this lock; no execution was started here';
  }
}
export async function acquireFileLock(filename: string) {
  if (process.platform === 'win32') throw new EvaluationError('runtime.unsupported');
  await privateDirectory(path.dirname(filename));
  const child = spawn('python3', ['-I', '-c', LOCK, filename], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  let owned = false;
  const controller = new AbortController();
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      owned = false;
      controller.abort();
      resolve();
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      child.once('error', () => reject(new EvaluationError('runtime.unsupported')));
      child.once('exit', () => {
        if (!owned) reject(new EvaluationError('journal.ownership_lost'));
      });
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (output === 'owned\n') {
          owned = true;
          resolve();
        } else if (output === 'busy\n') reject(new EvaluationBusyError());
        else if (output.length > 32) reject(new EvaluationError('journal.invalid'));
      });
    });
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
  return {
    signal: controller.signal,
    assertOwned() {
      if (!owned)
        throw new EvaluationError('journal.ownership_lost', { executionState: 'may_have_started' });
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
