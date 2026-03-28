/**
 * Lightweight debug logger for oss-scout.
 * Activated by the global --debug CLI flag.
 *
 * All debug/warn output goes to stderr so it never contaminates
 * the --json stdout contract.
 */

let debugEnabled = false;

export function enableDebug(): void {
  debugEnabled = true;
}

export function debug(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [DEBUG] [${module}] ${message}`, ...args);
}

export function info(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [INFO] [${module}] ${message}`, ...args);
}

export function warn(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [WARN] [${module}] ${message}`, ...args);
}
