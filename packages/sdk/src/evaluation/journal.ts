import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ComparisonRequest, EvaluationDescriptor } from '../types.js';
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateText,
  readPrivateJson,
} from './private-state.js';
import { EvaluationError } from './errors.js';
export interface JournalScope {
  serviceUrl: string;
  projectId: string;
  bundleId: string;
  requestId: string;
  evaluatorPrincipalId: string;
}
export interface BodyReference {
  file: string;
  sha256: string;
  bytes: number;
}
export interface ArtifactEntry {
  caseId: string;
  repetition: number;
  side: 'parent' | 'candidate';
  versionId: string;
  digest: string;
  role: 'output' | 'grader-explanation';
  file: string;
  sha256: string;
  bytes: number;
}
export interface ArtifactIndex {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  reportSha256: string;
  comparisonId?: string;
  entries: ArtifactEntry[];
}
export interface PrivateArtifactEnvelope {
  schemaVersion: 1;
  identity: {
    requestId: string;
    attemptId: string;
    caseId: string;
    repetition: number;
    side: 'parent' | 'candidate';
    versionId: string;
    digest: string;
    role: 'output' | 'grader-explanation';
  };
  value: unknown;
}
export interface AttemptJournal {
  schemaVersion: 1;
  scope: JournalScope;
  journalRoot?: string;
  request: EvaluationDescriptor & {
    parentVersionId: string;
    candidateVersionId: string;
    parentDigest: string;
    candidateDigest: string;
  };
  attemptId: string;
  keys: { start: string; submit: string; finish: string };
  executionStarted?: true;
  report?: ComparisonRequest;
  comparisonId?: string;
  completed?: true;
  retainedOperations?: true;
  wireBodies?: Partial<Record<'start' | 'submit' | 'finish', BodyReference>>;
}
export const sha256 = (value: string | Uint8Array) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
export function serializeScope(scope: JournalScope): string {
  return JSON.stringify({
    serviceUrl: scope.serviceUrl,
    projectId: scope.projectId,
    bundleId: scope.bundleId,
    requestId: scope.requestId,
    evaluatorPrincipalId: scope.evaluatorPrincipalId,
  });
}
export function journalDirectory(root: string, scope: JournalScope): string {
  return path.join(root, createHash('sha256').update(serializeScope(scope)).digest('hex'));
}
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
    this.message = 'Another evaluator process owns this request; no execution was started here';
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
export async function openJournal(root: string, scope: JournalScope) {
  if (!path.isAbsolute(root)) throw new EvaluationError('config.permissions');
  await privateDirectory(root, true);
  if ((await realpath(root)) !== path.resolve(root))
    throw new EvaluationError('config.permissions');
  const directory = journalDirectory(root, scope),
    journalRoot = path.resolve(root),
    identity = serializeScope(scope);
  await privateDirectory(directory);
  const lock = await acquireFileLock(path.join(directory, 'ownership.lock'));
  try {
    if (await lstat(path.join(directory, 'attempt.python.json')).catch(() => undefined))
      throw new EvaluationError('journal.foreign');
  } catch (error) {
    await lock.close();
    throw error;
  }
  const filename = path.join(directory, 'attempt.json');
  const check = (value: AttemptJournal) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !value.scope ||
      value.schemaVersion !== 1 ||
      serializeScope(value.scope) !== identity ||
      !value.attemptId ||
      !value.keys?.start ||
      !value.keys.submit ||
      !value.keys.finish ||
      !value.request
    )
      throw new EvaluationError('journal.invalid');
    if (value.journalRoot !== undefined && value.journalRoot !== journalRoot) {
      const error = new EvaluationError('journal.relocated');
      error.message =
        'Evaluator journal root changed; restore the original private journal root before recovery';
      throw error;
    }
  };
  const bodyFile = (kind: 'start' | 'submit' | 'finish') => kind + '-body.json';
  return {
    directory,
    ...lock,
    async read(): Promise<AttemptJournal | undefined> {
      lock.assertOwned();
      try {
        await lstat(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const value = (await readPrivateJson(filename, 4 * 1024 * 1024)) as unknown as AttemptJournal;
      check(value);
      return value;
    },
    async save(value: AttemptJournal) {
      lock.assertOwned();
      check(value);
      const text = JSON.stringify({ ...value, journalRoot }) + '\n';
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new EvaluationError('journal.invalid');
      await atomicPrivateWrite(filename, text);
      lock.assertOwned();
    },
    async saveBody(kind: 'start' | 'submit' | 'finish', body: string): Promise<BodyReference> {
      lock.assertOwned();
      if (Buffer.byteLength(body) > 2 * 1024 * 1024)
        throw new EvaluationError('definition.report_budget_exceeded');
      const file = bodyFile(kind);
      await atomicPrivateWrite(path.join(directory, file), body);
      lock.assertOwned();
      return { file, sha256: sha256(body), bytes: Buffer.byteLength(body) };
    },
    async readBody(kind: 'start' | 'submit' | 'finish', state: AttemptJournal): Promise<string> {
      lock.assertOwned();
      const ref = state.wireBodies?.[kind];
      if (!ref) {
        if (kind === 'submit' && state.report) return JSON.stringify(state.report);
        throw new EvaluationError('journal.invalid');
      }
      if (ref.file !== bodyFile(kind) || ref.bytes > 2 * 1024 * 1024)
        throw new EvaluationError('journal.invalid');
      const body = await readPrivateText(path.join(directory, ref.file), 2 * 1024 * 1024);
      lock.assertOwned();
      if (Buffer.byteLength(body) !== ref.bytes || sha256(body) !== ref.sha256)
        throw new EvaluationError('journal.invalid');
      return body;
    },
    async output(value: unknown) {
      lock.assertOwned();
      const file = path.join(directory, 'output-' + randomUUID() + '.json');
      await atomicPrivateWrite(file, JSON.stringify(value) + '\n');
      lock.assertOwned();
      return file;
    },
    async writeArtifact(
      binding: Omit<ArtifactEntry, 'file' | 'sha256' | 'bytes'> & {
        requestId?: string;
        attemptId?: string;
      },
      value: unknown,
    ): Promise<ArtifactEntry> {
      lock.assertOwned();
      const state = (await readPrivateJson(filename, 4 * 1024 * 1024)) as unknown as AttemptJournal;
      check(state);
      const requestId = scope.requestId,
        attemptId = state.attemptId;
      if (
        (binding.requestId && binding.requestId !== requestId) ||
        (binding.attemptId && binding.attemptId !== attemptId)
      )
        throw new EvaluationError('artifact.integrity');
      const identity = {
        requestId,
        attemptId,
        caseId: binding.caseId,
        repetition: binding.repetition,
        side: binding.side,
        versionId: binding.versionId,
        digest: binding.digest,
        role: binding.role,
      };
      if (requestId !== scope.requestId) throw new EvaluationError('artifact.integrity');
      const envelope: PrivateArtifactEnvelope = { schemaVersion: 1, identity, value };
      const body = JSON.stringify(envelope),
        bytes = Buffer.byteLength(body);
      if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024 || bytes > 1024 * 1024 + 16 * 1024)
        throw new EvaluationError('artifact.integrity');
      const file = 'artifact-' + randomUUID() + '.json';
      await atomicPrivateWrite(path.join(directory, file), body);
      return {
        caseId: binding.caseId,
        repetition: binding.repetition,
        side: binding.side,
        versionId: binding.versionId,
        digest: binding.digest,
        role: binding.role,
        file,
        sha256: sha256(body),
        bytes,
      };
    },
    async readArtifactIndex(): Promise<ArtifactIndex | undefined> {
      lock.assertOwned();
      const file = path.join(directory, 'artifact-index.json');
      try {
        await lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      return (await readPrivateJson(file, 4 * 1024 * 1024)) as unknown as ArtifactIndex;
    },
    async saveArtifactIndex(value: ArtifactIndex) {
      lock.assertOwned();
      if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
        throw new EvaluationError('artifact.integrity');
      await atomicPrivateWrite(
        path.join(directory, 'artifact-index.json'),
        JSON.stringify(value) + '\n',
      );
      lock.assertOwned();
    },
  };
}
export type EvaluationJournal = Awaited<ReturnType<typeof openJournal>>;
