import type { BundlePayload } from '../../packages/sdk/src/types.js';
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
