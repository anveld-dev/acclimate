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
} from '../../sdk/src/skills.js';
import { telemetryAttributes, type AcclimateTelemetryAttributes } from '../../sdk/src/telemetry.js';

export interface PrepareLangChainOptions {
  /**
   * Include skill files inline in `systemPrompt`. Defaults to `true`.
   * Set to `false` when registering `skillTools` on your LangGraph agent.
   */
  includeSkillsInPrompt?: boolean;
  /** Restrict memory files included in `systemPrompt` and `memoryFiles`. */
  approvedMemoryPaths?: readonly string[];
}

/** Structural callback handler compatible with `@langchain/core/callbacks/base`. */
export interface AcclimateLangChainCallbackHandler {
  readonly name: 'acclimate_delivery_callback';
  handleChainStart(): Promise<void>;
  handleLLMStart(): Promise<void>;
  handleChatModelStart(): Promise<void>;
}

/** Minimal structural type for a LangChain `CallbackManager`. */
interface CallbackManagerLike {
  copy(additionalHandlers?: unknown[], inheritHandlers?: boolean): CallbackManagerLike;
  addHandler?(handler: unknown, inherit?: boolean): void;
}

function isCallbackManager(value: unknown): value is CallbackManagerLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<CallbackManagerLike>).copy === 'function'
  );
}

export interface LangChainRunnableConfig {
  metadata?: Record<string, unknown>;
  tags?: string[];
  callbacks?: unknown[] | CallbackManagerLike;
  [key: string]: unknown;
}

export interface LangChainSkillToolSpec<TArgs, TResult> {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, { type: string | string[]; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  func(args: TArgs): Promise<TResult>;
}

export interface PreparedLangChainVersion {
  versionId: string;
  digest: string;
  /** Rendered system prompt string. */
  systemPrompt: string;
  /** Message object ready to prepend to LangGraph state messages (`{ role: 'system', content }`). */
  systemMessage: { role: 'system'; content: string };
  /** Structured skills parsed from the bundle. */
  skills: readonly BundleSkill[];
  /** Approved memory files from the bundle. */
  memoryFiles: Array<{ path: string; text: string }>;
  /** Flat metadata for `RunnableConfig.metadata` / LangSmith traces. */
  metadata: AcclimateTelemetryAttributes;
  /** Standard tags (`acclimate`, `acclimate:version:<id>`, and optional channel tag). */
  tags: string[];
  /** Callback handler that fires `reportStarted()` when a chain, LLM, or chat model run begins. */
  callbackHandler: AcclimateLangChainCallbackHandler;
  /** Merge Acclimate metadata, tags, and `callbackHandler` into a LangChain/LangGraph `RunnableConfig`. */
  runnableConfig<T extends LangChainRunnableConfig = LangChainRunnableConfig>(base?: T): T & {
    metadata: Record<string, unknown>;
    tags: string[];
    callbacks: unknown[] | CallbackManagerLike;
  };
  /** Progressive-disclosure skill tool specs ready for `tool()` / `DynamicStructuredTool`. */
  skillTools: {
    listSkills: LangChainSkillToolSpec<Record<string, never>, string>;
    readSkill: LangChainSkillToolSpec<{ name: string; filePath?: string | null }, string>;
  };
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Release the underlying delivery if one was provided. */
  cleanup(): Promise<void>;
}

/**
 * Prepare a verified Acclimate bundle for LangChain.js and LangGraph.js.
 */
export function prepare(
  input: NativeInput,
  options: PrepareLangChainOptions = {},
): PreparedLangChainVersion {
  const { version: verified, reportStarted, release } = nativeSource(input);
  const systemPrompt = renderBundlePrompt(verified.payload, {
    includeSkills: options.includeSkillsInPrompt ?? true,
    approvedMemoryPaths: options.approvedMemoryPaths,
  });
  const memoryFiles = selectApprovedMemory(verified.payload, options.approvedMemoryPaths);
  const skills = Object.freeze(extractBundleSkills(verified.payload));
  let cachedLookup: SkillLookup | undefined;
  const getLookup = () => (cachedLookup ??= createSkillLookup(verified.payload));
  const metadata = telemetryAttributes(verified);
  const tags = [
    'acclimate',
    `acclimate:bundle:${verified.version.bundleId}`,
    `acclimate:version:${verified.version.id}`,
    ...(verified.resolution ? [`acclimate:channel:${verified.resolution.channel}`] : []),
  ];
  let cleaned = false;

  const callbackHandler: AcclimateLangChainCallbackHandler = {
    name: 'acclimate_delivery_callback',
    async handleChainStart() {
      reportStarted();
    },
    async handleLLMStart() {
      reportStarted();
    },
    async handleChatModelStart() {
      reportStarted();
    },
  };

  return {
    versionId: verified.version.id,
    digest: verified.version.digest,
    systemPrompt,
    systemMessage: { role: 'system', content: systemPrompt },
    skills,
    memoryFiles,
    metadata,
    tags,
    callbackHandler,
    runnableConfig<T extends LangChainRunnableConfig = LangChainRunnableConfig>(base?: T) {
      const existingTags = Array.isArray(base?.tags) ? base.tags : [];
      let mergedCallbacks: unknown[] | CallbackManagerLike;
      if (isCallbackManager(base?.callbacks)) {
        const copied = base.callbacks.copy([callbackHandler]);
        if (copied === base.callbacks && typeof copied.addHandler === 'function') {
          copied.addHandler(callbackHandler);
        }
        mergedCallbacks = copied;
      } else {
        const existingCallbacks = Array.isArray(base?.callbacks) ? base.callbacks : [];
        mergedCallbacks = [...existingCallbacks, callbackHandler];
      }
      return {
        ...(base ?? ({} as T)),
        metadata: { ...metadata, ...(base?.metadata ?? {}) },
        tags: [...new Set([...existingTags, ...tags])],
        callbacks: mergedCallbacks,
      };
    },
    skillTools: {
      listSkills: {
        name: 'list_acclimate_skills',
        description: 'List available Acclimate bundle skills with their names, descriptions, and supporting files.',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        async func() {
          return JSON.stringify(getLookup().listSkills());
        },
      },
      readSkill: {
        name: 'read_acclimate_skill',
        description: 'Read a skill manifest (SKILL.md) or a supporting file from a named Acclimate bundle skill.',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name from list_acclimate_skills.' },
            filePath: {
              type: ['string', 'null'],
              description: 'Optional relative supporting file path inside the skill folder; defaults to SKILL.md.',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
        async func({ name, filePath }) {
          return getLookup().readSkill(name, filePath ?? undefined);
        },
      },
    },
    reportStarted,
    async cleanup() {
      if (cleaned) return;
      await release();
      cleaned = true;
    },
  };
}
