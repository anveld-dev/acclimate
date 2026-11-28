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
import { telemetryAttributes, type AcclimateTelemetryAttributes } from '../../sdk/src/telemetry.js';

export interface PrepareAiSdkOptions {
  /**
   * Include skill files inline in `system`. Defaults to `true` (matching the
   * learning loop). Set to `false` when passing `createSkillTools(jsonSchema)`
   * for progressive skill disclosure.
   */
  includeSkillsInPrompt?: boolean;
  /**
   * Restrict memory files included in `system` and `memoryFiles`. When omitted,
   * all memory files are included. Pass `[]` to omit all memory.
   */
  approvedMemoryPaths?: readonly string[];
}

export interface AiSdkJsonSchema {
  type: 'object';
  properties: Record<string, { type: string | string[]; description: string }>;
  required?: string[];
  additionalProperties: false;
}

export interface AiSdkSkillTool<TArgs, TResult, TSchema = AiSdkJsonSchema> {
  description: string;
  inputSchema: TSchema;
  execute(args: TArgs): Promise<TResult>;
}

/**
 * Minimal structural type matching Vercel AI SDK `LanguageModelV3Middleware`
 * (`specificationVersion: 'v3'` + `transformParams`).
 */
export interface AcclimateAiSdkMiddleware {
  readonly specificationVersion: 'v3';
  transformParams: <TParams extends { prompt: Array<{ role: string; content: unknown }> }>(options: {
    type: 'generate' | 'stream';
    params: TParams;
  }) => Promise<TParams>;
}

export interface PreparedAiSdkVersion {
  versionId: string;
  digest: string;
  /** Rendered system prompt for `generateText({ system })`, `streamText({ system })`, or `ToolLoopAgent`. */
  system: string;
  /** Instruction-only text, joined by blank lines. */
  instructions: string;
  /** Structured skills parsed from the bundle. */
  skills: readonly BundleSkill[];
  /** Approved memory files from the bundle. */
  memoryFiles: Array<{ path: string; text: string }>;
  /** Spread into `experimental_telemetry` to tag OTel spans with the pinned bundle version. */
  telemetry: { metadata: AcclimateTelemetryAttributes };
  /**
   * Middleware for `wrapLanguageModel({ model, middleware: prepared.middleware })`.
   * Injects or merges the bundle system prompt and records `reportStarted()` on model call.
   */
  middleware: AcclimateAiSdkMiddleware;
  /**
   * Raw progressive-disclosure skill tool definitions. Wrap `inputSchema` with
   * `jsonSchema()` from `'ai'` (or call `createSkillTools(jsonSchema)`) before
   * passing to `generateText({ tools })`.
   */
  skillTools: {
    list_acclimate_skills: AiSdkSkillTool<Record<string, never>, SkillSummary[]>;
    read_acclimate_skill: AiSdkSkillTool<{ name: string; filePath?: string | null }, string>;
  };
  /**
   * Build Vercel AI SDK-ready tool objects by wrapping each tool's raw JSON
   * Schema with `jsonSchema` imported from `'ai'`.
   */
  createSkillTools<TSchema>(wrapSchema: (schema: AiSdkJsonSchema) => TSchema): {
    list_acclimate_skills: AiSdkSkillTool<Record<string, never>, SkillSummary[], TSchema>;
    read_acclimate_skill: AiSdkSkillTool<{ name: string; filePath?: string | null }, string, TSchema>;
  };
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Release the underlying delivery if one was provided. */
  cleanup(): Promise<void>;
}

/**
 * Prepare a verified Acclimate bundle for Vercel AI SDK (`generateText`,
 * `streamText`, `ToolLoopAgent`, or `wrapLanguageModel`).
 */
export function prepare(
  input: NativeInput,
  options: PrepareAiSdkOptions = {},
): PreparedAiSdkVersion {
  const { version: verified, reportStarted, release } = nativeSource(input);
  const system = renderBundlePrompt(verified.payload, {
    includeSkills: options.includeSkillsInPrompt ?? true,
    approvedMemoryPaths: options.approvedMemoryPaths,
  });
  const instructions = verified.payload.files
    .filter((file) => file.kind === 'instruction')
    .map((file) => file.text)
    .join('\n\n');
  const memoryFiles = selectApprovedMemory(verified.payload, options.approvedMemoryPaths);
  const skills = Object.freeze(extractBundleSkills(verified.payload));
  let cachedLookup: SkillLookup | undefined;
  const getLookup = () => (cachedLookup ??= createSkillLookup(verified.payload));
  const metadata = telemetryAttributes(verified);
  let cleaned = false;

  const middleware: AcclimateAiSdkMiddleware = {
    specificationVersion: 'v3',
    async transformParams({ params }) {
      reportStarted();
      if (!system) return params;
      const existing = params.prompt;
      const first = existing[0];
      if (first?.role === 'system' && typeof first.content === 'string') {
        if (first.content === system || first.content.startsWith(`${system}\n\n`)) {
          return params;
        }
        return {
          ...params,
          prompt: [{ ...first, content: `${system}\n\n${first.content}` }, ...existing.slice(1)],
        };
      }
      return {
        ...params,
        prompt: [{ role: 'system', content: system }, ...existing],
      };
    },
  };

  const listSchema: AiSdkJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  const readSchema: AiSdkJsonSchema = {
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
  };

  const listExecute = async () => getLookup().listSkills();
  const readExecute = async ({ name, filePath }: { name: string; filePath?: string | null }) =>
    getLookup().readSkill(name, filePath ?? undefined);

  const skillTools: PreparedAiSdkVersion['skillTools'] = {
    list_acclimate_skills: {
      description: 'List available Acclimate bundle skills with their names, descriptions, and supporting files.',
      inputSchema: listSchema,
      execute: listExecute,
    },
    read_acclimate_skill: {
      description: 'Read a skill manifest (SKILL.md) or a supporting file from a named Acclimate bundle skill.',
      inputSchema: readSchema,
      execute: readExecute,
    },
  };

  return {
    versionId: verified.version.id,
    digest: verified.version.digest,
    system,
    instructions,
    skills,
    memoryFiles,
    telemetry: { metadata },
    middleware,
    skillTools,
    createSkillTools<TSchema>(wrapSchema: (schema: AiSdkJsonSchema) => TSchema) {
      return {
        list_acclimate_skills: {
          description: skillTools.list_acclimate_skills.description,
          inputSchema: wrapSchema(listSchema),
          execute: listExecute,
        },
        read_acclimate_skill: {
          description: skillTools.read_acclimate_skill.description,
          inputSchema: wrapSchema(readSchema),
          execute: readExecute,
        },
      };
    },
    reportStarted,
    async cleanup() {
      if (cleaned) return;
      await release();
      cleaned = true;
    },
  };
}

/** Convenience wrapper returning only the Vercel AI SDK language-model middleware. */
export function createAcclimateMiddleware(
  input: NativeInput,
  options: PrepareAiSdkOptions = {},
): AcclimateAiSdkMiddleware {
  return prepare(input, options).middleware;
}
