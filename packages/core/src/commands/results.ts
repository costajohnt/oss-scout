/**
 * Results command — display and manage saved search results.
 */

import { loadLocalState, saveLocalState } from "../core/local-state.js";
import type { SavedCandidate } from "../core/schemas.js";
import { ValidationError } from "../core/errors.js";

export interface ResultsOptions {
  json?: boolean;
  /** Only results first seen at/after this ISO date (or any Date-parseable string). */
  since?: string;
  /** Only results first seen during/after the most recent search run. */
  newOnly?: boolean;
}

/**
 * Return saved results, optionally narrowed to "new" ones. `--since` takes an
 * explicit cutoff; `--new-only` uses the last search timestamp so a scheduler
 * can run `search` then `results --new-only` to see just that run's fresh
 * finds (#170). Both compare against each result's `firstSeenAt`.
 */
export async function runResults(
  options: ResultsOptions = {},
): Promise<SavedCandidate[]> {
  const state = loadLocalState();
  const results = state.savedResults ?? [];

  let cutoff: number | undefined;
  if (options.since !== undefined) {
    const parsed = Date.parse(options.since);
    if (Number.isNaN(parsed)) {
      throw new ValidationError(
        `Invalid --since date: "${options.since}". Use an ISO date like 2026-06-01.`,
      );
    }
    cutoff = parsed;
  } else if (options.newOnly) {
    // No prior search recorded → everything counts as new.
    const parsed = state.lastSearchAt ? Date.parse(state.lastSearchAt) : NaN;
    cutoff = Number.isNaN(parsed) ? undefined : parsed;
  }

  if (cutoff === undefined) return results;
  const threshold = cutoff;
  return results.filter((r) => {
    const seen = Date.parse(r.firstSeenAt);
    return !Number.isNaN(seen) && seen >= threshold;
  });
}

export async function runResultsClear(): Promise<void> {
  const state = loadLocalState();
  state.savedResults = [];
  saveLocalState(state);
}
