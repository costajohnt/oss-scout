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

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function debug(module: string, message: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [DEBUG] [${module}] ${message}`, ...args);
}

export function info(module: string, message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [INFO] [${module}] ${message}`, ...args);
}

export function warn(module: string, message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [WARN] [${module}] ${message}`, ...args);
}

export async function timed<T>(module: string, label: string, fn: () => Promise<T>): Promise<T> {
  if (!debugEnabled) return fn();
  const start = performance.now();
  try {
    const result = await fn();
    const duration = (performance.now() - start).toFixed(0);
    debug(module, `${label} completed in ${duration}ms`);
    return result;
  } catch (err) {
    const duration = (performance.now() - start).toFixed(0);
    debug(module, `${label} failed after ${duration}ms`);
    throw err;
  }
}
