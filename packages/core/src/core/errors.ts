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
    return msg.includes("rate limit");
  }
  return false;
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
    const msg = errorMessage(err).toLowerCase();
    if (msg.includes("rate limit") || msg.includes("abuse detection"))
      return "RATE_LIMITED";
    return "AUTH_REQUIRED";
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
