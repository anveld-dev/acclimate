import type { DeliveryReceiptRequest } from '../../sdk/src/types.js';
import { nativeSource } from '../../sdk/src/native-files.js';
import type { NativeInput } from '../../sdk/src/native-files.js';
import {
  createSkillLookup,
  extractBundleSkills,
  renderBundlePrompt,
  selectApprovedMemory,
  type BundleSkill,
  type SkillLookup,
  type SkillSummary,
} from '../../sdk/src/skills.js';
import { telemetryAttributes } from '../../sdk/src/telemetry.js';

export interface PrepareOpenAiAgentsOptions {
  /**
   * Include skill files inline in the rendered instructions. Defaults to `true`.
   * Set to `false` when registering `skillToolDefinitions` on the Agent.
   */
  includeSkillsInPrompt?: boolean;
  /** Restrict memory files included in the rendered instructions and `memoryFiles`. */
  approvedMemoryPaths?: readonly string[];
  /** Automatically call `cleanup()` when `agent_end` / `hooks.onAgentEnd` runs. Defaults to `false`. */
  cleanupOnEnd?: boolean;
}

export interface OpenAiAgentsToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string | string[]; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  execute(args: TArgs): Promise<TResult>;
}

/** Structural lifecycle hooks for custom runners or wrappers. */
export interface OpenAiAgentsHooks {
  onAgentStart(context?: unknown, agent?: unknown): Promise<void>;
  onAgentEnd(context?: unknown, agent?: unknown, output?: unknown): Promise<void>;
}

/** Structural EventEmitter interface matching `@openai/agents` `Agent` and `Runner`. */
export interface OpenAiAgentsEventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface PreparedOpenAiAgentsVersion {
  versionId: string;
  digest: string;
  /** Rendered prompt string for static `Agent({ instructions })`. */
  systemPrompt: string;
  /**
   * Dynamic instructions function for `new Agent({ instructions: prepared.instructions })`.
   * Records `reportStarted()` on invocation and returns `systemPrompt`.
   */
  instructions: (runContext?: unknown, agent?: unknown) => string;
  /** Structured skills parsed from the bundle. */
  skills: readonly BundleSkill[];
  /** Approved memory files from the bundle. */
  memoryFiles: Array<{ path: string; text: string }>;
  /** String-valued metadata map for `new Runner({ traceMetadata: prepared.traceMetadata })`. */
  traceMetadata: Record<string, string>;
  /**
   * Attach `agent_start` (and optional `agent_end` cleanup) listeners to an
   * `@openai/agents` `Agent` or `Runner` EventEmitter. Returns a detach function.
   */
  attach(emitter: OpenAiAgentsEventEmitter): () => void;
  /** Async lifecycle hook callbacks for wrappers that invoke hooks directly. */
  hooks: OpenAiAgentsHooks;
  /**
   * Progressive-disclosure skill tool definitions compatible with OpenAI strict
   * structured outputs (all properties listed in `required`, optional fields nullable).
   */
  skillToolDefinitions: {
    listSkills: OpenAiAgentsToolDefinition<Record<string, never>, SkillSummary[]>;
    readSkill: OpenAiAgentsToolDefinition<{ name: string; filePath: string | null }, string>;
  };
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Release the underlying delivery if one was provided. */
  cleanup(): Promise<void>;
}

/**
 * Prepare a verified Acclimate bundle for the OpenAI Agents SDK (`@openai/agents`).
 */
export function prepare(
  input: NativeInput,
  options: PrepareOpenAiAgentsOptions = {},
): PreparedOpenAiAgentsVersion {
  const { version: verified, reportStarted, release } = nativeSource(input);
  const systemPrompt = renderBundlePrompt(verified.payload, {
    includeSkills: options.includeSkillsInPrompt ?? true,
    approvedMemoryPaths: options.approvedMemoryPaths,
  });
  const memoryFiles = selectApprovedMemory(verified.payload, options.approvedMemoryPaths);
  const skills = Object.freeze(extractBundleSkills(verified.payload));
  let cachedLookup: SkillLookup | undefined;
  const getLookup = () => (cachedLookup ??= createSkillLookup(verified.payload));
  const rawTelemetry = telemetryAttributes(verified);
  const traceMetadata: Record<string, string> = Object.fromEntries(
    Object.entries(rawTelemetry).map(([key, value]) => [key, String(value)]),
  );
  const cleanupOnEnd = options.cleanupOnEnd ?? false;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    await release();
    cleaned = true;
  };

  return {
    versionId: verified.version.id,
    digest: verified.version.digest,
    systemPrompt,
    instructions() {
      reportStarted();
      return systemPrompt;
    },
    skills,
    memoryFiles,
    traceMetadata,
    attach(emitter: OpenAiAgentsEventEmitter) {
      const onStart = () => {
        reportStarted();
      };
      const onEnd = () => {
        if (cleanupOnEnd) {
          void cleanup().catch(() => {});
        }
      };
      emitter.on('agent_start', onStart);
      if (cleanupOnEnd) emitter.on('agent_end', onEnd);
      return () => {
        emitter.off?.('agent_start', onStart);
        if (cleanupOnEnd) emitter.off?.('agent_end', onEnd);
      };
    },
    hooks: {
      async onAgentStart() {
        reportStarted();
      },
      async onAgentEnd() {
        if (cleanupOnEnd) await cleanup();
      },
    },
    skillToolDefinitions: {
      listSkills: {
        name: 'list_acclimate_skills',
        description: 'List available Acclimate bundle skills with their names, descriptions, and supporting files.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        async execute() {
          return getLookup().listSkills();
        },
      },
      readSkill: {
        name: 'read_acclimate_skill',
        description: 'Read a skill manifest (SKILL.md) or a supporting file from a named Acclimate bundle skill.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name from list_acclimate_skills.' },
            filePath: {
              type: ['string', 'null'],
              description: 'Relative supporting file path inside the skill folder, or null for SKILL.md.',
            },
          },
          required: ['name', 'filePath'],
          additionalProperties: false,
        },
        async execute({ name, filePath }) {
          return getLookup().readSkill(name, filePath ?? undefined);
        },
      },
    },
    reportStarted,
    cleanup,
  };
}
