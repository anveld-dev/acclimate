import type {
  BundleFile,
  BundlePayload,
  CompatibilityTarget,
  FileKind,
  VerifiedBundle,
} from '../types.js';
import { validatePayload } from '../validation.js';
import { compatibilityIssues } from '../compatibility.js';
import { verifyPayloadBytes } from '../verification.js';
import { canonicalJson, sha256Bytes } from './identity.js';

export type MutationDigest = `sha256:${string}`;
export interface ParentBinding {
  projectId: string;
  bundleId: string;
  versionId: string;
  contentDigest: MutationDigest;
}
export interface MutationFileBinding {
  path: string;
  kind: FileKind;
  textDigest: MutationDigest;
}
export type MutationOperation =
  | {
      op: 'editText';
      file: MutationFileBinding;
      replacements: Array<{ oldText: string; newText: string }>;
    }
  | { op: 'createSkill'; name: string; files: Array<{ relativePath: string; text: string }> }
  | { op: 'retireSkill'; name: string; expectedPackageDigest: MutationDigest };
export interface MutationV1 {
  schemaVersion: 1;
  parent: ParentBinding;
  policyDigest: MutationDigest;
  operations: MutationOperation[];
  rationale: string;
  admissionDigests: MutationDigest[];
}
export interface MutationPolicyV1 {
  schemaVersion: 1;
  mode: 'fixed-files' | 'skill-packages';
  compatibilityTarget: CompatibilityTarget;
  editablePaths: string[];
  createSkillNames: string[];
  retireSkillNames: string[];
  maxChangedArtifacts: number;
  maxChangedFiles: number;
  maxAddedTextBytes: number;
  maxFinalFiles: number;
  maxFinalBytes: number;
  requiredPreflightIds: string[];
}
export interface CandidatePlanV1 {
  schemaVersion: 1;
  parent: ParentBinding;
  policyDigest: MutationDigest;
  mutationDigest: MutationDigest;
  payload: BundlePayload;
  changedFiles: Array<{
    path: string;
    before: MutationDigest | null;
    after: MutationDigest | null;
  }>;
  createdSkills: string[];
  retiredSkills: string[];
  requiredPreflightIds: string[];
  referenceReview: { state: 'required' | 'not-required'; paths: string[] };
}
export interface MutationPreparationV1 {
  schemaVersion: 1;
  kind: 'learning-mutation-preparation';
  operationId: string;
  attemptId: string;
  mutation: MutationV1;
  plan: CandidatePlanV1;
  passedPreflightIds: string[];
}
export type MutationErrorCode =
  | 'mutation.schema_unsupported'
  | 'mutation.invalid'
  | 'mutation.parent_mismatch'
  | 'mutation.policy_mismatch'
  | 'mutation.capability_denied'
  | 'mutation.precondition_failed'
  | 'mutation.operation_conflict'
  | 'mutation.limit_exceeded'
  | 'mutation.package_invalid'
  | 'mutation.native_incompatible'
  | 'mutation.no_change';
export class MutationError extends Error {
  constructor(
    readonly code: MutationErrorCode,
    readonly paths: readonly string[] = [],
  ) {
    super(code);
    this.name = 'MutationError';
  }
}
export const REFERENCE_PREFLIGHT_ID = 'learning.reference-review';
function fail(code: MutationErrorCode, paths: string[] = []): never {
  throw new MutationError(code, paths);
}
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const isDigest = (x: unknown): x is MutationDigest =>
  typeof x === 'string' && digestPattern.test(x);
const string = (x: unknown, maximum = 4096): x is string =>
  typeof x === 'string' && x.length > 0 && bytes(x) <= maximum;
