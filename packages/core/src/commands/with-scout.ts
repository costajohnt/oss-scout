/**
 * Shared command scaffolding (#154).
 *
 * Every command repeated the same prologue (require token, load state, build
 * the scout) and most repeated the same epilogue (write local state, gist
 * checkpoint, warn on gist failure). The warning text was byte-identical in
 * three files and inconsistently omitted in skip.ts. `withScout` owns the
 * prologue plus an optional persist epilogue; `persistScout` is the epilogue
 * on its own for commands that persist only on some code paths.
 */

import { buildCommandScout } from "./command-scout.js";
import { requireGitHubToken, getGitHubToken } from "../core/utils.js";
import { loadLocalState, saveLocalState } from "../core/local-state.js";
import type { OssScout } from "../scout.js";
import type { ScoutState } from "../core/schemas.js";

const GIST_SYNC_WARNING =
  "Warning: changes saved locally but gist sync failed.";

/**
 * Write the scout's state to disk and push the gist checkpoint, warning to
 * stderr if the gist push failed (local save still succeeded).
 */
export async function persistScout(scout: OssScout): Promise<void> {
  saveLocalState(scout.getState() as ScoutState);
  const persisted = await scout.checkpoint();
  if (!persisted) {
    console.error(GIST_SYNC_WARNING);
  }
}

export interface WithScoutOptions {
  /** Persist via persistScout after fn resolves. Default false. */
  persist?: boolean;
  /**
   * Require a GitHub token (throws if absent). Default true. Skip-list
   * operations are local-only and pass false so they work without auth.
   */
  requireToken?: boolean;
}

/**
 * Build a scout for the given (or loaded) state, run fn against it, and
 * optionally persist afterward. Centralizes the create/persist/warn boilerplate
 * shared by the search, vet, vet-list, features, and skip commands.
 */
export async function withScout<T>(
  state: ScoutState | undefined,
  fn: (scout: OssScout) => Promise<T> | T,
  options: WithScoutOptions = {},
): Promise<T> {
  const { persist = false, requireToken = true } = options;
  const token = requireToken ? requireGitHubToken() : (getGitHubToken() ?? "");
  const resolvedState = state ?? loadLocalState();
  const scout = await buildCommandScout(resolvedState, token);

  const result = await fn(scout);

  if (persist) {
    await persistScout(scout);
  }

  return result;
}
