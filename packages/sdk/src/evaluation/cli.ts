import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { preflightEvaluation } from './runner.js';
import type { EvaluationApp } from './types.js';
import { tryCommand, TRY_USAGE } from './local-cli.js';
import { loadLocalPayload } from './local.js';
import { pullCommand, pullHelp } from './pull.js';
import { payloadCompatibility } from './compatibility-check.js';
import { EVALUATION_ERROR_CODES, EvaluationError, EvaluationUsageError, EXIT_CODES, exitCodeFor, toSafeDiagnostic, type ExitCode } from './errors.js';

const allowed = {
  try: ['case', 'payload', 'live', 'case-timeout'],
  coverage: [],
  describe: [],
  doctor: ['config', 'bundle', 'payload'],
  pull: ['config', 'bundle', 'channel', 'out'],
};
type Command = keyof typeof allowed;
const globalFlags = ['json', 'verbose'];
const booleanFlags = new Set(['live', 'json', 'verbose']);
const pathFlags = new Set(['config', 'payload', 'out']);
export const ADAPTER_FREE_COMMANDS: readonly string[] = ['pull'];
export const EVALUATOR_COMMANDS = Object.keys(allowed) as readonly Command[];
interface Parsed {
  command: Command;
  flags: Record<string, string | boolean>;
}
const commandList = () => EVALUATOR_COMMANDS.join(', ');
const flagList = (command: Command) =>
  [...allowed[command], ...globalFlags].map((name) => '--' + name).join(', ');
const printable = (value: string) => JSON.stringify(value.slice(0, 80));

/** The installed SDK version. */
export function sdkVersion(): string {
  try {
    return String(createRequire(import.meta.url)('../../package.json').version);
  } catch {
    return 'unknown';
  }
}

/** Parse evaluator arguments without loading application code or reading files. */
export function parseEvaluatorArguments(argv: readonly string[], cwd = process.cwd()): Parsed {
  if (!argv.length)
    throw new EvaluationUsageError('usage.missing_command', {
      hint: `Choose a command: ${commandList()}. Run with --help for usage.`,
    });
  const command = argv[0] as Command;
  if (!Object.hasOwn(allowed, command))
    throw new EvaluationUsageError('usage.unknown_command', {
      field: printable(String(argv[0])),
      hint: `Choose a command: ${commandList()}. Run with --help for usage.`,
    });
  const flags: Record<string, string | boolean> = {};
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    if (typeof flag !== 'string' || !flag.startsWith('--'))
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: printable(String(flag)),
        reason: 'Unexpected argument. Values must follow their flag.',
        hint: `${command} accepts ${flagList(command)}.`,
      });
    const name = flag.slice(2);
    const commandFlags: readonly string[] = allowed[command];
    if (!commandFlags.includes(name) && !globalFlags.includes(name))
      throw new EvaluationUsageError('usage.unknown_flag', {
        field: printable(flag),
        hint: `${command} accepts ${flagList(command)}.`,
      });
    if (Object.hasOwn(flags, name))
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: flag,
        reason: `Supply ${flag} once.`,
      });
    if (booleanFlags.has(name)) flags[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new EvaluationUsageError('usage.missing_flag', {
          field: flag,
          reason: `${flag} needs a value.`,
        });
      flags[name] = pathFlags.has(name) ? resolve(cwd, value) : value;
    }
  }
  return { command, flags };
}
function required(flags: Parsed['flags'], name: string, hint?: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || !value)
    throw new EvaluationUsageError('usage.missing_flag', {
      field: '--' + name,
      ...(hint ? { hint } : {}),
    });
  return value;
}

const DOCTOR_USAGE = 'doctor --config CONFIG --bundle ID [--payload FILE]';

export async function evaluationMain(
  app: EvaluationApp<any, any, any>,
  argv: readonly string[] = process.argv.slice(2),
  options: { cwd?: string } = {},
): Promise<number> {
  return runCommand(argv, async ({ command, flags }) => {
    switch (command) {
      case 'describe': return { status: EXIT_CODES.ok, result: app.descriptor };
      case 'try': return tryCommand(app, flags);
      case 'pull': return pullCommand(flags);
      case 'coverage':
        throw new EvaluationUsageError('usage.unknown_command', {
          field: 'coverage', hint: 'Run coverage through the installed acclimate-eval command.',
        });
      case 'doctor': {
        const payload = flags.payload ? await loadLocalPayload(required(flags, 'payload')) : undefined;
        const compatibility = payload ? payloadCompatibility(app, payload.payload) : undefined;
        const result = await preflightEvaluation({
          app, configPath: required(flags, 'config'), target: { bundleId: required(flags, 'bundle') },
        });
        return {
          status: result.status === 'blocked' || compatibility?.issues.length ? EXIT_CODES.usage : EXIT_CODES.ok,
          result: { ...result, ...(compatibility && { compatibility }) },
        };
      }
    }
  }, options.cwd);
}

export async function evaluationReadMain(argv: readonly string[]): Promise<number> {
  return runCommand(argv, async ({ command, flags }) => {
    if (command !== 'pull') throw new EvaluationUsageError('usage.unknown_command', { field: command });
    return pullCommand(flags);
  });
}

