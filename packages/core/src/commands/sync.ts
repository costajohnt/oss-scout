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
  // syncOpenPRs checkpoints itself, so withScout doesn't need to persist.
  return withScout(options?.state, (scout) => scout.syncOpenPRs());
}
