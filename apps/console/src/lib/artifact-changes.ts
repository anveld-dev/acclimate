import type { BundlePayload } from '@acclimate/sdk';

export function artifactChanges(base: BundlePayload, current: BundlePayload) {
  const before = new Map(base.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((path) => {
    const a = before.get(path),
      b = after.get(path);
    if (a && b && a.kind === b.kind && a.text === b.text) return [];
    return [
      {
        path,
        before: a,
        after: b,
        kind: (b || a)!.kind,
        operation: !a ? ('Added' as const) : !b ? ('Removed' as const) : ('Changed' as const),
      },
    ];
  });
}
