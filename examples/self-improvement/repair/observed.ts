/** Adoption evidence only. Grading still uses the unmodified final agent response. */
export function helperOutput(
  commands: { command: string; exitCode?: number | null; output: string }[],
  ids: string[],
): unknown | null {
  for (const c of [...commands].reverse()) {
    if (
      !/\bpython3?(?:\.\d+)?\s+["']?(?:\.\/)?\.agents\/skills\/payment-triage\/scripts\/triage\.py["']?\s+["']?task\.json(?:[\s"']|$)/.test(
        c.command,
      ) ||
      c.exitCode !== 0
    )
      continue;
    // A legitimate command can print inspected inputs before invoking the helper.
    // Parse only a complete trailing JSON object, never a brace inside source code.
    const starts = [0, ...[...c.output.matchAll(/^\s*\{/gm)].map((m) => m.index!)].reverse();
    for (const start of starts)
      try {
        const value = JSON.parse(c.output.slice(start).trim());
        const rows = value.decisions as { id: string }[];
        if (
          Array.isArray(rows) &&
          rows.length === ids.length &&
          new Set(rows.map((r) => r.id)).size === ids.length &&
          ids.every((id) => rows.some((r) => r.id === id))
        )
          return value;
      } catch {
        continue;
      }
  }
  return null;
}
export function helperObserved(commands: Parameters<typeof helperOutput>[0], ids: string[]) {
  return helperOutput(commands, ids) !== null;
}
