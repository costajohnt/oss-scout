/**
 * Local state persistence — reads/writes ScoutState to ~/.oss-scout/state.json.
 */

import * as fs from "fs";
import * as path from "path";
import { ScoutStateSchema, parseScoutState } from "./schemas.js";
import type { ScoutState } from "./schemas.js";
import { getDataDir } from "./utils.js";
import { debug, warn } from "./logger.js";
import { errorMessage } from "./errors.js";

const MODULE = "local-state";

function getStatePath(): string {
  return path.join(getDataDir(), "state.json");
}

/**
 * Check if a local state file exists.
 */
export function hasLocalState(): boolean {
  return fs.existsSync(getStatePath());
}

/**
 * Load state from local file. Returns fresh default state if file doesn't exist or is corrupt.
 */
export function loadLocalState(): ScoutState {
  const statePath = getStatePath();
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    return parseScoutState(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return ScoutStateSchema.parse({ version: 1 });
    }
    // State file exists but is corrupt or unreadable
    warn(
      MODULE,
      `Failed to load state from ${statePath}: ${errorMessage(err)}. Using defaults.`,
    );
    // Backup corrupt file
    try {
      const backupPath = `${statePath}.corrupt.${Date.now()}`;
      fs.copyFileSync(statePath, backupPath);
      warn(MODULE, `Corrupt state backed up to ${backupPath}`);
    } catch (backupErr) {
      warn(
        MODULE,
        `Failed to back up corrupt state: ${errorMessage(backupErr)}`,
      );
    }
    return ScoutStateSchema.parse({ version: 1 });
  }
}

/** Monotonic counter so two saves in one process never share a tmp path. */
let tmpCounter = 0;

/**
 * Save state to local file using atomic write (write to a unique tmp file,
 * then rename). A fixed ".tmp" path let two concurrent processes interleave
 * write/rename and crash one of them with ENOENT. The load-mutate-save cycle
 * is still last-writer-wins (no lock), but each save is now atomic and
 * crash-free on its own.
 */
export function saveLocalState(state: Readonly<ScoutState>): void {
  writeFileAtomic(getStatePath(), JSON.stringify(state, null, 2) + "\n");
  debug(MODULE, "State saved");
}

/** Write via a unique tmp file + rename so a crash never leaves a truncated file. */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${tmpCounter++}`;
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Do not leave an orphan tmp file behind on a failed rename
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // already gone
    }
    throw err;
  }
}
