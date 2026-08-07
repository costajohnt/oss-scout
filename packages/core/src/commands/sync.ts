/**
 * Sync command — reconcile tracked open PRs against their current GitHub state
 * (#164). Records merges/closures, prunes resolved entries, and recomputes repo
 * scores. Cheaper than a full bootstrap; meant for periodic / daily runs.
 */

import { withScout } from "./with-scout.js";
import type { ScoutState } from "../core/schemas.js";
import type { SyncResult } from "../core/types.js";

export async function runSync(options?: {
  state?: ScoutState;
}): Promise<SyncResult> {
  // syncOpenPRs checkpoints itself, but in the CLI's non-gist mode the scout
  // is built with `persistence: "provided"`, where checkpoint() is a no-op —
  // only withScout's persist epilogue writes ~/.oss-scout/state.json. Without
  // it, sync reported success while discarding every update (#275).
  return withScout(options?.state, (scout) => scout.syncOpenPRs(), {
    persist: true,
  });
}
