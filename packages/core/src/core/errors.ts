/**
 * Custom error type hierarchy for oss-scout.
 *
 * Error strategy:
 * - Auth errors (401) and rate limit errors (429, 403+rate-limit): ALWAYS propagate
 * - Network errors (ENOTFOUND, ECONNREFUSED, ETIMEDOUT): propagate with context
 * - Validation errors: propagate
 * - Cache/filesystem errors: degrade gracefully with warn logging
 * - API data errors (unexpected shapes): degrade gracefully with warn logging
 */

export class OssScoutError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "OssScoutError";
  }
}

export class ConfigurationError extends OssScoutError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
}

export class ValidationError extends OssScoutError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function getHttpStatusCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" && Number.isFinite(status)
      ? status
      : undefined;
  }
  return undefined;
}

export function isRateLimitError(error: unknown): boolean {
  const status = getHttpStatusCode(error);
  if (status === 429) return true;
  if (status === 403) {
    const msg = errorMessage(error).toLowerCase();
    // "rate limit" also covers GitHub's "secondary rate limit" wording;
    // abuse-detection 403s carry neither substring but are the same
    // back-off-and-retry condition, so they must propagate too (#138).
    return msg.includes("rate limit") || msg.includes("abuse detection");
  }
  return false;
}

/**
 * Re-throw an error if it is one that must always propagate: a 401 (auth) or
 * any rate-limit condition (429, 403 + rate-limit/abuse). Otherwise return so
 * the caller can degrade gracefully. Centralizes the guard that was
 * copy-pasted across ~16 catch blocks (#154).
 *
 * Note: catch sites that deliberately treat a rate limit as degradable use a
 * bare `getHttpStatusCode(err) === 401` check instead and must NOT call this.
 */
export function rethrowIfFatal(error: unknown): void {
  if (getHttpStatusCode(error) === 401 || isRateLimitError(error)) {
    throw error;
  }
}

/** Error codes for JSON output. */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "CONFIGURATION"
  | "NETWORK"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "STATE_CORRUPTED"
  | "UNKNOWN"
  | "VALIDATION";

/**
 * Map an unknown error to a structured ErrorCode for JSON output.
 */
export function resolveErrorCode(err: unknown): ErrorCode {
  if (err instanceof ConfigurationError) return "CONFIGURATION";
  if (err instanceof ValidationError) return "VALIDATION";

  const status = getHttpStatusCode(err);
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) {
    // Single source of truth for the 403 rate-limit/abuse classification
    return isRateLimitError(err) ? "RATE_LIMITED" : "AUTH_REQUIRED";
  }
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";

  const msg = errorMessage(err).toLowerCase();
  if (
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed")
  )
    return "NETWORK";

  return "UNKNOWN";
}
