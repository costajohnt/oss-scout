/**
 * Shared validation patterns and helpers for CLI commands.
 */

import { ValidationError } from '../core/errors.js';

export const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/\d+$/;

const MAX_URL_LENGTH = 2048;

export function validateGitHubUrl(url: string, pattern: RegExp, entityType: 'issue'): void {
  if (pattern.test(url)) return;
  throw new ValidationError(
    `Invalid ${entityType} URL: ${url}. Expected format: https://github.com/owner/repo/issues/123`,
  );
}

export function validateUrl(url: string): string {
  if (url.length > MAX_URL_LENGTH) {
    throw new ValidationError(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }
  return url;
}
