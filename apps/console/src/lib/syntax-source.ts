/** Keep source bytes independent from presentation. */
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
