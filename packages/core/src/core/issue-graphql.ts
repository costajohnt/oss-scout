/**
 * Batched GraphQL prefetch of issue "core" data (#169).
 *
 * `vetIssue` re-fetches each issue's basic fields (title, body, state, labels,
 * timestamps, comment count) via a per-issue REST `issues.get`. When a search
 * surfaces N issues that all need vetting, that is N separate REST calls before
 * any of the deeper checks even start.
 *
 * `prefetchIssueCores` collapses those N calls into ONE aliased GraphQL query.
 * The result is a map keyed by `owner/repo#number`; `vetIssue` consumes a hit
 * instead of calling `issues.get`, and falls back to REST for any miss (a
 * deleted issue, a permission error on one repo, or a non-fatal GraphQL blip).
 *
 * Scope is deliberately limited to the `issues.get` fields. The other vetting
 * calls (timeline-based PR detection, claim scanning, project health,
 * contribution guidelines) stay REST — batching those has pagination-semantics
 * divergence risk and is left as a follow-up.
 */

import type { Octokit } from "@octokit/rest";
import { rethrowIfFatal, errorMessage } from "./errors.js";
import { warn } from "./logger.js";
import { getHttpCache } from "./http-cache.js";
import { mergedPRsCacheKey } from "./issue-eligibility.js";

const MODULE = "issue-graphql";

/**
 * Normalized issue fields equivalent to the subset of a REST `issues.get`
 * response that `vetIssue` reads. Produced from either GraphQL (prefetch) or
 * REST (fallback) so the two paths are interchangeable.
 */
