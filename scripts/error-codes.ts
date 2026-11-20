/**
 * Render the evaluator diagnostic-code table in the error-code reference page from the
 * TypeScript SDK catalog. Both SDK test suites check the page against their catalogs.
 *
 *   npx tsx scripts/error-codes.ts          # check
 *   npx tsx scripts/error-codes.ts --write  # regenerate
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EVALUATION_ERROR_CODES, EXIT_CODES } from '../packages/sdk/src/evaluation/errors.js';

export const ERROR_CODES_PAGE = fileURLToPath(
  new URL('../apps/docs/content/docs/reference/error-codes.mdx', import.meta.url),
);
const BEGIN = '{/* BEGIN GENERATED: npx tsx scripts/error-codes.ts --write */}';
const END = '{/* END GENERATED */}';

const exitMeaning: Record<number, string> = {
  [EXIT_CODES.ok]: 'The command succeeded.',
  [EXIT_CODES.usage]: 'Fix the command line, configuration or application.',
  [EXIT_CODES.infrastructure]: 'The service or local runtime failed.',
  [EXIT_CODES.recovery]: 'Check local ownership or callback state before retrying.',
};

export function renderErrorCodeTables(): string {
  const exits = Object.entries(EXIT_CODES)
    .sort(([, a], [, b]) => a - b)
    .map(([name, code]) => `| ${code} | \`${name}\` | ${exitMeaning[code]} |`);
  const codes = Object.entries(EVALUATION_ERROR_CODES).map(
    ([code, info]) =>
      `| \`${code}\` | ${info.exitCode} | \`${info.nextAction}\` | ${info.message.replace(/\|/g, '\\|')} |`,
  );
  return [
    BEGIN,
    '',
    '### Exit codes',
    '',
    '| Exit | Name | Meaning |',
    '| --- | --- | --- |',
    ...exits,
    '',
    '### Diagnostic codes',
    '',
    'Execution state overrides the default exit: a diagnostic with `executionState` `may_have_started` or `report_saved` always exits 5.',
    '',
    '| Code | Exit | Next action | Meaning |',
    '| --- | --- | --- | --- |',
    ...codes,
    '',
    END,
  ].join('\n');
}

export function renderedPage(current: string): string {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${ERROR_CODES_PAGE} is missing its generated markers.`);
  return current.slice(0, start) + renderErrorCodeTables() + current.slice(end + END.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const current = readFileSync(ERROR_CODES_PAGE, 'utf8');
  const next = renderedPage(current);
  if (process.argv.includes('--write')) writeFileSync(ERROR_CODES_PAGE, next);
  else if (next !== current) {
    console.error('The error-code reference is stale. Run: npx tsx scripts/error-codes.ts --write');
    process.exitCode = 1;
  }
}