function fields(x: unknown, names: readonly string[]): asserts x is Record<string, any> {
  if (
    !x ||
    typeof x !== 'object' ||
    Array.isArray(x) ||
    Object.keys(x).length !== names.length ||
    Object.keys(x).some((k) => !names.includes(k))
  )
    fail('mutation.invalid');
}
function uniqueStrings(x: unknown, max = 128): asserts x is string[] {
  if (
    !Array.isArray(x) ||
    x.length > max ||
    x.some((v) => !string(v, 240)) ||
    new Set(x).size !== x.length
  )
    fail('mutation.invalid');
}
function pathValid(path: string): boolean {
  try {
    validatePayload({ schemaVersion: 1, files: [{ path, kind: 'skill', text: '' }] });
    return true;
  } catch {
    return false;
  }
}
function binding(x: unknown): asserts x is ParentBinding {
  fields(x, ['projectId', 'bundleId', 'versionId', 'contentDigest']);
  if (
    !string(x.projectId, 256) ||
    !string(x.bundleId, 256) ||
    !string(x.versionId, 256) ||
    !isDigest(x.contentDigest)
  )
    fail('mutation.invalid');
}
function policyValid(x: unknown): asserts x is MutationPolicyV1 {
  fields(x, [
    'schemaVersion',
    'mode',
    'compatibilityTarget',
    'editablePaths',
    'createSkillNames',
    'retireSkillNames',
    'maxChangedArtifacts',
    'maxChangedFiles',
    'maxAddedTextBytes',
    'maxFinalFiles',
    'maxFinalBytes',
    'requiredPreflightIds',
  ]);
  if (x.schemaVersion !== 1) fail('mutation.schema_unsupported');
  if (
    !['fixed-files', 'skill-packages'].includes(x.mode) ||
    !['generic', 'codex', 'claude', 'pi', 'cursor'].includes(x.compatibilityTarget)
  )
    fail('mutation.invalid');
  for (const key of [
    'editablePaths',
    'createSkillNames',
    'retireSkillNames',
    'requiredPreflightIds',
  ])
    uniqueStrings(x[key]);
  if (
    x.editablePaths.some((p: string) => !pathValid(p)) ||
    [...x.createSkillNames, ...x.retireSkillNames].some((n: string) => !namePattern.test(n))
  )
    fail('mutation.invalid');
  if (x.mode === 'fixed-files' && (x.createSkillNames.length || x.retireSkillNames.length))
    fail('mutation.capability_denied');
  for (const [key, cap] of Object.entries({
    maxChangedArtifacts: 128,
    maxChangedFiles: 128,
    maxAddedTextBytes: 1024 * 1024,
    maxFinalFiles: 128,
    maxFinalBytes: 1024 * 1024,
  })) {
    if (
      !Number.isSafeInteger(x[key]) ||
      x[key] < (key === 'maxAddedTextBytes' ? 0 : 1) ||
      x[key] > cap
    )
      fail('mutation.limit_exceeded');
  }
}
/** Exact text bytes; no newline or Unicode normalization. */
export function textDigest(text: string): MutationDigest {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}
/** Versioned, bytewise-path-sorted inventory of one complete skill package. */
export function packageDigest(payload: BundlePayload, name: string): MutationDigest {
  const files = payload.files
    .filter((f) => f.path.startsWith(`skills/${name}/`))
    .map((f) => ({ path: f.path, kind: f.kind, textDigest: textDigest(f.text) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return textDigest(
    canonicalJson({ schemaVersion: 1, kind: 'skill-package-inventory', name, files }),
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function editOriginal(
  text: string,
  replacements: Array<{ oldText: string; newText: string }>,
  path: string,
): string {
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 128)
    fail('mutation.invalid');
  const edits = replacements
    .map((r) => {
      fields(r, ['oldText', 'newText']);
      if (typeof r.oldText !== 'string' || typeof r.newText !== 'string') fail('mutation.invalid');
      if (r.oldText === '') {
        if (text !== '' || replacements.length !== 1) fail('mutation.precondition_failed', [path]);
        return { start: 0, end: 0, text: r.newText };
      }
      const start = text.indexOf(r.oldText);
      if (start < 0 || text.indexOf(r.oldText, start + 1) >= 0)
        fail('mutation.precondition_failed', [path]);
      return { start, end: start + r.oldText.length, text: r.newText };
    })
    .sort((a, b) => a.start - b.start);
  if (edits.some((e, i) => i > 0 && e.start < edits[i - 1].end))
    fail('mutation.precondition_failed', [path]);
  let result = text;
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Pure atomic planning; publication, reference review and execution remain caller-owned effects. */
export function planCandidate(input: {
  parent: VerifiedBundle;
  /** Original fetched bytes are required: server content digests do not hash canonical reserialization. */
  payloadBytes: Uint8Array;
  /** Trusted scope/target supplied by the controller, not by a model response. */
  binding: ParentBinding;
  compatibilityTarget: CompatibilityTarget;
  mutation: MutationV1;
  policy: MutationPolicyV1;
  authorizedAdmissionDigests: readonly MutationDigest[];
}): CandidatePlanV1 {
  const { parent, binding: expected, mutation, policy } = input;
  // The artifact serializer rejects getters, proxies, sparse/undefined values and non-finite JSON.
  try {
    canonicalJson(mutation);
    canonicalJson(policy);
  } catch {
    fail('mutation.invalid');
  }
  binding(expected);
  policyValid(policy);
  fields(mutation, [
    'schemaVersion',
    'parent',
    'policyDigest',
    'operations',
    'rationale',
    'admissionDigests',
  ]);
  if (mutation.schemaVersion !== 1) fail('mutation.schema_unsupported');
  binding(mutation.parent);
  if (
    canonicalJson(mutation.parent) !== canonicalJson(expected) ||
    parent.version.id !== expected.versionId ||
    parent.version.bundleId !== expected.bundleId ||
    parent.version.digest !== expected.contentDigest
  )
    fail('mutation.parent_mismatch');
  try {
    const verified = verifyPayloadBytes(input.payloadBytes, expected.contentDigest);
    if (canonicalJson(verified) !== canonicalJson(parent.payload)) fail('mutation.parent_mismatch');
  } catch {
    fail('mutation.parent_mismatch');
  }
  if (
    policy.compatibilityTarget !== input.compatibilityTarget ||
    !isDigest(mutation.policyDigest) ||
    mutation.policyDigest !== textDigest(canonicalJson(policy))
  )
    fail('mutation.policy_mismatch');
  uniqueStrings(mutation.admissionDigests);
  if (
    mutation.admissionDigests.length === 0 ||
    mutation.admissionDigests.some(
      (d) => !isDigest(d) || !input.authorizedAdmissionDigests.includes(d),
    )
  )
    fail('mutation.capability_denied');
  if (
    !string(mutation.rationale) ||
    !Array.isArray(mutation.operations) ||
    !mutation.operations.length ||
    mutation.operations.length > 128
  )
    fail('mutation.invalid');
  if (mutation.operations.length > policy.maxChangedArtifacts) fail('mutation.limit_exceeded');

  const original = parent.payload.files;
  const edits = new Map<string, string>(),
    retired = new Set<string>(),
    created: BundleFile[] = [];
  const structural: string[] = [],
    createdSkills: string[] = [],
    retiredSkills: string[] = [];
  // Claim operation ownership before transforming anything; all preconditions bind original bytes.
  const claims: Array<{ path: string; package: boolean }> = [];
  for (const op of mutation.operations) {
    if (!op || typeof op !== 'object') fail('mutation.invalid');
    const packageOp = op.op === 'createSkill' || op.op === 'retireSkill';
    if (packageOp ? !namePattern.test(op.name) : op.op !== 'editText') fail('mutation.invalid');
    const path = packageOp ? `skills/${op.name}` : op.file?.path;
    if (!path || !pathValid(path)) fail('mutation.invalid');
    const lower = path.toLowerCase();
    if (
      claims.some(
        (c) =>
          c.path === lower ||
          (c.package && lower.startsWith(c.path + '/')) ||
          (packageOp && c.path.startsWith(lower + '/')),
      )
    )
      fail('mutation.operation_conflict', [path]);
    claims.push({ path: lower, package: packageOp });
  }
  for (const op of mutation.operations) {
    if (op.op === 'editText') {
      fields(op, ['op', 'file', 'replacements']);
      fields(op.file, ['path', 'kind', 'textDigest']);
      const file = original.find((f) => f.path === op.file.path);
      if (!policy.editablePaths.includes(op.file.path))
        fail('mutation.capability_denied', [op.file.path]);
      if (
        !file ||
        file.kind !== op.file.kind ||
        !isDigest(op.file.textDigest) ||
        textDigest(file.text) !== op.file.textDigest
      )
        fail('mutation.precondition_failed', [op.file.path]);
      edits.set(file.path, editOriginal(file.text, op.replacements, file.path));
    } else if (op.op === 'createSkill') {
      fields(op, ['op', 'name', 'files']);
      if (policy.mode !== 'skill-packages' || !policy.createSkillNames.includes(op.name))
        fail('mutation.capability_denied');
      const root = `skills/${op.name}`;
      if (
        original.some(
          (f) =>
            f.path.toLowerCase() === root.toLowerCase() ||
            f.path.toLowerCase().startsWith(root.toLowerCase() + '/'),
        )
      )
        fail('mutation.precondition_failed', [root]);
      if (!Array.isArray(op.files) || !op.files.length || op.files.length > 128)
        fail('mutation.invalid');
      const files = op.files
        .map((f) => {
          fields(f, ['relativePath', 'text']);
          if (
            !string(f.relativePath, 240) ||
            !pathValid(f.relativePath) ||
            typeof f.text !== 'string'
          )
            fail('mutation.invalid');
          if (bytes(f.text) > 256 * 1024) fail('mutation.limit_exceeded');
          return { path: `${root}/${f.relativePath}`, kind: 'skill' as const, text: f.text };
        })
        .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      try {
        validatePayload({ schemaVersion: 1, files });
      } catch {
        fail('mutation.package_invalid', [root]);
      }
      // A generic target still needs a real skill manifest, not an orphan resource directory.
      if (
        compatibilityIssues(
          { schemaVersion: 1, files },
          input.compatibilityTarget === 'generic' ? 'codex' : input.compatibilityTarget,
        ).length
      )
        fail('mutation.package_invalid', [root]);
      created.push(...files);
      structural.push(root);
      createdSkills.push(op.name);
    } else {
      fields(op, ['op', 'name', 'expectedPackageDigest']);
      if (policy.mode !== 'skill-packages' || !policy.retireSkillNames.includes(op.name))
        fail('mutation.capability_denied');
      const root = `skills/${op.name}`,
        members = original.filter((f) => f.path.startsWith(root + '/'));
      if (
        !members.length ||
        members.some((f) => f.kind !== 'skill') ||
        !isDigest(op.expectedPackageDigest) ||
        packageDigest(parent.payload, op.name) !== op.expectedPackageDigest
      )
        fail('mutation.precondition_failed', [root]);
      for (const file of members) retired.add(file.path);
      structural.push(root);
      retiredSkills.push(op.name);
    }
  }
  const payload: BundlePayload = {
    schemaVersion: 1,
    files: [
      ...original
        .filter((f) => !retired.has(f.path))
        .map((f) => ({ ...f, text: edits.get(f.path) ?? f.text })),
      ...created,
    ],
  };
  const byPath = new Map(payload.files.map((f) => [f.path, f]));
  const changes: CandidatePlanV1['changedFiles'] = [];
  let addedBytes = 0;
  for (const before of original) {
    const after = byPath.get(before.path);
    if (!after || after.text !== before.text) {
      changes.push({
        path: before.path,
        before: textDigest(before.text),
        after: after ? textDigest(after.text) : null,
      });
      addedBytes += Math.max(0, (after ? bytes(after.text) : 0) - bytes(before.text));
    }
  }
  for (const after of created) {
    changes.push({ path: after.path, before: null, after: textDigest(after.text) });
    addedBytes += bytes(after.text);
  }
  if (!changes.length) fail('mutation.no_change');
  if (payload.files.some((f) => bytes(f.text) > 256 * 1024)) fail('mutation.limit_exceeded');
  if (
    changes.length > policy.maxChangedFiles ||
    addedBytes > policy.maxAddedTextBytes ||
    payload.files.length > policy.maxFinalFiles ||
    payload.files.reduce((n, f) => n + bytes(f.text), 0) > policy.maxFinalBytes
  )
    fail('mutation.limit_exceeded');
  try {
    validatePayload(payload);
  } catch {
    fail('mutation.package_invalid');
  }
  if (compatibilityIssues(payload, input.compatibilityTarget).length)
    fail('mutation.native_incompatible');
  return freeze(
    structuredClone({
      schemaVersion: 1,
      parent: expected,
      policyDigest: mutation.policyDigest,
      mutationDigest: textDigest(canonicalJson(mutation)),
      payload,
      changedFiles: changes,
      createdSkills,
      retiredSkills,
      requiredPreflightIds: [
        ...new Set([
          ...policy.requiredPreflightIds,
          ...(structural.length ? [REFERENCE_PREFLIGHT_ID] : []),
        ]),
      ],
      referenceReview: {
        state: structural.length ? 'required' : 'not-required',
        paths: structural,
      },
    }),
  );
}
