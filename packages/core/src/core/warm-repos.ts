/**
 * Warm-repo watch — list and rank the open issues of every repo the user has
 * a relationship with (merged or open PRs).
 *
 * Replaces the per-repo REST walk the merged phase used to do over a rotating
 * window of 10 repos. One aliased GraphQL query covers a batch of repos and
 * returns the fields needed to decide which issues deserve a vet (assignee,
 * open closing PR, author association, comment count), so every warm repo is
 * read on every run and the vet budget goes to the issues most likely to be
 * takeable instead of to whichever four happen to be newest.
 */

import type { Octokit } from "@octokit/rest";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";
import { applyPerRepoCap, type GitHubSearchItem } from "./issue-filtering.js";
import type { IssueVetter } from "./issue-vetting.js";
import type { IssueCandidate } from "./types.js";
import { sleep } from "./utils.js";

const MODULE = "warm-repos";

/**
 * Repos per query. A busy repo's 30 issues with labels can trip GitHub's
 * per-query resource limit and null out its batch neighbours; 8 keeps that
 * rare, and `listWarmRepoIssues` retries the casualties one at a time.
 */
const BATCH_SIZE = 8;

/** Newest open issues read per repo. */
const ISSUES_PER_REPO = 30;

/** Pause between batches; GraphQL bills the points bucket, so a light pace is enough. */
const INTER_BATCH_DELAY_MS = 500;

/** Same segment rule GitHub applies to owner and repo names. */
const GH_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Issues vetted per repo. One more than the search's final per-repo cap of 2,
 * so a single vetter reject does not cost the repo a result slot.
 */
const VET_PER_REPO = 3;

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** An unassigned open issue with no open closing PR, plus the ranking signals. */
export interface WarmIssue extends GitHubSearchItem {
  /** "owner/repo". */
  repo: string;
  createdAt: string;
  /** Filed by an OWNER, MEMBER or COLLABORATOR of the repo. */
  maintainerFiled: boolean;
  commentCount: number;
}

interface IssueNode {
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  authorAssociation: string;
  assignees: { totalCount: number };
  comments: { totalCount: number };
  labels: { nodes: { name: string }[] } | null;
  closedByPullRequestsReferences: { totalCount: number } | null;
}

interface RepoNode {
  isArchived: boolean;
  issues: { nodes: (IssueNode | null)[] | null } | null;
}

type BatchResponse = Record<string, RepoNode | null | undefined>;

/**
 * Query one batch. Returns whatever aliases resolved plus the aliases GitHub
 * reported as NOT_FOUND (deleted or renamed repos, which a retry cannot fix).
 * Throws when nothing resolved or the points bucket is exhausted.
 */
async function queryRepos(
  octokit: Octokit,
  repos: string[],
): Promise<{ data: BatchResponse; notFound: Set<string> }> {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string> = {};
  repos.forEach((fullName, i) => {
    const [owner, name] = fullName.split("/") as [string, string];
    varDefs.push(`$o${i}: String!, $n${i}: String!`);
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    selections.push(
      `r${i}: repository(owner: $o${i}, name: $n${i}) {
        isArchived
        issues(first: ${ISSUES_PER_REPO}, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            url
            title
            createdAt
            updatedAt
            authorAssociation
            assignees { totalCount }
            comments { totalCount }
            labels(first: 10) { nodes { name } }
            closedByPullRequestsReferences(first: 1, includeClosedPrs: false) { totalCount }
          }
        }
      }`,
    );
  });
  const query = `query warmRepoIssues(${varDefs.join(", ")}) {\n${selections.join("\n")}\n}`;

  try {
    return {
      data: await octokit.graphql<BatchResponse>(query, variables),
      notFound: new Set(),
    };
  } catch (err) {
    // octokit attaches the aliases that did resolve to `.data` when only part
    // of the batch errored.
    const partial = (err as { data?: BatchResponse | null }).data;
    if (!partial || isRateLimitError(err)) throw err;
    const gqlErrors =
      (err as { errors?: Array<{ type?: string; path?: unknown[] }> }).errors ??
      [];
    return {
      data: partial,
      notFound: new Set(
        gqlErrors
          .filter((e) => e.type === "NOT_FOUND")
          .map((e) => String(e.path?.[0])),
      ),
    };
  }
}

/** Takeable issues from one resolved repo node, or null when the node did not resolve. */
function takeableIssues(
  repo: string,
  node: RepoNode | null | undefined,
): WarmIssue[] | null {
  const nodes = node?.issues?.nodes;
  if (!node || !nodes) return null;
  if (node.isArchived) return [];
  return nodes.flatMap((n) => {
    if (!n) return [];
    if (n.assignees.totalCount > 0) return [];
    if ((n.closedByPullRequestsReferences?.totalCount ?? 0) > 0) return [];
    return [
      {
        html_url: n.url,
        repository_url: `https://api.github.com/repos/${repo}`,
        updated_at: n.updatedAt,
        title: n.title,
        labels: (n.labels?.nodes ?? []).map((l) => ({ name: l.name })),
        repo,
        createdAt: n.createdAt,
        maintainerFiled: MAINTAINER_ASSOCIATIONS.has(n.authorAssociation),
        commentCount: n.comments.totalCount,
      },
    ];
  });
}

/**
 * List the newest open issues of every repo in `repos` that nobody has taken:
 * unassigned and without an open PR that closes them. Archived repos yield
 * nothing.
 *
 * A 401 propagates. A rate limit stops the walk and returns what was read,
 * flagged, so the caller can report an incomplete search. Any other failure
 * costs only the repos involved.
 */
