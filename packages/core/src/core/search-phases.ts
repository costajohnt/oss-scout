/**
 * Search Phases — utilities and infrastructure for multi-phase issue search.
 *
 * Extracted from issue-discovery.ts to isolate search helpers,
 * caching, spam-filtering, and batched repo search logic.
 */

import { Octokit } from "@octokit/rest";
import {
  type SearchPriority,
  type IssueCandidate,
  type IssueScope,
  SCOPE_LABELS,
} from "./types.js";
import { errorMessage, isRateLimitError } from "./errors.js";
import { debug, warn } from "./logger.js";
import { getHttpCache } from "./http-cache.js";
import {
  type GitHubSearchItem,
  detectLabelFarmingRepos,
} from "./issue-filtering.js";
import { IssueVetter } from "./issue-vetting.js";
import { extractRepoFromUrl, sleep } from "./utils.js";
import { getSearchBudgetTracker } from "./search-budget.js";

const MODULE = "search-phases";

/** GitHub Search API enforces a max of 5 AND/OR/NOT operators per query. */
const GITHUB_MAX_BOOLEAN_OPS = 5;

/** Delay between search API calls to avoid GitHub's secondary rate limit (~30 req/min).
 * Set to 2000ms as a safety floor (max 30/min at the limit). The SearchBudgetTracker
 * adds additional adaptive delays when needed. */
const INTER_QUERY_DELAY_MS = 2000;

/** Batch size for repo queries. 3 repos = 2 OR operators, leaving room for labels. */
const BATCH_SIZE = 3;

/**
 * Chunk labels into groups that fit within the operator budget.
 * N labels require N-1 OR operators, so maxPerChunk = budget + 1.
 *
 * @param labels      Full label list
 * @param reservedOps OR operators already consumed by repo/org filters
 */
function chunkLabels(labels: string[], reservedOps: number = 0): string[][] {
  const maxPerChunk = GITHUB_MAX_BOOLEAN_OPS - reservedOps + 1;
  if (maxPerChunk < 1) {
    if (labels.length > 0) {
      warn(
        MODULE,
        `Label filtering disabled: ${reservedOps} repo/org ORs exceed GitHub's ${GITHUB_MAX_BOOLEAN_OPS} operator limit. ` +
          `All ${labels.length} label(s) dropped from query.`,
      );
    }
    return [[]];
  }
  if (labels.length <= maxPerChunk) return [labels];

  const chunks: string[][] = [];
  for (let i = 0; i < labels.length; i += maxPerChunk) {
    chunks.push(labels.slice(i, i + maxPerChunk));
  }
  debug(
    MODULE,
    `Split ${labels.length} labels into ${chunks.length} chunks (${reservedOps} ops reserved, max ${maxPerChunk} per chunk)`,
  );
  return chunks;
}

// ── Pure utilities ──

/** Build a GitHub Search API label filter from a list of labels. */
function buildLabelQuery(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `label:"${labels[0]}"`;
  return `(${labels.map((l) => `label:"${l}"`).join(" OR ")})`;
}

/** Resolve scope tiers into a flat label list, merged with custom labels. */
export function buildEffectiveLabels(
  scopes: IssueScope[],
  customLabels: string[],
): string[] {
  const labels = new Set<string>();
  for (const scope of scopes) {
    for (const label of SCOPE_LABELS[scope] ?? []) labels.add(label);
  }
  for (const label of customLabels) labels.add(label);
  return [...labels];
}

/** Round-robin interleave multiple arrays. */
export function interleaveArrays<T>(arrays: T[][]): T[] {
  const result: T[] = [];
  const maxLen = Math.max(...arrays.map((a) => a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (i < arr.length) result.push(arr[i]);
    }
  }
  return result;
}

/** Split repos into batches of the specified size. */
function batchRepos(repos: string[], batchSize: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < repos.length; i += batchSize) {
    batches.push(repos.slice(i, i + batchSize));
  }
  return batches;
}

// ── Search caching ──

/** TTL for cached search API results (15 minutes). */
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Wrap octokit.search.issuesAndPullRequests with time-based caching.
 * Repeated identical queries within SEARCH_CACHE_TTL_MS return cached results
 * without consuming GitHub API rate limit points.
 */
