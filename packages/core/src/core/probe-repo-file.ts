/**
 * Single-path repo-file probe (#156).
 *
 * Three modules (repo-health, roadmap, anti-llm-policy) independently fetch a
 * repo doc by trying a list of candidate paths and stopping at the first hit.
 * The per-path fetch was copy-pasted three times, each re-deriving the same
 * 404-continue / fatal-propagate / base64-decode logic. This is the one
 * genuinely-shared primitive.
 *
 * The orchestration around it stays per-caller (parallel 4-path probe,
 * sequential 5-path probe, sequential family probe) and so do the return shapes
 * (parsed guidelines, issue-ref set, policy scan). Only the single GET is
 * shared.
 *
 * The `transient` flag is load-bearing: it distinguishes a clean miss (404 —
 * file absent) from a degraded miss (5xx, network) so callers can decide
 * whether to cache a negative result or leave it open to retry. Collapsing the
 * two would bypass anti-llm-policy's transient-failure cache safeguard, so the
 * primitive must keep them separate.
 */

import type { Octokit } from "@octokit/rest";
import { errorMessage, getHttpStatusCode, rethrowIfFatal } from "./errors.js";
import { warn } from "./logger.js";
import { getHttpCache, cachedRequest } from "./http-cache.js";

const MODULE = "probe-repo-file";

/**
 * Result of probing one repo file path.
 *
 * - `text` — decoded UTF-8 content on a 200 with a file payload, else `null`
 *   (404, a non-content payload such as a directory listing, or a soft error).
 * - `transient` — `true` only when the miss was a degraded failure (5xx,
 *   network) rather than a clean 404 / missing file. A `true` value means the
 *   `null` may be incomplete and the caller should avoid caching it as a known
 *   absence.
 */
export interface ProbeRepoFileResult {
  text: string | null;
  transient: boolean;
}

/**
 * GET one repo file path. Returns decoded content on a 200 file payload, a
 * clean `null` on 404 or a non-content payload, and a transient `null` on a
 * soft error (5xx, network) after logging it. Rethrows fatal errors (401 auth,
 * rate limit) so the caller's existing rate-limit handling sees them.
 *
 * Callers that need 401/rate-limit to surface across a *parallel* batch (where
 * a faster path may have already resolved) must inspect the rejected reasons
 * themselves; this primitive only rethrows for the single path it owns. See
 * repo-health and anti-llm-policy for that pre-scan.
 *
 * Successful (200) responses are ETag-cached: a later probe of the same path
 * revalidates with `If-None-Match`, so an unchanged doc comes back as a 304
 * that costs zero primary rate-limit quota. Only 200 bodies are cached here —
 * 404s (file absent) still surface as rejections that this function's own catch
 * maps to a clean `null`, exactly as before, and the per-caller negative caches
 * (guidelines/roadmap Maps, anti-llm time cache) continue to handle absences.
 */
export async function probeRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<ProbeRepoFileResult> {
  try {
    // ETag-revalidate the content GET. cachedRequest only intercepts 304
    // (returning the cached body); a 404 or fatal error propagates untouched to
    // the catch below, preserving the "file absent" semantics callers depend on.
    const data = await cachedRequest<unknown>(
      getHttpCache(),
      `/repos/${owner}/${repo}/contents/${path}`,
      (headers) =>
        octokit.repos.getContent({ owner, repo, path, headers }) as Promise<{
          data: unknown;
          headers: Record<string, string>;
        }>,
    );
    if (
      data &&
      typeof data === "object" &&
      "content" in data &&
      typeof (data as { content: unknown }).content === "string"
    ) {
      return {
        text: Buffer.from(
          (data as { content: string }).content,
          "base64",
        ).toString("utf-8"),
        transient: false,
      };
    }
    return { text: null, transient: false };
  } catch (error) {
    const status = getHttpStatusCode(error);
    if (status === 404) return { text: null, transient: false };
    rethrowIfFatal(error);
    warn(
      MODULE,
      `Unexpected error fetching ${path} from ${owner}/${repo}: ${errorMessage(error)}`,
    );
    return { text: null, transient: true };
  }
}
