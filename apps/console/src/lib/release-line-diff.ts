import { diffArrays } from 'diff';

interface SourceLine {
  number: number;
  text: string;
  changed: boolean;
}
export type SplitRow = { before?: SourceLine; after?: SourceLine; skipped?: number };

/** Preserve original line numbers and omit only unchanged interiors. Cap expensive rewrites. */
export function releaseLineDiff(before: string | undefined, after: string | undefined): SplitRow[] {
  const lines = (text: string | undefined) => (text ? text.split('\n') : []);
  return alignSourceLines(lines(before), lines(after));
}

export function alignSourceLines(left: string[], right: string[]): SplitRow[] {
  const chunks = diffArrays(left, right, { maxEditLength: 512 }) ?? [
    { value: left, removed: true, added: false },
    { value: right, removed: false, added: true },
  ];
  const rows: SplitRow[] = [];
  let i = 0,
    j = 0;
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    if (chunk.added || chunk.removed) {
      const removed = chunk.removed ? chunk.value : [];
      const added = chunk.added ? chunk.value : chunks[k + 1]?.added ? chunks[++k].value : [];
      for (let n = 0; n < Math.max(removed.length, added.length); n++)
        rows.push({
          before: n < removed.length ? { number: ++i, text: removed[n], changed: true } : undefined,
          after: n < added.length ? { number: ++j, text: added[n], changed: true } : undefined,
        });
    } else {
      const length = chunk.value.length;
      for (let n = 0; n < length; n++) {
        if (length > 6 && n === 2) {
          const skipped = length - 4;
          rows.push({ skipped });
          i += skipped;
          j += skipped;
          n += skipped - 1;
          continue;
        }
        rows.push({
          before: { number: ++i, text: chunk.value[n], changed: false },
          after: { number: ++j, text: chunk.value[n], changed: false },
        });
      }
    }
  }
  return rows;
}
