import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { acquireFileLock, EvaluationBusyError } from '../evaluation/journal.js';
import {
  atomicPrivateWrite,
  privateDirectory,
  readPrivateText,
} from '../evaluation/private-state.js';
import { canonicalJson, parseArtifact, sha256Bytes } from './identity.js';
import type { Ref, Sha256 } from './evidence-types.js';

const MAXIMUM_BYTES = 16 * 1024 * 1024;
const MAXIMUM_COMMANDS = 10_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export class LearningStoreError extends Error {
  constructor(readonly code: string) {
    super(`Learning store: ${code}`);
    this.name = 'LearningStoreError';
  }
}
export interface LearningLock {
  readonly signal: AbortSignal;
  assertOwned(): void;
}
export interface CommandReceipt {
  commandId: string;
  sha256: Sha256;
  sequence: number;
}
export interface InboxEntry<T = unknown> extends CommandReceipt {
  command: T;
}
interface Inbox {
  schemaVersion: 1;
  directory: string;
  admissionClosed: boolean;
  entries: InboxEntry[];
}
interface CheckpointEnvelope {
  schemaVersion: 1;
  directory: string;
  sha256: Sha256;
  state: { revision: number };
}
export interface LearningStore {
  readonly directory: string;
  readCheckpoint<T extends { revision: number }>(): Promise<T | null>;
  writeCheckpoint<T extends { revision: number }>(
    expectedRevision: number | null,
    next: T,
  ): Promise<void>;
  putArtifact<T>(value: T): Promise<Ref<T>>;
  readArtifact<T>(reference: Ref<T>): Promise<T>;
  submit<T>(commandId: string, command: T): Promise<CommandReceipt>;
  readInbox<T = unknown>(afterSequence: number): Promise<InboxEntry<T>[]>;
  withWorkerLock<T>(action: (lock: LearningLock) => Promise<T>): Promise<T>;
  withInboxLock<T>(action: (lock: LearningLock) => Promise<T>): Promise<T>;
  withAdmission<T>(action: (lock: LearningLock) => Promise<T>): Promise<T>;
  admissionBarrier(): Promise<boolean>;
  setAdmissionBarrier(closed: boolean, throughSequence?: number): Promise<void>;
}

type OwnedLock = Awaited<ReturnType<typeof acquireFileLock>>;
// Reentrancy belongs to an async call chain, never to a shared boolean on a store handle.
const ownership = new AsyncLocalStorage<ReadonlyMap<string, OwnedLock>>();

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new LearningStoreError('corrupt');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LearningStoreError('corrupt');
  return value as Record<string, unknown>;
}
function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function readCanonical(filename: string): Promise<unknown> {
  const bytes = await readPrivateText(filename, MAXIMUM_BYTES);
  try {
    const value: unknown = JSON.parse(bytes);
    if (canonicalJson(value) !== bytes) throw new Error();
    return value;
  } catch {
    throw new LearningStoreError('corrupt');
  }
}
function bounded(value: unknown): string {
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > MAXIMUM_BYTES) throw new LearningStoreError('size-limit');
  return bytes;
}

