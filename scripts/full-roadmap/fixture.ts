import type { BundlePayload } from '../../packages/sdk/src/types.js';
/** Deterministic fake used only by the test transport. */
export function fixtureDraft(parent: BundlePayload, allowed: string[]) {
  const payload = structuredClone(parent);
  const file = payload.files.find((item) => allowed.includes(item.path));
  if (!file) throw new Error('No allowed file');
  file.text += '\nCheck whether retries repeat side effects without an idempotency key.\n';
  return { payload, rationale: 'Deterministic fixture edit' };
}

/** HTTP adapter fixture uses the bounded edit protocol; public trait doubles may return payloads. */
export function fixtureEdits(parent: BundlePayload, allowed: string[]) {
  const file = parent.files.find((item) => allowed.includes(item.path));
  if (!file) throw new Error('No allowed file');
  return {
    schemaVersion: 1,
    edits: [
      {
        path: file.path,
        oldText: file.text,
        newText:
          file.text + '\nCheck whether retries repeat side effects without an idempotency key.\n',
      },
    ],
    rationale: 'Deterministic fixture edit',
  };
}