export interface PrefetchedIssueCore {
  /** GitHub numeric database id (REST `id` / GraphQL `databaseId`). */
  id: number;
  title: string;
  /** Empty string when the issue has no body (matches REST `body || ""`). */
  body: string;
  state: "open" | "closed";
  /** Label names, in declared order. */
  labels: string[];
  /** Total comment count (REST `comments` / GraphQL `comments.totalCount`). */
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A single issue to prefetch. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** Map key for a prefetched core, also used by callers to look one up. */
export function issueCoreKey(
  owner: string,
  repo: string,
  number: number,
): string {
  return `${owner}/${repo}#${number}`;
}

interface GraphQLIssueNode {
  databaseId: number | null;
  title: string;
  body: string | null;
  state: "OPEN" | "CLOSED";
  labels: { nodes: { name: string }[] };
  comments: { totalCount: number };
  createdAt: string;
  updatedAt: string;
}

/** Shape of the aliased batch response: `{ i0: { issue }, i1: { issue }, ... }`. */
type BatchResponse = Record<string, { issue: GraphQLIssueNode | null } | null>;

function normalizeNode(node: GraphQLIssueNode): PrefetchedIssueCore {
  return {
    id: node.databaseId as number,
    title: node.title,
    body: node.body ?? "",
    state: node.state === "CLOSED" ? "closed" : "open",
    labels: node.labels.nodes.map((l) => l.name),
    commentCount: node.comments.totalCount,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

/**
 * Batch-fetch issue core data with one aliased GraphQL query. Returns a map of
 * `owner/repo#number` to the normalized core. Issues that the query could not
 * resolve are simply absent — the caller is expected to fall back to REST for
 * any key not in the map.
 *
 * Failure handling mirrors the rest of the vetter: fatal errors (401 / rate
 * limit) propagate via `rethrowIfFatal`; a partial-data GraphQL error (one bad
 * issue in the batch) keeps the aliases that did resolve; any other non-fatal
 * error returns whatever resolved so the caller degrades to all-REST.
 */
export async function prefetchIssueCores(
  octokit: Octokit,
  issues: IssueRef[],
): Promise<Map<string, PrefetchedIssueCore>> {
  const result = new Map<string, PrefetchedIssueCore>();
  if (issues.length === 0) return result;

  // Dedup by key so a repeated issue does not allocate a redundant alias.
  const unique = [
    ...new Map(
      issues.map((i) => [issueCoreKey(i.owner, i.repo, i.number), i]),
    ).values(),
  ];

  // Build a parameterized query — owner/repo/number go through GraphQL
  // variables, never string-interpolated into the query body, so there is no
  // injection surface even though parseGitHubUrl already validates them.
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string | number> = {};
  unique.forEach((iss, i) => {
    varDefs.push(`$o${i}: String!, $n${i}: String!, $num${i}: Int!`);
    variables[`o${i}`] = iss.owner;
    variables[`n${i}`] = iss.repo;
    variables[`num${i}`] = iss.number;
    selections.push(
      `i${i}: repository(owner: $o${i}, name: $n${i}) {
        issue(number: $num${i}) {
          databaseId
          title
          body
          state
          labels(first: 100) { nodes { name } }
          comments { totalCount }
          createdAt
          updatedAt
        }
      }`,
    );
  });
  const query = `query batchIssueCores(${varDefs.join(", ")}) {\n${selections.join("\n")}\n}`;

  let data: BatchResponse | undefined;
  try {
    data = await octokit.graphql<BatchResponse>(query, variables);
  } catch (err) {
    rethrowIfFatal(err);
    // octokit's GraphqlResponseError attaches the resolved aliases to `.data`
    // when only some issues in the batch errored (e.g. one was deleted).
    const partial = (err as { data?: BatchResponse }).data;
    if (partial) {
      data = partial;
    } else {
      warn(
        MODULE,
        `GraphQL prefetch failed, falling back to REST: ${errorMessage(err)}`,
      );
      return result;
    }
  }

  unique.forEach((iss, i) => {
    const node = data?.[`i${i}`]?.issue;
    // A null node (deleted/inaccessible) or a null databaseId leaves the key
    // absent so the caller fetches it via REST.
    if (!node || node.databaseId == null) return;
    result.set(
      issueCoreKey(iss.owner, iss.repo, iss.number),
      normalizeNode(node),
    );
  });

  return result;
}

// ---------------------------------------------------------------------------
// Batched merged-PR counts (#182)
// ---------------------------------------------------------------------------

/**
 * Strict validation for the owner/repo/username segments that go into a
 * GraphQL `search` query string. GitHub allows `[A-Za-z0-9_.-]` in these
 * segments. Even though the query strings are passed as GraphQL *variables*
 * (never interpolated into the query document), a malformed segment would
 * still corrupt the `is:pr is:merged author:… repo:…/…` filter, so anything
 * failing this is dropped and left to the REST fallback (which validates via
 * the GitHub API itself).
 */
const GH_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A repo whose merged-PR count should be prefetched. */
export interface MergedPRRepoRef {
  owner: string;
  repo: string;
}

/**
 * Repos per GraphQL merged-PR batch. A `search` connection with `first: 1`
 * (we only read `issueCount`) is cheap — a handful of aliased searches
 * empirically cost ~1 GraphQL point total — so this stays well under the
 * GraphQL complexity limit while collapsing many REST Search calls into one.
 */
const MERGED_PR_BATCH_SIZE = 15;

/**
 * Shape of the aliased search response plus the `viewer` identity probe:
 * `{ viewer: { login }, r0: { issueCount }, r1: … }`.
 */
interface MergedPRBatchResponse {
  viewer?: { login: string } | null;
  [alias: string]:
    | { issueCount: number }
    | { login: string }
    | null
    | undefined;
}

/**
 * Batch-fetch how many merged PRs `username` has authored in each repo via
 * aliased GraphQL `search` connections, writing each result into the HTTP
 * cache under the SAME key `checkUserMergedPRsInRepo` reads (`mergedPRsCacheKey`).
 *
 * This replaces scout's dominant REST Search-API consumer: the per-repo
 * `search.issuesAndPullRequests` call. A GraphQL `search` connection bills the
 * GraphQL points bucket (5000/hr), NOT the REST Search bucket (30/min), so
 * these calls are deliberately NOT recorded against the SearchBudgetTracker.
 *
 * Fallback semantics mirror {@link prefetchIssueCores}: fatal errors (401 /
 * rate limit) propagate via `rethrowIfFatal`; a partial-data GraphQL error
 * keeps the aliases that resolved; any repo not written to the cache simply
 * falls back to the existing REST path in `checkUserMergedPRsInRepo`.
 *
 * No-ops when `username` is empty or invalid — the GraphQL `author:` filter
 * needs a concrete login, and the REST path already handles that case with
 * `author:@me`.
 *
 * Identity safety: the prefetch searches `author:${username}` while the REST
 * fallback (`checkUserMergedPRsInRepo`) searches `author:@me` (the token's real
 * identity). If `getGitHubUsername()` is stale or misconfigured, a successful
 * `author:${username}` search would otherwise cache a count for the WRONG
 * account and suppress the authoritative `@me` query for the cache TTL. To
 * prevent that, each batch also selects `viewer { login }` in the same
 * round-trip and only warms the cache when it equals `username`; on any
 * mismatch the cache is left cold and the REST `@me` path answers.
 */
export async function prefetchMergedPRCounts(
  octokit: Octokit,
  username: string,
  repos: MergedPRRepoRef[],
): Promise<void> {
  if (repos.length === 0) return;
  if (!GH_NAME_PATTERN.test(username)) {
    warn(
      MODULE,
      `Skipping merged-PR prefetch: username failed validation (falling back to REST)`,
    );
    return;
  }

  // Dedup by owner/repo and drop anything failing strict validation.
  const seen = new Set<string>();
  const valid: MergedPRRepoRef[] = [];
  for (const r of repos) {
    const full = `${r.owner}/${r.repo}`;
    if (seen.has(full)) continue;
    seen.add(full);
    if (!GH_NAME_PATTERN.test(r.owner) || !GH_NAME_PATTERN.test(r.repo)) {
      warn(
        MODULE,
        `Skipping merged-PR prefetch for "${full}": failed validation (falling back to REST)`,
      );
      continue;
    }
    valid.push(r);
  }
  if (valid.length === 0) return;

  const cache = getHttpCache();
  const batches: Promise<void>[] = [];
  for (let i = 0; i < valid.length; i += MERGED_PR_BATCH_SIZE) {
    batches.push(
      fetchMergedPRBatch(
        octokit,
        username,
        valid.slice(i, i + MERGED_PR_BATCH_SIZE),
        cache,
      ),
    );
  }
  await Promise.all(batches);
}

/** Fetch one batch of merged-PR counts and write resolved ones to the cache. */
async function fetchMergedPRBatch(
  octokit: Octokit,
  username: string,
  repos: MergedPRRepoRef[],
  cache: ReturnType<typeof getHttpCache>,
): Promise<void> {
  const varDefs: string[] = [];
  // `viewer { login }` folds an identity check into the same round-trip (see
  // the fn doc): we only trust prefetched counts when the authenticated login
  // matches `username`.
  const selections: string[] = ["viewer { login }"];
  const variables: Record<string, string> = {};
  repos.forEach((r, i) => {
    varDefs.push(`$q${i}: String!`);
    // The query text is a GraphQL variable — user data never touches the query
    // document. Segments are already validated against GH_NAME_PATTERN.
    variables[`q${i}`] =
      `is:pr is:merged author:${username} repo:${r.owner}/${r.repo}`;
    selections.push(
      `r${i}: search(query: $q${i}, type: ISSUE, first: 1) { issueCount }`,
    );
  });
  const query = `query batchMergedPRCounts(${varDefs.join(", ")}) {\n${selections.join("\n")}\n}`;

  let data: MergedPRBatchResponse | undefined;
  try {
    data = await octokit.graphql<MergedPRBatchResponse>(query, variables);
  } catch (err) {
    rethrowIfFatal(err);
    // octokit attaches resolved aliases to `.data` when only some searches
    // errored; keep those and let the rest fall back to REST.
    const partial = (err as { data?: MergedPRBatchResponse }).data;
    if (partial) {
      data = partial;
    } else {
      warn(
        MODULE,
        `Merged-PR prefetch batch failed, falling back to REST: ${errorMessage(err)}`,
      );
      return;
    }
  }

  // Identity gate: only warm the cache when the authenticated user (whom the
  // REST `@me` fallback would query) is the same login we searched. On a
  // mismatch or an unreadable viewer, cache nothing so the authoritative REST
  // path answers instead of serving a wrong-account count.
  const viewerLogin = data?.viewer?.login;
  if (!viewerLogin || viewerLogin.toLowerCase() !== username.toLowerCase()) {
    if (viewerLogin) {
      warn(
        MODULE,
        `Merged-PR prefetch identity mismatch (configured username != authenticated login); leaving cache cold so REST @me answers`,
      );
    }
    return;
  }

  repos.forEach((r, i) => {
    const alias = data?.[`r${i}`];
    const count = alias && "issueCount" in alias ? alias.issueCount : undefined;
    // A missing alias (partial error) leaves the cache cold so the per-call
    // REST path fetches it. Only cache concrete numeric counts.
    if (typeof count !== "number") return;
    cache.set(mergedPRsCacheKey(r.owner, r.repo), "", count);
  });
}