/** A single-host private store; no process lock remains held after a callback returns. */
export async function openLearningStore(directory: string): Promise<LearningStore> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw new LearningStoreError('directory');
  await privateDirectory(directory);
  if ((await realpath(directory)) !== directory) throw new LearningStoreError('directory');
  const artifacts = path.join(directory, 'artifacts');
  await privateDirectory(artifacts);
  const checkpointFile = path.join(directory, 'checkpoint.json');
  const inboxFile = path.join(directory, 'inbox.json');

  async function locked<T>(
    name: string,
    wait: boolean,
    action: (lock: LearningLock) => Promise<T>,
  ): Promise<T> {
    const filename = path.join(directory, name + '.lock');
    const inherited = ownership.getStore();
    for (const inheritedLock of inherited?.values() ?? []) inheritedLock.assertOwned();
    const current = inherited?.get(filename);
    if (current) {
      if (name === 'worker') throw new LearningStoreError('busy');
      current.assertOwned();
      return action(current);
    }
    let lock: OwnedLock | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        lock = await acquireFileLock(filename);
        break;
      } catch (error) {
        if (!(error instanceof EvaluationBusyError)) throw error;
        if (!wait || attempt >= 100) throw new LearningStoreError('busy');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const owned = new Map(inherited);
    owned.set(filename, lock);
    try {
      lock.assertOwned();
      const result = await ownership.run(owned, () => action(lock!));
      for (const held of owned.values()) held.assertOwned();
      return result;
    } finally {
      await lock.close();
    }
  }

  async function loadCheckpoint<T extends { revision: number }>(): Promise<T | null> {
    if (!(await exists(checkpointFile))) return null;
    const envelope = record(await readCanonical(checkpointFile));
    exactKeys(envelope, ['schemaVersion', 'directory', 'sha256', 'state']);
    if (envelope.schemaVersion !== 1 || envelope.directory !== directory)
      throw new LearningStoreError('checkpoint-scope');
    const state = record(envelope.state);
    if (!revision(state.revision) || sha256Bytes(canonicalJson(state)) !== envelope.sha256)
      throw new LearningStoreError('corrupt');
    return state as T;
  }
  async function loadInbox(): Promise<Inbox> {
    if (!(await exists(inboxFile)))
      return { schemaVersion: 1, directory, admissionClosed: false, entries: [] };
    const value = record(await readCanonical(inboxFile));
    exactKeys(value, ['schemaVersion', 'directory', 'admissionClosed', 'entries']);
    if (
      value.schemaVersion !== 1 ||
      value.directory !== directory ||
      typeof value.admissionClosed !== 'boolean' ||
      !Array.isArray(value.entries) ||
      value.entries.length > MAXIMUM_COMMANDS
    )
      throw new LearningStoreError('corrupt');
    const commandIds = new Set<string>();
    for (let index = 0; index < value.entries.length; index++) {
      const entry = record(value.entries[index]);
      exactKeys(entry, ['commandId', 'sha256', 'sequence', 'command']);
      if (
        typeof entry.commandId !== 'string' ||
        !ID.test(entry.commandId) ||
        commandIds.has(entry.commandId) ||
        entry.sequence !== index + 1 ||
        entry.sha256 !== sha256Bytes(canonicalJson(entry.command))
      )
        throw new LearningStoreError('corrupt');
      commandIds.add(entry.commandId);
    }
    return value as unknown as Inbox;
  }
  async function saveInbox(inbox: Inbox): Promise<void> {
    await atomicPrivateWrite(inboxFile, bounded(inbox));
  }

  return {
    directory,
    readCheckpoint: loadCheckpoint,
    async writeCheckpoint(expectedRevision, next) {
      if (
        !(expectedRevision === null || revision(expectedRevision)) ||
        !revision(next?.revision) ||
        next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)
      )
        throw new LearningStoreError('revision');
      const state = JSON.parse(bounded(next)) as { revision: number };
      await locked('checkpoint', true, async (lock) => {
        const previous = await loadCheckpoint();
        if ((previous?.revision ?? null) !== expectedRevision)
          throw new LearningStoreError('checkpoint-conflict');
        const envelope: CheckpointEnvelope = {
          schemaVersion: 1,
          directory,
          sha256: sha256Bytes(canonicalJson(state)),
          state,
        };
        lock.assertOwned();
        await atomicPrivateWrite(checkpointFile, bounded(envelope));
      });
    },
    async putArtifact<T>(value: T): Promise<Ref<T>> {
      const bytes = bounded(value);
      const sha256 = sha256Bytes(bytes);
      const id = sha256.slice(7);
      const reference: Ref<T> = { id, sha256, bytes: Buffer.byteLength(bytes) };
      const filename = path.join(artifacts, id + '.json');
      await locked('artifacts', true, async (lock) => {
        if (await exists(filename)) {
          parseArtifact(reference, await readPrivateText(filename, MAXIMUM_BYTES));
          return;
        }
        lock.assertOwned();
        await atomicPrivateWrite(filename, bytes);
      });
      return reference;
    },
    async readArtifact<T>(reference: Ref<T>): Promise<T> {
      if (
        !reference ||
        !/^[a-f0-9]{64}$/.test(reference.id) ||
        !DIGEST.test(reference.sha256) ||
        reference.id !== reference.sha256.slice(7) ||
        !revision(reference.bytes) ||
        reference.bytes > MAXIMUM_BYTES
      )
        throw new LearningStoreError('artifact-reference');
      return parseArtifact(
        reference,
        await readPrivateText(path.join(artifacts, reference.id + '.json'), MAXIMUM_BYTES),
      );
    },
    async submit(commandId, command) {
      if (!ID.test(commandId)) throw new LearningStoreError('command-id');
      // Snapshot before awaiting ownership so caller mutation cannot change the accepted body.
      const commandBytes = bounded(command);
      const sha256 = sha256Bytes(commandBytes);
      const snapshot = JSON.parse(commandBytes) as unknown;
      return locked('inbox', true, async (lock) => {
        const inbox = await loadInbox();
        const existing = inbox.entries.find((entry) => entry.commandId === commandId);
        if (existing) {
          if (existing.sha256 !== sha256) throw new LearningStoreError('command-conflict');
          return { commandId, sha256, sequence: existing.sequence };
        }
        if (inbox.entries.length >= MAXIMUM_COMMANDS) throw new LearningStoreError('inbox-full');
        const entry = { commandId, sha256, sequence: inbox.entries.length + 1, command: snapshot };
        inbox.entries.push(entry);
        if (
          snapshot &&
          typeof snapshot === 'object' &&
          (snapshot as { kind?: string }).kind === 'request-stop'
        )
          inbox.admissionClosed = true;
        lock.assertOwned();
        // Command acceptance and a stop's barrier are persisted in one atomic replacement.
        await saveInbox(inbox);
        return { commandId, sha256, sequence: entry.sequence };
      });
    },
    async readInbox<T>(afterSequence: number): Promise<InboxEntry<T>[]> {
      if (!revision(afterSequence)) throw new LearningStoreError('sequence');
      const inbox = await loadInbox();
      if (afterSequence > inbox.entries.length) throw new LearningStoreError('sequence');
      return inbox.entries.slice(afterSequence) as InboxEntry<T>[];
    },
    withWorkerLock: (action) => locked('worker', false, action),
    withInboxLock: (action) => locked('inbox', true, action),
    withAdmission: (action) =>
      locked('inbox', true, async (lock) => {
        if ((await loadInbox()).admissionClosed) throw new LearningStoreError('admission-closed');
        lock.assertOwned();
        return action(lock);
      }),
    async admissionBarrier() {
      return (await loadInbox()).admissionClosed;
    },
    async setAdmissionBarrier(closed, throughSequence) {
      if (typeof closed !== 'boolean') throw new LearningStoreError('barrier');
      await locked('inbox', true, async (lock) => {
        const inbox = await loadInbox();
        if (
          throughSequence !== undefined &&
          (!revision(throughSequence) || throughSequence > inbox.entries.length)
        )
          throw new LearningStoreError('sequence');
        inbox.admissionClosed =
          closed ||
          (throughSequence !== undefined &&
            inbox.entries.some(
              (entry) =>
                entry.sequence > throughSequence &&
                entry.command !== null &&
                typeof entry.command === 'object' &&
                (entry.command as { kind?: string }).kind === 'request-stop',
            ));
        lock.assertOwned();
        await saveInbox(inbox);
      });
    },
  };
}
