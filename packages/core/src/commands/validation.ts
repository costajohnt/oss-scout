/**
 * Shared validation patterns and helpers for CLI commands.
 */

import { ValidationError } from "../core/errors.js";

export const ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/;

const MAX_URL_LENGTH = 2048;

export function validateGitHubUrl(
  url: string,
  pattern: RegExp,
  entityType: "issue",
): void {
  if (pattern.test(url)) return;
  throw new ValidationError(
    `Invalid ${entityType} URL: ${url}. Expected format: https://github.com/owner/repo/issues/123`,
  );
}

/**
 * Parse a strictly-decimal integer CLI argument. Bare parseInt accepts
 * trailing garbage ("50O" → 50), silently running with a different value
 * than the user typed (#291).
 */
export function parseStrictInt(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationError(`${label} must be an integer (got "${value}")`);
  }
  return parseInt(trimmed, 10);
}

export function validateUrl(url: string): string {
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(
      `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
    );
  }
  return url;
}
