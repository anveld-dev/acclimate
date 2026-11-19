export { AcclimateClient, ApiError } from './client.js';
export type { ClientOptions, ChannelOptions, ChannelResult } from './client.js';
export { resolveAndCache, validatePayload, DeliveryError } from './cache.js';
export { verifyPayloadBytes } from './verification.js';
export type { Selection, CachePolicy, OfflinePolicy } from './cache.js';
export { prepareFiles, defaultCacheDir } from './prepare.js';
export type {
  PrepareOptions,
  PreparedFiles,
  PreparedFile,
  PrepareDeliveryOptions,
  PreparedDelivery,
} from './prepare.js';
export * from './types.js';
export { createReceiptReporter } from './reporting.js';
export type { ReceiptReporterOptions, DeliveryObservation, DeliveryObserver } from './reporting.js';
export { compare, submitComparison, TaskExecutionError, InfrastructureError } from './compare.js';
export type {
  ComparisonVersion,
  ComparisonCase,
  ExecutionResult,
  GradeResult,
  CompareOptions,
} from './compare.js';

export { compatibilityIssues, assertCompatible } from './compatibility.js';
export type { CompatibilityIssue } from './compatibility.js';
