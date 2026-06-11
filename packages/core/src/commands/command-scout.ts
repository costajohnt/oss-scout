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

/**
 * Build a scout for a CLI command from already-loaded local state and a token.
 *
 * - `persistence: "gist"` preference → gist-backed scout. createScout loads
 *   local state itself and merges it with the gist, and `checkpoint()` pushes
 *   to the gist. The caller still calls `saveLocalState` to keep the local
 *   file fresh as an offline cache.
 * - otherwise → provided-state scout backed by the local file. The command's
 *   `saveLocalState` + `checkpoint()` persist locally.
 */
export async function buildCommandScout(
  state: ScoutState,
  token: string,
): Promise<OssScout> {
  if (state.preferences.persistence === "gist") {
    return createScout({ githubToken: token, persistence: "gist" });
  }
  return createScout({
    githubToken: token,
    persistence: "provided",
    initialState: state,
  });
}
