import { createScout } from '../scout.js';
import { requireGitHubToken } from '../core/utils.js';
import { saveLocalState } from '../core/local-state.js';
import type { ScoutState } from '../core/schemas.js';
import type { VetListResult } from '../core/types.js';

interface VetListCommandOptions {
  concurrency?: number;
  prune?: boolean;
  state?: ScoutState;
}

export async function runVetList(options: VetListCommandOptions): Promise<VetListResult> {
  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({ githubToken: token, persistence: 'provided', initialState: options.state })
    : await createScout({ githubToken: token });

  const result = await scout.vetList({
    concurrency: options.concurrency,
    prune: options.prune,
  });

  saveLocalState(scout.getState() as ScoutState);
  await scout.checkpoint();
  return result;
}
