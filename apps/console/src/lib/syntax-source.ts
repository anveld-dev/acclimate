/** Keep source bytes independent from presentation and editor line-ending conventions. */
export function sourceLines(source: string): { text: string; ending: string }[] {
  const lines: { text: string; ending: string }[] = [];
  const pattern = /\r\n|\r|\n/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    lines.push({ text: source.slice(offset, match.index), ending: match[0] });
    offset = match.index! + match[0].length;
  }
  lines.push({ text: source.slice(offset), ending: '' });
  return lines;
}

export function editorText(source: string) {
  return source.replace(/\r\n|\r/g, '\n');
}

export type SourceChange = { from: number; to: number; insert: string };

/** Apply logical editor offsets to raw source without normalizing untouched CRLF/mixed endings. */
export function applySourceChanges(source: string, changes: readonly SourceChange[]) {
  const offsets = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r' && source[index + 1] === '\n') index++;
    offsets.push(index + 1);
  }
  const ending = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  let previous = 0;
  let result = '';
  for (const change of changes) {
    if (change.from < previous || change.to < change.from || change.to >= offsets.length)
      throw new Error('Invalid source edit offsets');
    result += source.slice(offsets[previous], offsets[change.from]);
    result += editorText(change.insert).replace(/\n/g, ending);
    previous = change.to;
  }
  return result + source.slice(offsets[previous]);
}

export function sourceRange(source: string, from: number, to: number) {
  let logical = 0;
  let start = from === 0 ? 0 : -1;
  let end = to === 0 ? 0 : -1;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r' && source[index + 1] === '\n') index++;
    logical++;
    if (logical === from) start = index + 1;
    if (logical === to) end = index + 1;
  }
  if (start < 0 || end < start) throw new Error('Invalid source selection');
  return source.slice(start, end);
}

/** Reconcile native textarea fallback input without rewriting unchanged raw line endings. */
export function reconcileEditorText(source: string, next: string) {
  const previous = editorText(source);
  next = editorText(next);
  if (previous === next) return source;
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  return applySourceChanges(source, [
    {
      from: prefix,
      to: previous.length - suffix,
      insert: next.slice(prefix, next.length - suffix),
    },
  ]);
}
