/**
 * Lightweight leveled logger for oss-scout.
 *
 * All output goes to stderr so it never contaminates the --json stdout
 * contract. The CLI raises the level to "debug" via the global --debug flag;
 * library hosts that don't want oss-scout's "[INFO] Phase 0..." chatter can
 * lower it with setLogLevel (or ScoutConfig.logLevel) — including to "silent"
 * (#156).
 */

export type LogLevel = "silent" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Default "info" preserves the historical behavior: info + warn emit, debug is
// suppressed until --debug (enableDebug) or setLogLevel raises the level.
let currentLevel: LogLevel = "info";

/** Set the minimum level that will be emitted. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Current minimum emitted level. */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Raise the level to "debug" (used by the CLI --debug flag). */
export function enableDebug(): void {
  currentLevel = "debug";
}

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_RANK[currentLevel] >= LEVEL_RANK[level];
}

export function debug(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  if (!shouldLog("debug")) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [DEBUG] [${module}] ${message}`, ...args);
}

export function info(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  if (!shouldLog("info")) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [INFO] [${module}] ${message}`, ...args);
}

export function warn(
  module: string,
  message: string,
  ...args: unknown[]
): void {
  if (!shouldLog("warn")) return;
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] [WARN] [${module}] ${message}`, ...args);
}
