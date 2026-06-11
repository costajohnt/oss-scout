import { withScout } from "./with-scout.js";
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
  return withScout(
    options.state,
    (scout) =>
      scout.vetList({
        concurrency: options.concurrency,
        prune: options.prune,
      }),
    { persist: true },
  );
}