export async function cachedSearchIssues(
  octokit: Octokit,
  params: {
    q: string;
    sort: "created" | "updated" | "comments" | "reactions" | "interactions";
    order: "asc" | "desc";
    per_page: number;
  },
): Promise<{ total_count: number; items: GitHubSearchItem[] }> {
  const cacheKey = `search:${params.q}:${params.sort}:${params.order}:${params.per_page}`;
  const cache = getHttpCache();

  // Check cache first
  const cached = cache.getIfFresh(cacheKey, SEARCH_CACHE_TTL_MS);
  if (cached) {
    debug(MODULE, `Search cache hit for query`);
    return cached as { total_count: number; items: GitHubSearchItem[] };
  }

  // Fetch from API
  const tracker = getSearchBudgetTracker();
  await tracker.waitForBudget();
  let data: { total_count: number; items: GitHubSearchItem[] };
  try {
    const response = await octokit.search.issuesAndPullRequests(params);
    data = response.data;
  } finally {
    tracker.recordCall();
  }

  // Only cache non-empty results to prevent poisoning from rate-limited responses
  if (data.items.length > 0) {
    cache.set(cacheKey, "", data);
  } else {
    debug(
      MODULE,
      `Skipping cache for empty search result (possible rate limit artifact)`,
    );
  }

  return data;
}

// ── REST-based search functions ──

/**
 * Fetch issues from maintained repos using REST API (no Search API quota).
 *
 * Checks each repo for recent push activity and star threshold,
 * then fetches open issues via `GET /repos/{owner}/{repo}/issues`.
 * Falls back to the caller to use Search API if this doesn't yield enough.
 */
export async function fetchIssuesFromMaintainedRepos(
  octokit: Octokit,
  repos: string[],
  minStars: number,
  maxResults: number,
): Promise<GitHubSearchItem[]> {
  const items: GitHubSearchItem[] = [];

  for (const repoFullName of repos) {
    if (items.length >= maxResults * 3) break;

    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) continue;

    try {
      const { data: repoData } = await octokit.repos.get({ owner, repo });

      const pushedAt = new Date(repoData.pushed_at);
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      if (pushedAt < thirtyDaysAgo) continue;
      if ((repoData.stargazers_count ?? 0) < minStars) continue;
      if (repoData.archived) continue;

      const { data: issues } = await octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "created",
        direction: "desc",
        per_page: 5,
      });

      const realIssues = issues.filter(
        (i: { pull_request?: unknown }) => !i.pull_request,
      );

      for (const issue of realIssues) {
        items.push({
          html_url: issue.html_url,
          repository_url: `https://api.github.com/repos/${repoFullName}`,
          updated_at: issue.updated_at ?? "",
          title: issue.title,
          labels: issue.labels as Array<{ name?: string } | string>,
        });
      }

      await sleep(INTER_QUERY_DELAY_MS);
    } catch (error) {
      debug(
        MODULE,
        `Error fetching issues from ${repoFullName}: ${errorMessage(error)}`,
      );
    }
  }

  return items;
}

// ── Search infrastructure ──

/**
 * Fetch open issues from known repos using REST API (no Search API quota).
 * Used by Phase 0 (merged-PR repos) and Phase 1 (starred repos).
 *
 * Instead of the Search API (`octokit.search.issuesAndPullRequests`), this
 * calls `GET /repos/{owner}/{repo}/issues` which counts against the much
 * larger Core API rate limit and avoids consuming the scarce Search quota.
 */
