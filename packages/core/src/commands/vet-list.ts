import { buildCommandScout } from "./command-scout.js";
import { requireGitHubToken } from "../core/utils.js";
import { loadLocalState, saveLocalState } from "../core/local-state.js";
import type { ScoutState } from "../core/schemas.js";
import type { VetListResult } from "../core/types.js";

interface VetListCommandOptions {
  concurrency?: number;
  prune?: boolean;
  state?: ScoutState;
}

export async function runVetList(
  options: VetListCommandOptions,
): Promise<VetListResult> {
  const token = requireGitHubToken();
  const state = options.state ?? loadLocalState();
  const scout = await buildCommandScout(state, token);

  const result = await scout.vetList({
    concurrency: options.concurrency,
    prune: options.prune,
  });

  saveLocalState(scout.getState() as ScoutState);
  const persisted = await scout.checkpoint();
  if (!persisted) {
    console.error("Warning: changes saved locally but gist sync failed.");
  }
  return result;
}
