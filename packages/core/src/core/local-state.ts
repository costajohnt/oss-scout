/**
 * Local state persistence — reads/writes ScoutState to ~/.oss-scout/state.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ScoutStateSchema } from './schemas.js';
import type { ScoutState } from './schemas.js';
import { getDataDir } from './utils.js';
import { debug } from './logger.js';

const MODULE = 'local-state';

function getStatePath(): string {
  return path.join(getDataDir(), 'state.json');
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

  if (!fs.existsSync(statePath)) {
    debug(MODULE, 'No state file found, returning fresh state');
    return ScoutStateSchema.parse({ version: 1 });
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return ScoutStateSchema.parse(parsed);
  } catch (err) {
    debug(MODULE, `Failed to load state: ${err instanceof Error ? err.message : String(err)}`);
    return ScoutStateSchema.parse({ version: 1 });
  }
}

/**
 * Save state to local file using atomic write (write to .tmp, then rename).
 */
export function saveLocalState(state: ScoutState): void {
  const statePath = getStatePath();
  const tmpPath = statePath + '.tmp';

  const data = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });
  fs.renameSync(tmpPath, statePath);
  debug(MODULE, 'State saved');
}
