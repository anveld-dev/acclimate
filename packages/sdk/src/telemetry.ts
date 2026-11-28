import type { NativeInput } from './native-files.js';
import { nativeSource } from './native-files.js';

export interface AcclimateTelemetryAttributes {
  'acclimate.bundle_id': string;
  'acclimate.version_id': string;
  'acclimate.digest': string;
  'acclimate.stale': boolean;
  'acclimate.channel'?: string;
  'acclimate.revision'?: string;
}

/**
 * Build OpenTelemetry-compatible attributes describing the verified Acclimate
 * version delivered to a job. Attach these to spans or framework trace metadata
 * to correlate agent outcomes with bundle versions.
 */
export function telemetryAttributes(input: NativeInput): AcclimateTelemetryAttributes {
  const { version } = nativeSource(input);
  const attrs: AcclimateTelemetryAttributes = {
    'acclimate.bundle_id': version.version.bundleId,
    'acclimate.version_id': version.version.id,
    'acclimate.digest': version.version.digest,
    'acclimate.stale': version.stale,
  };
  if (version.resolution) {
    attrs['acclimate.channel'] = version.resolution.channel;
    attrs['acclimate.revision'] = version.resolution.revision;
  }
  return attrs;
}

/**
 * Flat string/boolean metadata record suitable for Vercel AI SDK
 * `experimental_telemetry.metadata`, LangSmith `RunnableConfig.metadata`, or
 * OpenAI Agents `traceMetadata`.
 */
export function telemetryMetadata(input: NativeInput): Record<string, string | boolean> {
  return { ...telemetryAttributes(input) };
}