export async function fetchIssuesFromKnownRepos(
  octokit: Octokit,
  vetter: IssueVetter,
  repos: string[],
  labels: string[],
  maxResults: number,
  priority: SearchPriority,
  filterFn: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<{
  candidates: IssueCandidate[];
  allReposFailed: boolean;
  rateLimitHit: boolean;
}> {
  const candidates: IssueCandidate[] = [];
  let failedRepos = 0;
  let rateLimitFailures = 0;

  for (let i = 0; i < repos.length; i++) {
    if (candidates.length >= maxResults) break;

    // Delay between repos to avoid REST secondary rate limits
    if (i > 0) await sleep(INTER_QUERY_DELAY_MS);

    const repoFullName = repos[i];
    const [owner, repo] = repoFullName.split("/");

    try {
      const response = await octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "created",
        direction: "desc",
        per_page: 5,
        ...(labels.length > 0 ? { labels: labels.join(",") } : {}),
      });

      // Filter out pull requests (REST issues endpoint returns both) and assigned issues
      const issuesOnly = response.data.filter(
        (item) => !("pull_request" in item) && !item.assignee,
      );

      const mapped: GitHubSearchItem[] = issuesOnly.map((issue) => ({
        html_url: issue.html_url,
        repository_url: `https://api.github.com/repos/${repoFullName}`,
        updated_at: issue.updated_at ?? "",
        title: issue.title,
        labels: issue.labels as Array<{ name?: string } | string>,
      }));

      if (mapped.length > 0) {
        const filtered = filterFn(mapped);
        if (filtered.length > 0) {
          const remainingNeeded = maxResults - candidates.length;
          const { candidates: vetted, rateLimitHit: vetRateLimitHit } =
            await vetter.vetIssuesParallel(
              filtered
                .slice(0, remainingNeeded * 2)
                .map((item) => item.html_url),
              remainingNeeded,
              priority,
            );
          candidates.push(...vetted);
          if (vetRateLimitHit) rateLimitFailures++;
        }
      }
    } catch (error) {
      failedRepos++;
      if (isRateLimitError(error)) {
        rateLimitFailures++;
      }
      warn(
        MODULE,
        `Error fetching issues from ${repoFullName}:`,
        errorMessage(error),
      );
    }
  }

  const allReposFailed = failedRepos === repos.length && repos.length > 0;
  const rateLimitHit = rateLimitFailures > 0;
  if (allReposFailed) {
    warn(
      MODULE,
      `All ${repos.length} repo(s) failed for ${priority} phase. ` +
        `This may indicate a systemic issue (rate limit, auth, network).`,
    );
  }

  return { candidates, allReposFailed, rateLimitHit };
}

/**
 * Search across chunked labels with deduplication.
 *
 * Splits labels into chunks that fit within GitHub's boolean operator budget,
 * issues one search query per chunk, deduplicates results by URL, and returns
 * the merged item list.
 *
 * @param octokit      Authenticated Octokit instance
 * @param labels       Full label list to chunk
 * @param reservedOps  OR operators already consumed by repo/org filters in the query
 * @param buildQuery   Callback that receives a label query string and returns the full search query
 * @param perPage      Number of results per API call
 */
export async function searchWithChunkedLabels(
  octokit: Octokit,
  labels: string[],
  reservedOps: number,
  buildQuery: (labelQuery: string) => string,
  perPage: number,
): Promise<GitHubSearchItem[]> {
  const labelChunks = chunkLabels(labels, reservedOps);
  const seenUrls = new Set<string>();
  const allItems: GitHubSearchItem[] = [];

  for (let i = 0; i < labelChunks.length; i++) {
    if (i > 0) await sleep(INTER_QUERY_DELAY_MS);

    const query = buildQuery(buildLabelQuery(labelChunks[i]));
    const data = await cachedSearchIssues(octokit, {
      q: query,
      sort: "created",
      order: "desc",
      per_page: perPage,
    });

    for (const item of data.items) {
      if (!seenUrls.has(item.html_url)) {
        seenUrls.add(item.html_url);
        allItems.push(item);
      }
    }
  }

  return allItems;
}

/**
 * Shared pipeline: spam-filter, repo-exclusion, vetting, and star-count filter.
 * Used by Phases 2 and 3 to convert raw search results into vetted candidates.
 */
