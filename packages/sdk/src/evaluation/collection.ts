import { createHash } from 'node:crypto';
import type { CaseKey } from '../types.js';
import { EvaluationError } from './errors.js';
import type { EvaluationCollection } from './types.js';

export type CollectionSide = 'parent' | 'candidate';
export interface CollectionPair extends CaseKey {
  firstSide: CollectionSide;
}
export interface CollectionSchedule {
  protocol: 'seeded-balanced-v1';
  seed: string;
  pairs: readonly CollectionPair[];
  digest: string;
}
export const COLLECTION_RUNTIME_KEYS = [
  'acclimate.collection.protocol',
  'acclimate.collection.seed',
  'acclimate.collection.schedule',
] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = ({ caseId, repetition }: CaseKey) => JSON.stringify([caseId, repetition]);

/** Balances which arm goes first. It does not isolate fixtures or randomize task inputs. */
export function collectionSchedule(
  config: EvaluationCollection,
  inventory: readonly CaseKey[],
): CollectionSchedule {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((k) => !['protocol', 'seed'].includes(k)) ||
    config.protocol !== 'seeded-balanced-v1' ||
    typeof config.seed !== 'string' ||
    !config.seed.trim() ||
    Buffer.byteLength(config.seed, 'utf8') > 256 ||
    /[\ud800-\udfff]/u.test(config.seed)
  )
    throw new EvaluationError('config.schema');
  // Hash ranking avoids runtime-dependent PRNG behavior and binds allocation to
  // the exact case/repetition inventory. Alternation guarantees an imbalance <= 1.
  const ranked = inventory
    .map((pair) => ({
      key: key(pair),
      rank: hash(JSON.stringify([config.seed, pair.caseId, pair.repetition])),
    }))
    .sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
  if (new Set(ranked.map((pair) => pair.key)).size !== inventory.length)
    throw new EvaluationError('config.schema');
  const phase = parseInt(hash(JSON.stringify([config.seed, 'first-arm'])).slice(0, 2), 16) % 2;
  const first = new Map(
    ranked.map((pair, index) => [
      pair.key,
      (index + phase) % 2 ? ('candidate' as const) : ('parent' as const),
    ]),
  );
  const pairs = inventory.map((pair) => ({
    caseId: pair.caseId,
    repetition: pair.repetition,
    firstSide: first.get(key(pair))!,
  }));
  const manifest = { protocol: config.protocol, seed: config.seed, pairs };
  return { ...manifest, digest: 'sha256:' + hash(JSON.stringify(manifest) + '\n') };
}

export function collectionRuntime(schedule: CollectionSchedule): Record<string, string> {
  return {
    [COLLECTION_RUNTIME_KEYS[0]]: schedule.protocol,
    [COLLECTION_RUNTIME_KEYS[1]]: schedule.seed,
    [COLLECTION_RUNTIME_KEYS[2]]: schedule.digest,
  };
}
