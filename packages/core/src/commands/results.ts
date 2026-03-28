/**
 * Results command — display and manage saved search results.
 */

import { loadLocalState, saveLocalState } from '../core/local-state.js';
import type { SavedCandidate } from '../core/schemas.js';

export async function runResults(_options: { json?: boolean }): Promise<SavedCandidate[]> {
  const state = loadLocalState();
  return state.savedResults ?? [];
}

export async function runResultsClear(): Promise<void> {
  const state = loadLocalState();
  state.savedResults = [];
  saveLocalState(state);
}
