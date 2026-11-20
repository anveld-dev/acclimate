/**
 * Shared base for every error the SDK throws on purpose.
 *
 * Catch `AcclimateError` to handle any SDK failure, then narrow on `code`.
 * Each subclass narrows `code` to its own string union.
 */
export class AcclimateError<C extends string = string> extends Error {
  readonly code: C;
  constructor(code: C, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AcclimateError';
    this.code = code;
  }
}

export type UsageErrorCode = 'usage.invalid_argument';

/**
 * The caller passed an invalid argument to an SDK function or constructor.
 * This is a bug in the calling code, never a service outage.
 */
export class AcclimateUsageError extends AcclimateError<UsageErrorCode> {
  /** The argument or option that was invalid, for example `baseUrl`. */
  readonly field?: string;
  constructor(message: string, field?: string) {
    super('usage.invalid_argument', message);
    this.name = 'AcclimateUsageError';
    if (field) this.field = field;
  }
}

export type TransportErrorCode = 'transport.unreachable' | 'transport.timeout';

/**
 * The SDK could not reach the Acclimate service, or the connection failed
 * before a complete HTTP response arrived. Only this error means "outage".
 */
export class TransportError extends AcclimateError<TransportErrorCode> {
  /** Service origin the SDK tried to reach. */
  readonly serviceUrl: string;
  constructor(serviceUrl: string, cause: unknown) {
    const timeout =
      cause instanceof DOMException && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    super(
      timeout ? 'transport.timeout' : 'transport.unreachable',
      (timeout
        ? `Timed out waiting for the Acclimate service at ${serviceUrl}.`
        : `Could not reach the Acclimate service at ${serviceUrl}.`) +
        ' Check that the service is running and reachable from this machine.',
      { cause },
    );
    this.name = 'TransportError';
    this.serviceUrl = serviceUrl;
  }
}
