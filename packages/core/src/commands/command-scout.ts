/**
 * Shared scout construction for CLI commands.
 *
 * Picks the persistence mode from `state.preferences.persistence` so the
 * `gist` preference is actually honored (#115). Previously every command
 * hardcoded `provided` mode, leaving gist sync unreachable no matter what
 * `oss-scout config set persistence gist` wrote.
 */
import type { ScoutState } from "../core/schemas.js";
import { createScout, type OssScout } from "../scout.js";
import { warn } from "../core/logger.js";

/**
 * Build a scout for a CLI command from already-loaded local state and a token.
 *
 * - `persistence: "gist"` preference → gist-backed scout. createScout loads
 *   local state itself and merges it with the gist, and `checkpoint()` pushes
 *   to the gist. The caller still calls `saveLocalState` to keep the local
 *   file fresh as an offline cache.
 * - otherwise → provided-state scout backed by the local file. The command's
 *   `saveLocalState` + `checkpoint()` persist locally.
 *
 * Gist mode requires a token: unauthenticated gist bootstrap 401s and that
 * error propagates by design, which crashed local-only commands (results
 * clear, skip ops) for gist-preference users running without a token (#304).
 * With no token, degrade to provided mode — changes land in the local file
 * and the bootstrap-time merge syncs them to the gist on the next
 * authenticated command (tombstones included, so deletions propagate too).
 */
export async function buildCommandScout(
  state: ScoutState,
  token: string,
): Promise<OssScout> {
  if (state.preferences.persistence === "gist") {
    if (token) {
      return createScout({ githubToken: token, persistence: "gist" });
    }
    warn(
      "command-scout",
      "No GitHub token available — changes will be saved locally and synced to the gist on the next authenticated command.",
    );
  }
  return createScout({
    githubToken: token,
    persistence: "provided",
    initialState: state,
  });
}