export async function listWarmRepoIssues(
  octokit: Octokit,
  repos: string[],
): Promise<{ items: WarmIssue[]; failedRepos: number; rateLimitHit: boolean }> {
  const valid = repos.filter((r) => {
    const parts = r.split("/");
    return parts.length === 2 && parts.every((p) => GH_NAME_PATTERN.test(p));
  });
  const items: WarmIssue[] = [];
  let failedRepos = repos.length - valid.length;
  let rateLimitHit = false;

  /** Read one batch; returns the repos worth retrying on their own. */
  const read = async (batch: string[]): Promise<string[]> => {
    try {
      const { data, notFound } = await queryRepos(octokit, batch);
      const retry: string[] = [];
      batch.forEach((repo, j) => {
        const found = takeableIssues(repo, data[`r${j}`]);
        if (found) items.push(...found);
        // A repo that did not resolve next to others most likely lost out to
        // the per-query resource limit; alone it fits.
        else if (batch.length > 1 && !notFound.has(`r${j}`)) retry.push(repo);
        else failedRepos++;
      });
      return retry;
    } catch (err) {
      if (getHttpStatusCode(err) === 401) throw err;
      if (isRateLimitError(err)) {
        warn(MODULE, `Rate limit hit listing warm repos: ${errorMessage(err)}`);
        rateLimitHit = true;
        return [];
      }
      warn(
        MODULE,
        `Failed to list issues for ${batch.join(", ")}: ${errorMessage(err)}`,
      );
      failedRepos += batch.length;
      return [];
    }
  };

  for (let i = 0; i < valid.length && !rateLimitHit; i += BATCH_SIZE) {
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);
    const retry = await read(valid.slice(i, i + BATCH_SIZE));
    for (const repo of retry) {
      if (rateLimitHit) break;
      await read([repo]);
    }
  }

  return { items, failedRepos, rateLimitHit };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Order warm issues by how likely they are to be worth a vet, best first.
 *
 * Weights follow the user-history pattern this phase exists to exploit: most
 * merged PRs were opened within two days of the issue being filed, on issues
 * nobody had commented on yet, and maintainer-filed issues arrive already
 * scoped. `repoScore` (1-10, null when the repo has no record) carries the
 * relationship: merges raise it, PRs closed without merge lower it.
 *
 * ponytail: hand-set additive weights. Fit them to merge outcomes once the
 * caller records which surfaced issues turned into merged PRs.
 */
export function rankWarmIssues(
  items: WarmIssue[],
  repoScore: (repo: string) => number | null,
  now: Date = new Date(),
): WarmIssue[] {
  const score = (issue: WarmIssue): number => {
    const ageDays = (now.getTime() - Date.parse(issue.createdAt)) / DAY_MS;
    const freshness = ageDays <= 2 ? 3 : ageDays <= 14 ? 2 : ageDays <= 30 ? 1 : 0;
    return (
      freshness +
      (issue.maintainerFiled ? 3 : 0) +
      (issue.commentCount === 0 ? 2 : 0) +
      (repoScore(issue.repo) ?? 5) / 2
    );
  };
  return items
    .map((issue) => ({ issue, score: score(issue) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.issue.createdAt) - Date.parse(a.issue.createdAt),
    )
    .map((entry) => entry.issue);
}

/**
 * List the untaken open issues of every warm repo, rank them on the listing
 * payload, and vet only the top of that ranking. Returns up to `maxResults`
 * candidates in rank order, viable ones first.
 */
export async function fetchWarmRepoCandidates(
  octokit: Octokit,
  vetter: IssueVetter,
  repos: string[],
  maxResults: number,
  filterFn: (items: GitHubSearchItem[]) => GitHubSearchItem[],
  repoScore: (repo: string) => number | null,
): Promise<{
  candidates: IssueCandidate[];
  allReposFailed: boolean;
  rateLimitHit: boolean;
}> {
  const listed = await listWarmRepoIssues(octokit, repos);
  const kept = new Set(filterFn(listed.items).map((i) => i.html_url));
  const ranked = rankWarmIssues(
    listed.items.filter((i) => kept.has(i.html_url)),
    repoScore,
  );
  // Over-fetch 2x for the vetter's rejects, spread across repos so one busy
  // repo cannot use the whole vet budget.
  const toVet = applyPerRepoCap(
    ranked.map((i) => ({ url: i.html_url, issue: { repo: i.repo } })),
    VET_PER_REPO,
  )
    .slice(0, maxResults * 2)
    .map((i) => i.url);

  let candidates: IssueCandidate[] = [];
  let rateLimitHit = listed.rateLimitHit;
  if (toVet.length > 0) {
    // Ask for every URL back: the vetter stops at its result cap whatever the
    // recommendation, so a smaller cap would let early skips crowd out viable
    // issues further down the ranking.
    const vetted = await vetter.vetIssuesParallel(
      toVet,
      toVet.length,
      "merged_pr",
    );
    rateLimitHit ||= vetted.rateLimitHit;
    // Vets finish in any order; restore the ranking, viable candidates first.
    const rank = new Map(toVet.map((url, i) => [url, i]));
    const byRank = [...vetted.candidates].sort(
      (a, b) => (rank.get(a.issue.url) ?? 0) - (rank.get(b.issue.url) ?? 0),
    );
    candidates = [
      ...byRank.filter((c) => c.recommendation !== "skip"),
      ...byRank.filter((c) => c.recommendation === "skip"),
    ].slice(0, maxResults);
  }

  return {
    candidates,
    allReposFailed: repos.length > 0 && listed.failedRepos >= repos.length,
    rateLimitHit,
  };
}