export async function filterVetAndScore(
  vetter: IssueVetter,
  items: GitHubSearchItem[],
  filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
  excludedRepoSets: Set<string>[],
  remainingNeeded: number,
  minStars: number,
  phaseLabel: string,
): Promise<{
  candidates: IssueCandidate[];
  allVetFailed: boolean;
  rateLimitHit: boolean;
}> {
  const spamRepos = detectLabelFarmingRepos(items);
  if (spamRepos.size > 0) {
    const spamCount = items.filter((i) =>
      spamRepos.has(extractRepoFromUrl(i.repository_url) ?? ""),
    ).length;
    debug(
      MODULE,
      `[SPAM_FILTER] Filtered ${spamCount} issues from ${spamRepos.size} label-farming repos: ${[...spamRepos].join(", ")}`,
    );
  }

  const itemsToVet = filterIssues(items)
    .filter((item) => {
      const repoFullName = extractRepoFromUrl(item.repository_url);
      if (!repoFullName) return false;
      if (spamRepos.has(repoFullName)) return false;
      return excludedRepoSets.every((s) => !s.has(repoFullName));
    })
    .slice(0, remainingNeeded * 2);

  if (itemsToVet.length === 0) {
    debug(
      MODULE,
      `[${phaseLabel}] All ${items.length} items filtered before vetting`,
    );
    return { candidates: [], allVetFailed: false, rateLimitHit: false };
  }

  const {
    candidates: results,
    allFailed: allVetFailed,
    rateLimitHit,
  } = await vetter.vetIssuesParallel(
    itemsToVet.map((i) => i.html_url),
    remainingNeeded,
    "normal",
  );

  const starFiltered = results.filter((c) => {
    if (c.projectHealth.checkFailed) return true;
    const stars = c.projectHealth.stargazersCount ?? 0;
    return stars >= minStars;
  });
  const starFilteredCount = results.length - starFiltered.length;
  if (starFilteredCount > 0) {
    debug(
      MODULE,
      `[STAR_FILTER] Filtered ${starFilteredCount} ${phaseLabel} candidates below ${minStars} stars`,
    );
  }

  return { candidates: starFiltered, allVetFailed, rateLimitHit };
}

/**
 * Search for issues within specific repos using batched queries.
 *
 * To avoid GitHub's secondary rate limit (30 requests/minute), we batch
 * multiple repos into a single search query using OR syntax:
 *   repo:owner1/repo1 OR repo:owner2/repo2 OR repo:owner3/repo3
 *
 * Labels are chunked separately to stay within GitHub's 5 boolean operator limit.
 * Each batch of repos consumes (batch.length - 1) OR operators, and the remaining
 * budget is used for label OR operators.
 *
 * This reduces API calls from N (one per repo) to ceil(N/BATCH_SIZE) * label_chunks.
 */
export async function searchInRepos(
  octokit: Octokit,
  vetter: IssueVetter,
  repos: string[],
  baseQualifiers: string,
  labels: string[],
  maxResults: number,
  priority: SearchPriority,
  filterFn: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<{
  candidates: IssueCandidate[];
  allBatchesFailed: boolean;
  rateLimitHit: boolean;
}> {
  const candidates: IssueCandidate[] = [];

  const batches = batchRepos(repos, BATCH_SIZE);
  let failedBatches = 0;
  let rateLimitFailures = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    if (candidates.length >= maxResults) break;

    // Delay between batches to avoid secondary rate limits
    if (batchIdx > 0) await sleep(INTER_QUERY_DELAY_MS);

    try {
      const repoFilter = batch.map((r) => `repo:${r}`).join(" OR ");
      const repoOps = batch.length - 1;
      const perPage = Math.min(30, (maxResults - candidates.length) * 3);

      const allItems = await searchWithChunkedLabels(
        octokit,
        labels,
        repoOps,
        (labelQ) =>
          `${baseQualifiers} ${labelQ} (${repoFilter})`
            .replace(/  +/g, " ")
            .trim(),
        perPage,
      );

      if (allItems.length > 0) {
        const filtered = filterFn(allItems);
        const remainingNeeded = maxResults - candidates.length;
        const { candidates: vetted, rateLimitHit: vetRateLimitHit } =
          await vetter.vetIssuesParallel(
            filtered.slice(0, remainingNeeded * 2).map((i) => i.html_url),
            remainingNeeded,
            priority,
          );
        candidates.push(...vetted);
        if (vetRateLimitHit) rateLimitFailures++;
      }
    } catch (error) {
      failedBatches++;
      if (isRateLimitError(error)) {
        rateLimitFailures++;
      }
      const batchReposStr = batch.join(", ");
      warn(
        MODULE,
        `Error searching issues in batch [${batchReposStr}]:`,
        errorMessage(error),
      );
    }
  }

  const allBatchesFailed =
    failedBatches === batches.length && batches.length > 0;
  const rateLimitHit = rateLimitFailures > 0;
  if (allBatchesFailed) {
    warn(
      MODULE,
      `All ${batches.length} batch(es) failed for ${priority} phase. ` +
        `This may indicate a systemic issue (rate limit, auth, network).`,
    );
  }

  return { candidates, allBatchesFailed, rateLimitHit };
}
