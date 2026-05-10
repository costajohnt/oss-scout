/**
 * Roadmap scraping (#95) — fetches a repo's ROADMAP.md (or variant) and
 * extracts referenced GitHub issue numbers. Used by feature-discovery to
 * apply an `onRoadmap` bonus when the maintainer has publicly committed
 * to an issue in their roadmap doc.
 *
 * Cached for 1 hour per repo. 404s are cached as empty sets so repos
 * without a roadmap don't get re-probed every run.
 *
 * Auth (401) and rate-limit errors propagate, matching the rest of the
 * codebase's error strategy. Other errors degrade gracefully (warn + empty).
 */

import type { Octokit } from "@octokit/rest";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";

const MODULE = "roadmap";

/** TTL for roadmap fetch results (1 hour). */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Paths probed in priority order. First success wins. */
const ROADMAP_PATHS = [
  "ROADMAP.md",
  "docs/ROADMAP.md",
  ".github/ROADMAP.md",
  "Roadmap.md",
  "roadmap.md",
] as const;

interface CacheEntry {
  refs: Set<number>;
  fetchedAt: number;
}

const roadmapCache = new Map<string, CacheEntry>();

/** Drop expired entries. Called from each fetch. */
function pruneCache(): void {
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const [key, value] of roadmapCache.entries()) {
    if (value.fetchedAt < cutoff) roadmapCache.delete(key);
  }
}

/**
 * Parse markdown content for issue number references.
 *
 * Extracts:
 *   - bare `#NNN` references that are not at start-of-line (those are headings)
 *   - `https://github.com/<owner>/<repo>/issues/NNN` URLs that match the
 *     repo we're parsing for (URLs to other repos are ignored)
 *
 * The match for in-repo URLs is intentional: scattered references to
 * unrelated repos in a roadmap shouldn't bump scores in those repos.
 */
export function parseRoadmapIssueRefs(
  content: string,
  owner: string,
  repo: string,
): Set<number> {
  const refs = new Set<number>();

  // Bare `#N` references, scanned line-by-line so we can skip markdown
  // headings (`# title`, `## section`) — those aren't issue refs.
  for (const line of content.split("\n")) {
    if (/^\s*#+\s/.test(line)) continue;
    for (const m of line.matchAll(/(?:^|[^&\w])#(\d+)\b/g)) {
      const n = Number.parseInt(m[1], 10);
      if (n > 0) refs.add(n);
    }
  }

  // Full GitHub issue URLs scoped to this repo.
  const ownerRepo = `${owner}/${repo}`.toLowerCase();
  const urlPattern =
    /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi;
  for (const m of content.matchAll(urlPattern)) {
    if (m[1].toLowerCase() === ownerRepo) {
      const n = Number.parseInt(m[2], 10);
      if (n > 0) refs.add(n);
    }
  }

  return refs;
}

/**
 * Fetch and parse the repo's ROADMAP.md, returning the set of referenced
 * issue numbers. Returns an empty set if no roadmap is found.
 *
 * Probes ROADMAP_PATHS sequentially until a 200 response is received.
 * Auth/rate-limit errors propagate; other errors are logged and degrade
 * to an empty set.
 */
export async function fetchRoadmapIssueRefs(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Set<number>> {
  const cacheKey = `${owner}/${repo}`.toLowerCase();
  const cached = roadmapCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.refs;
  }

  for (const path of ROADMAP_PATHS) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path });
      if (!("content" in data)) continue;
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      const refs = parseRoadmapIssueRefs(content, owner, repo);
      roadmapCache.set(cacheKey, { refs, fetchedAt: Date.now() });
      pruneCache();
      return refs;
    } catch (err: unknown) {
      if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
      const status = getHttpStatusCode(err);
      if (status === 404) continue; // path missing — try next
      warn(
        MODULE,
        `Unexpected error fetching ${path} from ${owner}/${repo}: ${errorMessage(err)}`,
      );
      // Fall through and try next path.
    }
  }

  // No roadmap found (or all probes errored softly). Cache the empty result
  // so we don't re-probe every run.
  const empty = new Set<number>();
  roadmapCache.set(cacheKey, { refs: empty, fetchedAt: Date.now() });
  pruneCache();
  return empty;
}

/** Test-only: clear the in-memory cache. */
export function _clearRoadmapCacheForTests(): void {
  roadmapCache.clear();
}
