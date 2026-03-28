/**
 * JSON output formatter for oss-scout CLI.
 */

import type { ErrorCode } from "../core/errors.js";

interface JsonOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: ErrorCode;
  timestamp: string;
}

export function formatJsonSuccess<T>(data: T): string {
  const output: JsonOutput<T> = {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(output, null, 2);
}

export function formatJsonError(error: string, errorCode?: ErrorCode): string {
  const output: JsonOutput = {
    success: false,
    error,
    errorCode,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(output, null, 2);
}