const usageFor = (command: string) => ({ try: TRY_USAGE, doctor: DOCTOR_USAGE, pull: pullHelp })[command as 'try' | 'doctor' | 'pull'];

/** True when --verbose was passed or ACCLIMATE_DEBUG is set to a truthy value. */
export function verboseRequested(argv: readonly string[]): boolean {
  const debug = process.env.ACCLIMATE_DEBUG;
  return argv.includes('--verbose') || (!!debug && !['0', 'false', 'no'].includes(debug.toLowerCase()));
}

/** The first line of an exception, without control characters. */
function describeCause(cause: unknown): { name: string; message: string; code?: string } | undefined {
  if (cause === undefined || cause === null) return undefined;
  const name =
    cause instanceof Error && /^[A-Za-z_$][\w$]{0,127}$/.test(cause.name) ? cause.name : typeof cause;
  const message = String(cause instanceof Error ? cause.message : cause)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ')
    .split('\n')[0]
    .slice(0, 1000);
  const code = (cause as { code?: unknown })?.code;
  return {
    name,
    message,
    ...(typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? { code } : {}),
  };
}
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = (error as { cause?: unknown })?.cause;
  while (current !== undefined && chain.length < 5) {
    chain.push(current);
    current = (current as { cause?: unknown })?.cause;
  }
  return chain;
}

/**
 * Print an error for a local evaluator command and return its exit code. On a terminal,
 * stderr gets readable text; otherwise, or with --json, one JSON line. Pass --verbose or
 * set ACCLIMATE_DEBUG=1 to include the stack and the chained cause.
 */
export function reportEvaluatorError(
  error: unknown,
  argv: readonly string[],
  command: string = 'invalid',
): ExitCode {
  const diagnostic = toSafeDiagnostic(error);
  const hint = diagnostic.hint;
  const message =
    error instanceof EvaluationError
      ? error.message
      : EVALUATION_ERROR_CODES[diagnostic.code].message;
  const verbose = verboseRequested(argv);
  // An unexpected exception is itself the cause; an evaluator error names its chained cause.
  const causes = error instanceof EvaluationError ? causeChain(error) : [error, ...causeChain(error)];
  const firstCause = describeCause(causes[0]);
  const publicDiagnostic = {
    ...diagnostic,
    message,
    ...(hint ? { hint } : {}),
    ...(firstCause ? { cause: firstCause } : {}),
  };
  const human = process.stderr.isTTY === true && !argv.includes('--json');
  if (human) {
    const lines = [`error[${diagnostic.code}]: ${message}`];
    if (diagnostic.field && !message.includes(diagnostic.field)) lines.push(`  field: ${diagnostic.field}`);
    if (diagnostic.reason && !message.includes(diagnostic.reason)) lines.push(`  reason: ${diagnostic.reason}`);
    if (diagnostic.missingFields?.length)
      lines.push(`  missing fields: ${diagnostic.missingFields.join(', ')}`);
    if (diagnostic.serviceUrl) lines.push(`  service: ${diagnostic.serviceUrl}`);
    if (firstCause)
      lines.push(
        `  caused by: ${firstCause.name}${firstCause.code ? ` [${firstCause.code}]` : ''}: ${firstCause.message}`,
      );
    if (hint) lines.push(`  hint: ${hint.split('\n').join('\n        ')}`);
    else if (usageFor(command) && diagnostic.code.startsWith('usage.'))
      lines.push('  usage:\n    ' + usageFor(command)!.split('\n').join('\n    '));
    lines.push(`  next: ${diagnostic.nextAction}`);
    if (verbose) {
      for (const item of new Set([error, ...causes]))
        if (item instanceof Error && item.stack) lines.push('', item.stack);
    } else if (firstCause) lines.push('  Rerun with --verbose or ACCLIMATE_DEBUG=1 for the stack trace.');
    process.stderr.write(lines.join('\n') + '\n');
  } else {
    process.stderr.write(
      JSON.stringify({
        schemaVersion: 1,
        command,
        error: publicDiagnostic,
        ...(verbose
          ? {
              stack: [...new Set([error, ...causes])]
                .filter((item): item is Error => item instanceof Error && !!item.stack)
                .map((item) => item.stack),
            }
          : {}),
      }) + '\n',
    );
  }
  return exitCodeFor(diagnostic);
}

async function runCommand(
  argv: readonly string[],
  execute: (parsed: Parsed) => Promise<{ status: number; result: unknown }>,
  cwd = process.cwd(),
): Promise<number> {
  let command: Command | 'invalid' = 'invalid';
  try {
    if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
      process.stdout.write(sdkVersion() + '\n');
      return EXIT_CODES.ok;
    }
    const parsed = parseEvaluatorArguments(argv, cwd);
    command = parsed.command;
    const { status, result } = await execute(parsed);
    const output =
      typeof result === 'string'
        ? result
        : JSON.stringify(result);
    if (Buffer.byteLength(output) > 4 * 1024 * 1024)
      throw new EvaluationError('transport.response_too_large');
    process.stdout.write(output + '\n');
    return status;
  } catch (error) {
    return reportEvaluatorError(error, argv, command);
  }
}
