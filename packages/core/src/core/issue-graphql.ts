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
