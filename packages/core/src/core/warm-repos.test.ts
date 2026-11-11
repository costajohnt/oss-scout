import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";
import type { IssueCandidate } from "./types.js";
import type { IssueVetter } from "./issue-vetting.js";
import type { GitHubSearchItem } from "./issue-filtering.js";
import {
  fetchWarmRepoCandidates,
  listWarmRepoIssues,
  rankWarmIssues,
  type WarmIssue,
} from "./warm-repos.js";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

/**
 * In-memory stand-in for the HTTP cache the skip memory lives in, so tests
 * never touch ~/.oss-scout/cache. Keyed exactly as the real cache is; entries
 * carry `cachedAt` so freshness checks behave like `HttpCache.getEntryIfFresh`.
 * Hoisted: the mock factory below runs before this module's body.
 */
const cacheEntries = vi.hoisted(
  () =>
    new Map<
      string,
      { url: string; etag: string; body: unknown; cachedAt: string }
    >(),
);

vi.mock("./http-cache.js", () => ({
  versionedCacheKey: (key: string) => `v1:${key}`,
  getHttpCache: () => ({
    getEntryIfFresh: (key: string, maxAgeMs: number) => {
      const entry = cacheEntries.get(key);
      if (!entry) return null;
      const age = Date.now() - new Date(entry.cachedAt).getTime();
      return age > maxAgeMs ? null : entry;
    },
    set: (key: string, etag: string, body: unknown) => {
      cacheEntries.set(key, {
        url: key,
        etag,
        body,
        cachedAt: new Date().toISOString(),
      });
    },
  }),
}));

import { warn } from "./logger.js";
import { sleep } from "./utils.js";
import { versionedCacheKey } from "./http-cache.js";

// ── Fixtures ───────────────────────────────────────────────────────

const NOW = new Date("2026-06-15T12:00:00Z");

function daysAgo(n: number, from: Date = NOW): string {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** One GraphQL issue node as the warmRepoIssues query returns it. */
function issueNode(over: Partial<Record<string, unknown>> = {}) {
  return {
    url: "https://github.com/owner/repo/issues/1",
    title: "Fix the thing",
    createdAt: "2026-06-14T00:00:00Z",
    updatedAt: "2026-06-14T06:00:00Z",
    authorAssociation: "NONE",
    viewerDidAuthor: false,
    assignees: { totalCount: 0 },
    comments: { totalCount: 0 },
    labels: { nodes: [{ name: "bug" }] },
    closedByPullRequestsReferences: { totalCount: 0 },
    ...over,
  };
}

/** One GraphQL repo node; `nameWithOwner` is what GitHub calls the repo today. */
function repoNode(
  nodes: Array<ReturnType<typeof issueNode> | null>,
  over: Partial<Record<string, unknown>> = {},
) {
  return {
    nameWithOwner: "owner/repo",
    isArchived: false,
    issues: { nodes },
    ...over,
  };
}

/**
 * A resolved batch response: alias `r<i>` for each repo, each with one issue
 * whose URL is derived from the repo name so results are attributable.
 */
function resolvedBatch(repos: string[]) {
  const res: Record<string, unknown> = {};
  repos.forEach((repo, i) => {
    res[`r${i}`] = repoNode(
      [issueNode({ url: `https://github.com/${repo}/issues/1` })],
      { nameWithOwner: repo },
    );
  });
  return res;
}

/** The repos a query asked for, in alias order, read back from its variables. */
function reposIn(variables: Record<string, unknown>): string[] {
  return Object.keys(variables)
    .filter((k) => /^o\d+$/.test(k))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((k) => `${variables[k]}/${variables[`n${k.slice(1)}`]}`);
}

/** The index of the first repo in a batch of `org<i>/repo<i>` names. */
const firstIndex = (batch: string[]): number =>
  Number(batch[0].match(/\d+/)![0]);

/** The skip-memory key `fetchWarmRepoCandidates` uses for an issue URL. */
const skipKey = (url: string) => versionedCacheKey(`warm-skip:${url}`);

/** Seed a skip-memory entry written `ageMs` ago. */
function rememberSkip(url: string, ageMs: number) {
  cacheEntries.set(skipKey(url), {
    url: skipKey(url),
    etag: "",
    body: true,
    cachedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

function makeOctokit(graphql: ReturnType<typeof vi.fn>): Octokit {
  return { graphql } as unknown as Octokit;
}

function warmIssue(over: Partial<WarmIssue> = {}): WarmIssue {
  const repo = over.repo ?? "owner/repo";
  return {
    html_url: `https://github.com/${repo}/issues/1`,
    repository_url: `https://api.github.com/repos/${repo}`,
    updated_at: "2026-06-14T06:00:00Z",
    title: "Fix the thing",
    labels: [],
    repo,
    listedAs: repo,
    createdAt: daysAgo(10),
    maintainerFiled: false,
    commentCount: 3,
    ...over,
  };
}

function makeCandidate(
  url: string,
  recommendation: IssueCandidate["recommendation"] = "approve",
): IssueCandidate {
  const repo = url.match(/github\.com\/([^/]+\/[^/]+)/)![1];
  return {
    issue: {
      id: 1,
      url,
      repo,
      number: 1,
      title: "Fix the thing",
      status: "candidate",
      labels: [],
      createdAt: "2026-06-14T00:00:00Z",
      updatedAt: "2026-06-14T06:00:00Z",
      vetted: true,
    },
    vettingResult: {
      passedAllChecks: true,
      checks: {
        noExistingPR: true,
        notClaimed: true,
        projectActive: true,
        clearRequirements: true,
        contributionGuidelinesFound: true,
      },
      notes: [],
    },
    projectHealth: {
      repo,
      lastCommitAt: "",
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
    },
    antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
    slmTriage: null,
    recommendation,
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 80,
    searchPriority: "merged_pr",
  } as unknown as IssueCandidate;
}

function makeVetter(
  vetIssuesParallel: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({
    candidates: [],
    allFailed: false,
    rateLimitHit: false,
  }),
): { vetter: IssueVetter; vetIssuesParallel: ReturnType<typeof vi.fn> } {
  return {
    vetter: { vetIssuesParallel } as unknown as IssueVetter,
    vetIssuesParallel,
  };
}

/** Default vetter: approves every URL it is given, in the order given. */
function approvingVetter() {
  return makeVetter(
    vi.fn(async (urls: string[]) => ({
      candidates: urls.map((u) => makeCandidate(u)),
      allFailed: false,
      rateLimitHit: false,
    })),
  );
}

const identity = (items: GitHubSearchItem[]) => items;
const noScore = () => null;

beforeEach(() => {
  vi.clearAllMocks();
  cacheEntries.clear();
});

// ── listWarmRepoIssues ─────────────────────────────────────────────

describe("listWarmRepoIssues", () => {
  it("returns items in the GitHubSearchItem shape issue-filtering reads, plus ranking signals", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([
        issueNode({
          url: "https://github.com/owner/repo/issues/42",
          title: "Dark mode",
          createdAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-12T00:00:00Z",
          authorAssociation: "MEMBER",
          comments: { totalCount: 2 },
          labels: { nodes: [{ name: "bug" }, { name: "help wanted" }] },
        }),
      ]),
    });

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);

    expect(result.failedRepos).toBe(0);
    expect(result.rateLimitHit).toBe(false);
    expect(result.items).toEqual([
      {
        html_url: "https://github.com/owner/repo/issues/42",
        repository_url: "https://api.github.com/repos/owner/repo",
        updated_at: "2026-06-12T00:00:00Z",
        title: "Dark mode",
        labels: [{ name: "bug" }, { name: "help wanted" }],
        repo: "owner/repo",
        listedAs: "owner/repo",
        createdAt: "2026-06-10T00:00:00Z",
        maintainerFiled: true,
        commentCount: 2,
      },
    ]);
  });

  it("defaults labels to [] when the labels connection is null", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([issueNode({ labels: null })]),
    });
    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(items[0].labels).toEqual([]);
  });

  it("drops assigned issues", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([
        issueNode({
          url: "https://github.com/owner/repo/issues/1",
          assignees: { totalCount: 1 },
        }),
        issueNode({ url: "https://github.com/owner/repo/issues/2" }),
      ]),
    });
    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(items.map((i) => i.html_url)).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
  });

  it("drops issues that already have an open closing PR", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([
        issueNode({
          url: "https://github.com/owner/repo/issues/1",
          closedByPullRequestsReferences: { totalCount: 1 },
        }),
        issueNode({
          url: "https://github.com/owner/repo/issues/2",
          closedByPullRequestsReferences: null,
        }),
        issueNode({ url: "https://github.com/owner/repo/issues/3" }),
      ]),
    });
    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(items.map((i) => i.html_url)).toEqual([
      "https://github.com/owner/repo/issues/2",
      "https://github.com/owner/repo/issues/3",
    ]);
  });

  it("ignores null entries inside issues.nodes", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([
        null,
        issueNode({ url: "https://github.com/owner/repo/issues/2" }),
        null,
      ]),
    });
    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(result.items.map((i) => i.html_url)).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
    expect(result.failedRepos).toBe(0);
  });

  it("yields nothing for an archived repo without counting it as failed", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([issueNode()], { isArchived: true }),
    });
    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(result.items).toEqual([]);
    expect(result.failedRepos).toBe(0);
    // Archived resolved fine; nothing to retry.
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it.each([["owner/repo"], ["owner/re_po.js-v2"], ["o-w.n_er/r"], ["a1/B2"]])(
    "accepts the valid repo %s",
    async (repo) => {
      const graphql = vi.fn().mockResolvedValue(resolvedBatch([repo]));
      const result = await listWarmRepoIssues(makeOctokit(graphql), [repo]);
      expect(result.failedRepos).toBe(0);
      expect(result.items).toHaveLength(1);
    },
  );

  it.each([
    ["solo"],
    ["acme/widget/extra"],
    ["acme/"],
    ["/widget"],
    ["acme/wid get"],
    ["acme/wid$get"],
    ['acme/widget") { x }'],
  ])(
    "never queries the invalid repo %s and counts it as failed",
    async (bad) => {
      const graphql = vi.fn().mockResolvedValue(resolvedBatch(["good/repo"]));
      const result = await listWarmRepoIssues(makeOctokit(graphql), [
        bad,
        "good/repo",
      ]);

      expect(graphql).toHaveBeenCalledTimes(1);
      const [query, variables] = graphql.mock.calls[0];
      expect(JSON.stringify(variables)).not.toContain(bad);
      expect(query).not.toContain(bad);
      expect(variables).toEqual({ o0: "good", n0: "repo" });
      expect(result.failedRepos).toBe(1);
      expect(result.items).toHaveLength(1);
    },
  );

  it("returns empty without querying for an all-invalid list", async () => {
    const graphql = vi.fn();
    const result = await listWarmRepoIssues(makeOctokit(graphql), ["nope"]);
    expect(graphql).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], failedRepos: 1, rateLimitHit: false });
  });

  it("queries repos in batches of 8 with owner/name as GraphQL variables, not interpolated", async () => {
    const repos = Array.from({ length: 11 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const res: Record<string, unknown> = {};
        for (const key of Object.keys(variables)) {
          const m = key.match(/^o(\d+)$/);
          if (!m) continue;
          const repo = `${variables[`o${m[1]}`]}/${variables[`n${m[1]}`]}`;
          res[`r${m[1]}`] = repoNode(
            [issueNode({ url: `https://github.com/${repo}/issues/1` })],
            { nameWithOwner: repo },
          );
        }
        return res;
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    expect(graphql).toHaveBeenCalledTimes(2);
    const [query1, vars1] = graphql.mock.calls[0];
    const [query2, vars2] = graphql.mock.calls[1];
    expect(Object.keys(vars1)).toHaveLength(16);
    expect(Object.keys(vars2)).toHaveLength(6);
    expect(vars1).toMatchObject({
      o0: "org0",
      n0: "repo0",
      o7: "org7",
      n7: "repo7",
    });
    expect(vars2).toMatchObject({
      o0: "org8",
      n0: "repo8",
      o2: "org10",
      n2: "repo10",
    });
    expect(query1).toContain("query warmRepoIssues(");
    expect(query1).toContain("r0: repository(owner: $o0, name: $n0)");
    expect(query1).toContain("r7: repository(owner: $o7, name: $n7)");
    expect(query1).not.toContain("r8:");
    for (const repo of repos) {
      expect(query1).not.toContain(repo.split("/")[0]);
      expect(query2).not.toContain(repo.split("/")[0]);
    }
    expect(query1).toContain("states: OPEN");
    expect(query1).toContain("assignees { totalCount }");
    expect(query1).toContain("closedByPullRequestsReferences(");
    expect(result.items).toHaveLength(11);
    expect(result.failedRepos).toBe(0);
    // One pause between the two batches, none before the first.
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("keeps the resolved aliases from a partial-data error", async () => {
    const err = Object.assign(new Error("Could not resolve to a Repository"), {
      data: { r0: repoNode([issueNode()]), r1: null },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["r1"],
          message: "Could not resolve to a Repository",
        },
      ],
    });
    const graphql = vi.fn().mockRejectedValue(err);

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
      "gone/repo",
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].repo).toBe("owner/repo");
    expect(result.failedRepos).toBe(1);
    expect(result.rateLimitHit).toBe(false);
  });

  it("does not retry an alias reported NOT_FOUND and counts it as failed", async () => {
    const err = Object.assign(new Error("Could not resolve to a Repository"), {
      data: { r0: repoNode([issueNode()]), r1: null },
      errors: [{ type: "NOT_FOUND", path: ["r1"] }],
    });
    const graphql = vi.fn().mockRejectedValue(err);

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
      "gone/repo",
    ]);

    // Exactly one query: no solo retry for the deleted/renamed repo.
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.failedRepos).toBe(1);
  });

  it("retries an alias that came back null next to resolved ones, alone, exactly once", async () => {
    const graphql = vi
      .fn()
      // Batch: r1 nulled out (resource limit casualty), r0 and r2 resolved.
      .mockResolvedValueOnce({
        r0: repoNode(
          [issueNode({ url: "https://github.com/a/one/issues/1" })],
          { nameWithOwner: "a/one" },
        ),
        r1: null,
        r2: repoNode(
          [issueNode({ url: "https://github.com/c/three/issues/1" })],
          { nameWithOwner: "c/three" },
        ),
      })
      // Solo retry of b/two resolves.
      .mockResolvedValueOnce({
        r0: repoNode(
          [issueNode({ url: "https://github.com/b/two/issues/1" })],
          { nameWithOwner: "b/two" },
        ),
      });

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "a/one",
      "b/two",
      "c/three",
    ]);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toEqual({ o0: "b", n0: "two" });
    expect(result.items.map((i) => i.repo).sort()).toEqual([
      "a/one",
      "b/two",
      "c/three",
    ]);
    expect(result.failedRepos).toBe(0);
  });

  it("counts a repo as failed when its solo retry also comes back null, without a third attempt", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({ r0: repoNode([issueNode()]), r1: null })
      .mockResolvedValueOnce({ r0: null });

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "a/one",
      "b/two",
    ]);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.failedRepos).toBe(1);
  });

  it("does not retry when a single-repo batch comes back null", async () => {
    const graphql = vi.fn().mockResolvedValue({ r0: null });
    const result = await listWarmRepoIssues(makeOctokit(graphql), ["a/one"]);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.failedRepos).toBe(1);
  });

  it("propagates a 401", async () => {
    const err = Object.assign(new Error("Bad credentials"), { status: 401 });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      listWarmRepoIssues(makeOctokit(graphql), ["owner/repo"]),
    ).rejects.toThrow("Bad credentials");
  });

  it("stops the walk on a GraphQL RATE_LIMITED error, flags it, and returns what was read", async () => {
    const repos = Array.from({ length: 17 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(resolvedBatch(repos.slice(0, 8)))
      .mockRejectedValueOnce(
        Object.assign(new Error("API rate limit exceeded"), {
          errors: [{ type: "RATE_LIMITED", message: "API rate limit" }],
        }),
      );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Second batch hit the limit; the third was never attempted.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.rateLimitHit).toBe(true);
    expect(result.items).toHaveLength(8);
    expect(result.failedRepos).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("Rate limit hit"),
    );
  });

  it("treats a RATE_LIMITED error that carries partial data as a rate limit, not partial success", async () => {
    const repos = Array.from({ length: 10 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("API rate limit exceeded"), {
        data: { r0: repoNode([issueNode()]) },
        errors: [{ type: "RATE_LIMITED" }],
      }),
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.rateLimitHit).toBe(true);
    expect(result.items).toEqual([]);
  });

  it("stops the solo retries too once the rate limit is hit", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        r0: repoNode([issueNode()]),
        r1: null,
        r2: null,
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("limit"), { status: 429 }),
      );

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "a/one",
      "b/two",
      "c/three",
    ]);

    // Batch + first solo retry (rate limited); the second retry is skipped.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.rateLimitHit).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it("retries a batch that threw with no data repo by repo: repos that resolve alone are returned, the rest count as failed once each", async () => {
    const graphql = vi
      .fn()
      // The whole batch throws (no `.data`): not a partial response.
      .mockRejectedValueOnce(new Error("fetch failed"))
      // Solo retries, in batch order: a/one resolves, b/two throws, c/three resolves.
      .mockResolvedValueOnce({
        r0: repoNode(
          [issueNode({ url: "https://github.com/a/one/issues/1" })],
          { nameWithOwner: "a/one" },
        ),
      })
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce({
        r0: repoNode(
          [issueNode({ url: "https://github.com/c/three/issues/1" })],
          { nameWithOwner: "c/three" },
        ),
      });

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "a/one",
      "b/two",
      "c/three",
    ]);

    expect(graphql).toHaveBeenCalledTimes(4);
    // Octokit already retried the batch with backoff; each solo re-read gets
    // one attempt.
    expect(graphql.mock.calls.slice(1).map((c) => c[1])).toEqual([
      { o0: "a", n0: "one", request: { retries: 0 } },
      { o0: "b", n0: "two", request: { retries: 0 } },
      { o0: "c", n0: "three", request: { retries: 0 } },
    ]);
    expect(result.items.map((i) => i.repo)).toEqual(["a/one", "c/three"]);
    expect(result.failedRepos).toBe(1);
    expect(result.rateLimitHit).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining(
        "Failed to list issues for a/one, b/two, c/three",
      ),
    );
  });

  it("counts a single-repo batch that throws as one failed repo without retrying it", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await listWarmRepoIssues(makeOctokit(graphql), ["a/one"]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ items: [], failedRepos: 1, rateLimitHit: false });
  });

  it("stops the walk after two consecutive dead batches and counts the unvisited repos as failed", async () => {
    // Three batches of 8; every query (batch and solo) throws.
    const repos = Array.from({ length: 24 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1 (1 + 8 solo) and batch 2 (1 + 8 solo); batch 3 never queried.
    expect(graphql).toHaveBeenCalledTimes(18);
    expect(graphql.mock.calls.map((c) => c[1])).not.toContainEqual(
      expect.objectContaining({ o0: "org16" }),
    );
    expect(result.items).toEqual([]);
    expect(result.failedRepos).toBe(24);
    expect(result.rateLimitHit).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("2 batches in a row returned nothing"),
    );
  });

  it("resets the dead-batch counter when a batch resolves, so alternating dead and live batches all get queried", async () => {
    // Four batches of 8: batches 1 and 3 are dead (batch and every solo retry
    // throw), batches 2 and 4 resolve. Without the reset, batch 3 would be
    // the second dead batch and batch 4 would never be queried.
    const repos = Array.from({ length: 32 }, (_, i) => `org${i}/repo${i}`);
    const isDead = (repo: string) =>
      Math.floor(Number(repo.match(/\d+/)![0]) / 8) % 2 === 0;
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const batch = Object.keys(variables)
          .filter((k) => k.startsWith("o"))
          .map((k) => `${variables[k]}/${variables[`n${k.slice(1)}`]}`);
        if (batch.some(isDead)) throw new Error("fetch failed");
        return resolvedBatch(batch);
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // (1 + 8) + 1 + (1 + 8) + 1
    expect(graphql).toHaveBeenCalledTimes(20);
    expect(graphql.mock.calls.at(-1)![1]).toMatchObject({
      o0: "org24",
      o7: "org31",
    });
    expect(result.items.map((i) => i.repo)).toEqual([
      ...repos.slice(8, 16),
      ...repos.slice(24, 32),
    ]);
    expect(result.failedRepos).toBe(16);
    expect(warn).not.toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("batches in a row"),
    );
  });

  it("does not retry an alias reported FORBIDDEN and counts it as failed", async () => {
    const err = Object.assign(new Error("Resource not accessible"), {
      data: { r0: repoNode([issueNode()]), r1: null },
      errors: [{ type: "FORBIDDEN", path: ["r1"] }],
    });
    const graphql = vi.fn().mockRejectedValue(err);

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
      "private/repo",
    ]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.failedRepos).toBe(1);
  });

  it("names the repo by nameWithOwner, not the input string, in repo and repository_url", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode(
        [issueNode({ url: "https://github.com/new/name/issues/1" })],
        { nameWithOwner: "new/name" },
      ),
    });

    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "old/name",
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].repo).toBe("new/name");
    expect(items[0].repository_url).toBe(
      "https://api.github.com/repos/new/name",
    );
  });

  it("sets listedAs to the input name and repo to nameWithOwner when they differ", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode(
        [issueNode({ url: "https://github.com/new/name/issues/1" })],
        { nameWithOwner: "new/name" },
      ),
    });

    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "old/name",
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].listedAs).toBe("old/name");
    expect(items[0].repo).toBe("new/name");
    expect(items[0].repository_url).toBe(
      "https://api.github.com/repos/new/name",
    );
  });

  it("turns off octokit retries only for the solo re-reads of a batch that threw", async () => {
    // Batch 1 (org0-org7) throws outright; batch 2 (org8, org9) resolves with
    // org9 nulled out, so both kinds of solo re-read happen in one walk.
    const repos = Array.from({ length: 10 }, (_, i) => `org${i}/repo${i}`);
    let call = 0;
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        call++;
        if (call === 1) throw new Error("fetch failed");
        const batch = reposIn(variables);
        const res = resolvedBatch(batch);
        if (batch.length === 2) res.r1 = null;
        return res;
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1, 8 solo re-reads, batch 2, 1 solo re-read.
    expect(graphql).toHaveBeenCalledTimes(11);
    // The first read of a batch keeps octokit's retries.
    expect(graphql.mock.calls[0][1]).toMatchObject({ o0: "org0", o7: "org7" });
    expect(graphql.mock.calls[0][1]).not.toHaveProperty("request");
    expect(graphql.mock.calls[9][1]).toMatchObject({ o0: "org8", o1: "org9" });
    expect(graphql.mock.calls[9][1]).not.toHaveProperty("request");
    // Solo re-reads of the batch that threw get one attempt each.
    for (let i = 0; i < 8; i++) {
      expect(graphql.mock.calls[1 + i][1]).toEqual({
        o0: `org${i}`,
        n0: `repo${i}`,
        request: { retries: 0 },
      });
    }
    // The solo re-read of a resource-limit casualty keeps the retries.
    expect(graphql.mock.calls[10][1]).toEqual({ o0: "org9", n0: "repo9" });
    expect(graphql.mock.calls[10][1]).not.toHaveProperty("request");
    expect(result.items).toHaveLength(10);
    expect(result.failedRepos).toBe(0);
  });

  it("does not count a batch that resolved with nothing takeable as dead: null, NOT_FOUND, archived and empty batches in a row leave the walk running", async () => {
    // Four batches of 8. Batch 1 resolves with every alias null, and so does
    // every solo re-read; batch 2 is a partial-data error naming every alias
    // NOT_FOUND; batch 3 resolves to archived and issue-less repos; batch 4
    // has issues. Three batches without an item would stop a walk that keyed
    // "alive" on items found.
    const repos = Array.from({ length: 32 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const batch = reposIn(variables);
        const n = firstIndex(batch);
        const allNull = Object.fromEntries(
          batch.map((_, j) => [`r${j}`, null]),
        );
        if (n < 8) return allNull;
        if (n < 16) {
          throw Object.assign(new Error("Could not resolve to a Repository"), {
            data: allNull,
            errors: batch.map((_, j) => ({
              type: "NOT_FOUND",
              path: [`r${j}`],
            })),
          });
        }
        if (n < 24) {
          return Object.fromEntries(
            batch.map((repo, j) => [
              `r${j}`,
              j % 2 === 0
                ? repoNode([issueNode()], {
                    nameWithOwner: repo,
                    isArchived: true,
                  })
                : repoNode([], { nameWithOwner: repo }),
            ]),
          );
        }
        return resolvedBatch(batch);
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1 (1 + 8 solo re-reads), then batches 2, 3 and 4 once each.
    expect(graphql).toHaveBeenCalledTimes(12);
    expect(graphql.mock.calls.at(-1)![1]).toMatchObject({
      o0: "org24",
      o7: "org31",
    });
    expect(result.items.map((i) => i.repo)).toEqual(repos.slice(24));
    // The 8 null solo re-reads and the 8 NOT_FOUND aliases.
    expect(result.failedRepos).toBe(16);
    expect(result.rateLimitHit).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("batches in a row"),
    );
  });

  it("counts only the unvisited repos as failed when the walk stops: 20 repos with batches 1 and 2 dead -> 20 failed, batch 3 never queried", async () => {
    // Batches of 8, 8 and 4; every query (batch and solo) throws.
    const repos = Array.from({ length: 20 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1 (1 + 8 solo) and batch 2 (1 + 8 solo).
    expect(graphql).toHaveBeenCalledTimes(18);
    expect(graphql.mock.calls.map((c) => c[1])).not.toContainEqual(
      expect.objectContaining({ o0: "org16" }),
    );
    expect(result.items).toEqual([]);
    expect(result.failedRepos).toBe(20);
    expect(result.rateLimitHit).toBe(false);
  });

  it("counts only the unvisited repos as failed when the walk stops: 9 repos with the 8-repo batch and the single-repo batch both dead -> 10 queries, 9 failed", async () => {
    const repos = Array.from({ length: 9 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1 (1 + 8 solo) and the single-repo batch 2 (1, not re-read).
    expect(graphql).toHaveBeenCalledTimes(10);
    expect(graphql.mock.calls.at(-1)![1]).toEqual({ o0: "org8", n0: "repo8" });
    expect(result.items).toEqual([]);
    expect(result.failedRepos).toBe(9);
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("2 batches in a row returned nothing"),
    );
  });

  it("after a thrown batch, a solo re-read that resolves with a null alias counts the repo failed once and keeps the batch alive", async () => {
    // Three batches of 8. Batch 1 throws and every solo re-read resolves with
    // a null alias; batch 2 is dead (batch and solo re-reads throw); batch 3
    // resolves. Were batch 1 dead, batch 2 would be the second dead batch and
    // batch 3 would never be queried.
    const repos = Array.from({ length: 24 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const batch = reposIn(variables);
        const n = firstIndex(batch);
        if (n < 8) {
          if (batch.length > 1) throw new Error("fetch failed");
          return { r0: null };
        }
        if (n < 16) throw new Error("fetch failed");
        return resolvedBatch(batch);
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // (1 + 8) + (1 + 8) + 1
    expect(graphql).toHaveBeenCalledTimes(19);
    expect(graphql.mock.calls.at(-1)![1]).toMatchObject({
      o0: "org16",
      o7: "org23",
    });
    expect(result.items.map((i) => i.repo)).toEqual(repos.slice(16));
    // 8 null solo re-reads, counted once each, plus batch 2's 8.
    expect(result.failedRepos).toBe(16);
    expect(warn).not.toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("batches in a row"),
    );
  });

  it("after a thrown batch, a rate limit on a solo re-read stops the walk, flags it, and does not count the unretried repos as failed", async () => {
    const repos = Array.from({ length: 16 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi
      .fn()
      // Batch 1 throws outright.
      .mockRejectedValueOnce(new Error("fetch failed"))
      // Solo re-read of org0 resolves; org1 hits the limit.
      .mockResolvedValueOnce(resolvedBatch(["org0/repo0"]))
      .mockRejectedValueOnce(
        Object.assign(new Error("API rate limit exceeded"), { status: 429 }),
      );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // org2-org7 are not re-read and batch 2 is never queried.
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[2][1]).toMatchObject({ o0: "org1" });
    expect(result.rateLimitHit).toBe(true);
    expect(result.items.map((i) => i.repo)).toEqual(["org0/repo0"]);
    expect(result.failedRepos).toBe(0);
  });

  it("lists each issue once when two input names resolve to the same repo", async () => {
    const node = () =>
      repoNode([issueNode({ url: "https://github.com/new/name/issues/1" })], {
        nameWithOwner: "new/name",
      });
    const graphql = vi.fn().mockResolvedValue({ r0: node(), r1: node() });

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "old/name",
      "new/name",
    ]);

    expect(result.items.map((i) => i.html_url)).toEqual([
      "https://github.com/new/name/issues/1",
    ]);
    expect(result.failedRepos).toBe(0);
  });

  it("stops the walk on the rate-limit error the throttling plugin throws (errors under .data) without solo retries", async () => {
    // @octokit/plugin-throttling rethrows the GraphQL body as `.data`, with
    // no top-level `errors` and no `status`. `.data` is truthy, so without
    // the deeper check this would pass for a partial response.
    const err = Object.assign(new Error("GraphQL Rate Limit Exceeded"), {
      response: { status: 200, headers: {}, data: {} },
      data: {
        data: { r0: null, r1: null },
        errors: [{ type: "RATE_LIMITED" }],
      },
    });
    const graphql = vi.fn().mockRejectedValue(err);

    const result = await listWarmRepoIssues(makeOctokit(graphql), [
      "a/one",
      "b/two",
    ]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ items: [], failedRepos: 0, rateLimitHit: true });
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("Rate limit hit"),
    );
  });

  it.each([
    [{ status: 403, message: "You have exceeded a secondary rate limit" }],
    [{ status: 429, message: "Too many requests" }],
  ])(
    "stops the walk on the HTTP-shaped limit %o and flags rateLimitHit",
    async (shape) => {
      const repos = Array.from({ length: 9 }, (_, i) => `org${i}/repo${i}`);
      const err = Object.assign(new Error(shape.message), {
        status: shape.status,
      });
      const graphql = vi.fn().mockRejectedValue(err);

      const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

      // The first batch hit the limit: no solo retries, no second batch.
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ items: [], failedRepos: 0, rateLimitHit: true });
    },
  );

  it("does not sleep before solo retries and waits 500ms between batches", async () => {
    const repos = Array.from({ length: 9 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const batch = Object.keys(variables)
          .filter((k) => k.startsWith("o"))
          .map((k) => `${variables[k]}/${variables[`n${k.slice(1)}`]}`);
        const res = resolvedBatch(batch);
        // In the first batch, org1 is a resource-limit casualty.
        if (batch.length > 1) res.r1 = null;
        return res;
      },
    );

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    // Batch 1, solo retry of org1, batch 2.
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[1][1]).toEqual({ o0: "org1", n0: "repo1" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(result.items).toHaveLength(9);
    expect(result.failedRepos).toBe(0);
  });

  it.each([
    ["OWNER", true],
    ["MEMBER", true],
    ["COLLABORATOR", true],
    ["CONTRIBUTOR", false],
    ["FIRST_TIME_CONTRIBUTOR", false],
    ["FIRST_TIMER", false],
    ["MANNEQUIN", false],
    ["NONE", false],
  ])(
    "maintainerFiled for authorAssociation %s is %s",
    async (assoc, expected) => {
      const graphql = vi.fn().mockResolvedValue({
        r0: repoNode([issueNode({ authorAssociation: assoc })]),
      });
      const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
        "owner/repo",
      ]);
      expect(items[0].maintainerFiled).toBe(expected);
    },
  );

  it("maintainerFiled is false for an OWNER issue the user filed (viewerDidAuthor)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      r0: repoNode([
        issueNode({ authorAssociation: "OWNER", viewerDidAuthor: true }),
      ]),
    });
    const { items } = await listWarmRepoIssues(makeOctokit(graphql), [
      "owner/repo",
    ]);
    expect(items[0].maintainerFiled).toBe(false);
  });
});

// ── rankWarmIssues ─────────────────────────────────────────────────

describe("rankWarmIssues", () => {
  /** Two issues identical except for `over` on the first; returns their order. */
  function order(over: Partial<WarmIssue>, baseOver: Partial<WarmIssue> = {}) {
    const base = warmIssue({
      html_url: "https://github.com/owner/repo/issues/base",
      ...baseOver,
    });
    const boosted = warmIssue({
      ...baseOver,
      html_url: "https://github.com/owner/repo/issues/boosted",
      ...over,
    });
    return rankWarmIssues([base, boosted], noScore, NOW).map((i) => i.html_url);
  }

  const BASE = "https://github.com/owner/repo/issues/base";
  const BOOSTED = "https://github.com/owner/repo/issues/boosted";

  it("ranks a <=2-day-old issue above a 10-day-old one", () => {
    expect(
      order({ createdAt: daysAgo(2) }, { createdAt: daysAgo(10) }),
    ).toEqual([BOOSTED, BASE]);
  });

  it("ranks a 10-day-old issue above a 20-day-old one", () => {
    expect(
      order({ createdAt: daysAgo(10) }, { createdAt: daysAgo(20) }),
    ).toEqual([BOOSTED, BASE]);
  });

  it("ranks a 20-day-old issue above a 60-day-old one", () => {
    expect(
      order({ createdAt: daysAgo(20) }, { createdAt: daysAgo(60) }),
    ).toEqual([BOOSTED, BASE]);
  });

  it("ranks a maintainer-filed issue above an otherwise identical one", () => {
    expect(order({ maintainerFiled: true })).toEqual([BOOSTED, BASE]);
  });

  it("ranks an issue with zero comments above an otherwise identical one", () => {
    expect(order({ commentCount: 0 })).toEqual([BOOSTED, BASE]);
  });

  it("ranks an issue from a higher-scored repo above an otherwise identical one", () => {
    const low = warmIssue({ repo: "owner/low" });
    const high = warmIssue({ repo: "owner/high" });
    const score = (repo: string) => (repo === "owner/high" ? 9 : 2);
    expect(rankWarmIssues([low, high], score, NOW).map((i) => i.repo)).toEqual([
      "owner/high",
      "owner/low",
    ]);
  });

  it("falls back to the score under listedAs when there is none under repo", () => {
    // Same freshness band; the unknown repo is newer, so only the listedAs
    // score puts the renamed repo first.
    const renamed = warmIssue({
      repo: "new/name",
      listedAs: "old/name",
      createdAt: daysAgo(12),
    });
    const unknown = warmIssue({
      repo: "owner/unknown",
      createdAt: daysAgo(11),
    });
    const score = (repo: string) => (repo === "old/name" ? 9 : null);
    expect(
      rankWarmIssues([unknown, renamed], score, NOW).map((i) => i.repo),
    ).toEqual(["new/name", "owner/unknown"]);
  });

  it("prefers the score under repo over the one under listedAs", () => {
    const renamed = warmIssue({
      repo: "new/name",
      listedAs: "old/name",
      createdAt: daysAgo(12),
    });
    const unknown = warmIssue({
      repo: "owner/unknown",
      createdAt: daysAgo(11),
    });
    const score = (repo: string) =>
      repo === "new/name" ? 9 : repo === "old/name" ? 1 : null;
    expect(
      rankWarmIssues([unknown, renamed], score, NOW).map((i) => i.repo),
    ).toEqual(["new/name", "owner/unknown"]);
  });

  it("treats a null repoScore as 5", () => {
    const unknown = warmIssue({ repo: "owner/unknown" });
    const four = warmIssue({ repo: "owner/four" });
    const six = warmIssue({ repo: "owner/six" });
    const score = (repo: string) =>
      repo === "owner/four" ? 4 : repo === "owner/six" ? 6 : null;
    expect(
      rankWarmIssues([four, unknown, six], score, NOW).map((i) => i.repo),
    ).toEqual(["owner/six", "owner/unknown", "owner/four"]);
  });

  it("breaks ties newest-first", () => {
    const older = warmIssue({
      html_url: "https://github.com/owner/repo/issues/older",
      createdAt: daysAgo(12),
    });
    const newer = warmIssue({
      html_url: "https://github.com/owner/repo/issues/newer",
      createdAt: daysAgo(11),
    });
    // Both fall in the same freshness band (3-14 days), so only the tiebreak
    // separates them.
    expect(
      rankWarmIssues([older, newer], noScore, NOW).map((i) => i.html_url),
    ).toEqual([
      "https://github.com/owner/repo/issues/newer",
      "https://github.com/owner/repo/issues/older",
    ]);
  });

  it("does not mutate the input array", () => {
    const a = warmIssue({ html_url: "a", createdAt: daysAgo(40) });
    const b = warmIssue({ html_url: "b", createdAt: daysAgo(1) });
    const input = [a, b];
    const ranked = rankWarmIssues(input, noScore, NOW);
    expect(ranked.map((i) => i.html_url)).toEqual(["b", "a"]);
    expect(input).toEqual([a, b]);
    expect(input[0]).toBe(a);
  });
});

// ── fetchWarmRepoCandidates ────────────────────────────────────────

describe("fetchWarmRepoCandidates", () => {
  /** An octokit whose single batch resolves `issuesByRepo` for each repo. */
  function listingOctokit(
    issuesByRepo: Record<string, Array<ReturnType<typeof issueNode>>>,
  ) {
    const graphql = vi.fn(
      async (_q: string, variables: Record<string, string>) => {
        const res: Record<string, unknown> = {};
        for (const key of Object.keys(variables)) {
          const m = key.match(/^o(\d+)$/);
          if (!m) continue;
          const repo = `${variables[`o${m[1]}`]}/${variables[`n${m[1]}`]}`;
          res[`r${m[1]}`] = repoNode(issuesByRepo[repo] ?? [], {
            nameWithOwner: repo,
          });
        }
        return res;
      },
    );
    return makeOctokit(graphql);
  }

  /** `n` issues in `repo`, newest first, all unassigned and untaken. */
  function issuesIn(
    repo: string,
    n: number,
    over: Partial<Record<string, unknown>> = {},
  ) {
    return Array.from({ length: n }, (_, i) =>
      issueNode({
        url: `https://github.com/${repo}/issues/${i + 1}`,
        createdAt: daysAgo(i + 1),
        ...over,
      }),
    );
  }

  it("lets filterFn decide which listed issues are eligible", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter, vetIssuesParallel } = approvingVetter();
    const filterFn = vi.fn((items: GitHubSearchItem[]) =>
      items.filter((i) => i.html_url.endsWith("/2")),
    );

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      filterFn,
      noScore,
    );

    // Once under the current repo name, once under the name it was listed by.
    expect(filterFn).toHaveBeenCalledTimes(2);
    expect(filterFn.mock.calls[0][0]).toHaveLength(3);
    expect(filterFn.mock.calls[1][0]).toHaveLength(3);
    expect(vetIssuesParallel).toHaveBeenCalledTimes(1);
    expect(vetIssuesParallel.mock.calls[0][0]).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
  });

  describe("a renamed repo (listed as old/name, now new/name)", () => {
    /** An octokit that resolves "old/name" to a repo GitHub now calls "new/name". */
    const renamedOctokit = () =>
      makeOctokit(
        vi.fn().mockResolvedValue({
          r0: repoNode(
            [issueNode({ url: "https://github.com/new/name/issues/1" })],
            { nameWithOwner: "new/name" },
          ),
        }),
      );

    /** A filterFn that rejects issues whose repository_url names `name`. */
    const rejecting = (name: string) => (items: GitHubSearchItem[]) =>
      items.filter(
        (i) => i.repository_url !== `https://api.github.com/repos/${name}`,
      );

    async function vettedUrls(
      filterFn: (items: GitHubSearchItem[]) => GitHubSearchItem[],
    ) {
      const { vetter, vetIssuesParallel } = approvingVetter();
      await fetchWarmRepoCandidates(
        renamedOctokit(),
        vetter,
        ["old/name"],
        5,
        filterFn,
        noScore,
      );
      return vetIssuesParallel.mock.calls.flatMap((c) => c[0] as string[]);
    }

    it("vets the issue when filterFn rejects neither name", async () => {
      expect(await vettedUrls(rejecting("other/repo"))).toEqual([
        "https://github.com/new/name/issues/1",
      ]);
    });

    it("does not vet an issue that passes filterFn under its current name but not under the name it was listed by", async () => {
      expect(await vettedUrls(rejecting("old/name"))).toEqual([]);
    });

    it("does not vet an issue that passes filterFn under the name it was listed by but not under its current name", async () => {
      expect(await vettedUrls(rejecting("new/name"))).toEqual([]);
    });
  });

  it("reports vetError null when vetting succeeds", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 1) });
    const { vetter } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.vetError).toBeNull();
  });

  it("sends at most 3 URLs per repo to the vetter", async () => {
    const octokit = listingOctokit({
      "owner/busy": issuesIn("owner/busy", 6),
      "owner/quiet": issuesIn("owner/quiet", 1),
    });
    const { vetter, vetIssuesParallel } = approvingVetter();

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/busy", "owner/quiet"],
      10,
      identity,
      noScore,
    );

    const urls = vetIssuesParallel.mock.calls[0][0] as string[];
    expect(urls.filter((u) => u.includes("/busy/"))).toHaveLength(3);
    expect(urls.filter((u) => u.includes("/quiet/"))).toHaveLength(1);
  });

  it("sends at most maxResults * 2 URLs to the vetter, in rank order", async () => {
    // 5 repos x 2 issues = 10 eligible; maxResults 2 allows 4 vets.
    const repos = ["a/r", "b/r", "c/r", "d/r", "e/r"];
    const octokit = listingOctokit(
      Object.fromEntries(repos.map((r) => [r, issuesIn(r, 2)])),
    );
    const { vetter, vetIssuesParallel } = approvingVetter();
    // Rank by repo relationship so the order is deterministic and testable.
    const scores: Record<string, number> = {
      "a/r": 1,
      "b/r": 3,
      "c/r": 10,
      "d/r": 7,
      "e/r": 5,
    };
    const repoScore = (repo: string) => scores[repo];

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      repos,
      2,
      identity,
      repoScore,
    );

    expect(vetIssuesParallel).toHaveBeenCalledTimes(1);
    const [urls, cap, priority] = vetIssuesParallel.mock.calls[0];
    expect(urls).toHaveLength(4);
    // c/r (10) then d/r (7); within a repo the newer issue (#1) first.
    expect(urls).toEqual([
      "https://github.com/c/r/issues/1",
      "https://github.com/c/r/issues/2",
      "https://github.com/d/r/issues/1",
      "https://github.com/d/r/issues/2",
    ]);
    expect(cap).toBe(4);
    expect(priority).toBe("merged_pr");
  });

  it('calls the vetter with (urls, urls.length, "merged_pr") so skips cannot crowd out viable issues', async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter, vetIssuesParallel } = approvingVetter();

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      1,
      identity,
      noScore,
    );

    const [urls, cap, priority] = vetIssuesParallel.mock.calls[0];
    // maxResults 1 -> 2 URLs; the cap is the URL count, not maxResults.
    expect(urls).toHaveLength(2);
    expect(cap).toBe(2);
    expect(priority).toBe("merged_pr");
  });

  it("returns candidates in rank order even when the vetter returns them shuffled", async () => {
    const repos = ["a/r", "b/r", "c/r"];
    const octokit = listingOctokit(
      Object.fromEntries(repos.map((r) => [r, issuesIn(r, 1)])),
    );
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: [...urls].reverse().map((u) => makeCandidate(u)),
        allFailed: false,
        rateLimitHit: false,
      })),
    );
    const scores: Record<string, number> = { "a/r": 2, "b/r": 9, "c/r": 5 };

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      repos,
      5,
      identity,
      (repo) => scores[repo],
    );

    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/b/r/issues/1",
      "https://github.com/c/r/issues/1",
      "https://github.com/a/r/issues/1",
    ]);
  });

  it("places non-skip candidates before skip candidates, each group in rank order", async () => {
    const octokit = listingOctokit({
      "a/r": issuesIn("a/r", 1),
      "b/r": issuesIn("b/r", 1),
      "c/r": issuesIn("c/r", 1),
    });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: urls.map((u) =>
          makeCandidate(u, u.includes("/a/") ? "skip" : "approve"),
        ),
        allFailed: false,
        rateLimitHit: false,
      })),
    );
    // Rank order: a/r (skip), b/r, c/r.
    const scores: Record<string, number> = { "a/r": 9, "b/r": 5, "c/r": 2 };

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["a/r", "b/r", "c/r"],
      5,
      identity,
      (repo) => scores[repo],
    );

    expect(
      result.candidates.map((c) => [c.issue.url, c.recommendation]),
    ).toEqual([
      ["https://github.com/b/r/issues/1", "approve"],
      ["https://github.com/c/r/issues/1", "approve"],
      ["https://github.com/a/r/issues/1", "skip"],
    ]);
  });

  it("returns at most 2 candidates per repo: 3 viable in one repo -> the top 2 by rank", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter, vetIssuesParallel } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    // All 3 are still vetted (one spare for a reject)...
    expect(vetIssuesParallel.mock.calls[0][0]).toHaveLength(3);
    // ...but only the best two come back.
    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo/issues/2",
    ]);
  });

  it("returns at most 2 candidates per repo: 1 viable + 2 skips -> the viable one and the higher-ranked skip", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: urls.map((u) =>
          makeCandidate(u, u.endsWith("/2") ? "approve" : "skip"),
        ),
        allFailed: false,
        rateLimitHit: false,
      })),
    );

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(
      result.candidates.map((c) => [c.issue.url, c.recommendation]),
    ).toEqual([
      ["https://github.com/owner/repo/issues/2", "approve"],
      ["https://github.com/owner/repo/issues/1", "skip"],
    ]);
  });

  it("vets at most 60 URLs however large maxResults is", async () => {
    // 25 repos x 3 issues = 75 eligible after the per-repo vet cap of 3.
    const repos = Array.from({ length: 25 }, (_, i) => `org${i}/repo`);
    const octokit = listingOctokit(
      Object.fromEntries(repos.map((r) => [r, issuesIn(r, 3)])),
    );
    const { vetter, vetIssuesParallel } = approvingVetter();

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      repos,
      1000,
      identity,
      noScore,
    );

    expect(vetIssuesParallel).toHaveBeenCalledTimes(1);
    const [urls, cap] = vetIssuesParallel.mock.calls[0];
    expect(urls).toHaveLength(60);
    expect(cap).toBe(60);
  });

  it("does not call the vetter when the listing was cut short by a rate limit, and reports it with no candidates", async () => {
    // Batch 1 lists 8 repos' issues; batch 2 hits the limit.
    const repos = Array.from({ length: 9 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(resolvedBatch(repos.slice(0, 8)))
      .mockRejectedValueOnce(
        Object.assign(new Error("limit"), {
          errors: [{ type: "RATE_LIMITED" }],
        }),
      );
    const { vetter, vetIssuesParallel } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      makeOctokit(graphql),
      vetter,
      repos,
      5,
      identity,
      noScore,
    );

    expect(vetIssuesParallel).not.toHaveBeenCalled();
    expect(result).toEqual({
      candidates: [],
      allReposFailed: false,
      rateLimitHit: true,
      vetError: null,
    });
  });

  it("propagates a 401 thrown by the vetter", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 1) });
    const { vetter } = makeVetter(
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Bad credentials"), { status: 401 }),
        ),
    );

    await expect(
      fetchWarmRepoCandidates(
        octokit,
        vetter,
        ["owner/repo"],
        5,
        identity,
        noScore,
      ),
    ).rejects.toThrow("Bad credentials");
  });

  it.each([
    [
      "a rate-limit throw",
      Object.assign(new Error("API rate limit exceeded"), { status: 429 }),
      true,
    ],
    ["any other throw", new Error("fetch failed"), false],
  ])(
    "returns no candidates and the message as vetError when the vetter fails with %s, rateLimitHit %s, allReposFailed still from the listing",
    async (_label, err, rateLimitHit) => {
      const octokit = listingOctokit({
        "owner/repo": issuesIn("owner/repo", 1),
      });
      const { vetter, vetIssuesParallel } = makeVetter(
        vi.fn().mockRejectedValue(err),
      );

      // One invalid name fails in the listing; the valid one resolves, so
      // the listing reports one of two repos failed.
      const result = await fetchWarmRepoCandidates(
        octokit,
        vetter,
        ["not-a-repo", "owner/repo"],
        5,
        identity,
        noScore,
      );

      expect(vetIssuesParallel).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        candidates: [],
        allReposFailed: false,
        rateLimitHit,
        vetError: err.message,
      });
      expect(warn).toHaveBeenCalledWith(
        "warm-repos",
        expect.stringContaining("Vetting warm-repo issues failed"),
      );
    },
  );

  it("remembers a vetter skip in the skip memory and not a non-skip", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 2) });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: urls.map((u) =>
          makeCandidate(u, u.endsWith("/1") ? "skip" : "approve"),
        ),
        allFailed: false,
        rateLimitHit: false,
      })),
    );

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(
      cacheEntries.has(skipKey("https://github.com/owner/repo/issues/1")),
    ).toBe(true);
    expect(
      cacheEntries.has(skipKey("https://github.com/owner/repo/issues/2")),
    ).toBe(false);
  });

  it("does not vet an issue with a fresh skip-memory entry, but does once the entry is older than 24h", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter, vetIssuesParallel } = approvingVetter();
    const HOUR = 60 * 60 * 1000;
    rememberSkip("https://github.com/owner/repo/issues/1", 1 * HOUR);
    rememberSkip("https://github.com/owner/repo/issues/2", 25 * HOUR);

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(vetIssuesParallel.mock.calls[0][0]).toEqual([
      "https://github.com/owner/repo/issues/2",
      "https://github.com/owner/repo/issues/3",
    ]);
    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/owner/repo/issues/2",
      "https://github.com/owner/repo/issues/3",
    ]);
  });

  it("skip memory lasts 24h: an entry a minute short of it still hides the issue, one a minute past it does not", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter, vetIssuesParallel } = approvingVetter();
    const MINUTE = 60 * 1000;
    const DAY = 24 * 60 * MINUTE;
    rememberSkip("https://github.com/owner/repo/issues/1", DAY - MINUTE);
    rememberSkip("https://github.com/owner/repo/issues/2", DAY + MINUTE);

    await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(vetIssuesParallel.mock.calls[0][0]).toEqual([
      "https://github.com/owner/repo/issues/2",
      "https://github.com/owner/repo/issues/3",
    ]);
  });

  it("slices the result to maxResults, so skips do not consume result slots", async () => {
    const octokit = listingOctokit({
      "a/r": issuesIn("a/r", 2),
      "b/r": issuesIn("b/r", 2),
    });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        // Two skips ranked ahead of the two approves.
        candidates: urls.map((u) =>
          makeCandidate(
            u,
            u.startsWith("https://github.com/a/") ? "skip" : "approve",
          ),
        ),
        allFailed: false,
        rateLimitHit: false,
      })),
    );
    const repoScore = (repo: string) => (repo === "a/r" ? 10 : 1);

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["a/r", "b/r"],
      2,
      identity,
      repoScore,
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every((c) => c.recommendation === "approve")).toBe(
      true,
    );
  });

  it("does not call the vetter when nothing is eligible", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 2) });
    const { vetter, vetIssuesParallel } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      () => [],
      noScore,
    );

    expect(vetIssuesParallel).not.toHaveBeenCalled();
    expect(result).toEqual({
      candidates: [],
      allReposFailed: false,
      rateLimitHit: false,
      vetError: null,
    });
  });

  it("reports rateLimitHit when the listing hit the limit", async () => {
    const graphql = vi.fn().mockRejectedValue(
      Object.assign(new Error("limit"), {
        errors: [{ type: "RATE_LIMITED" }],
      }),
    );
    const { vetter, vetIssuesParallel } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      makeOctokit(graphql),
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(result.rateLimitHit).toBe(true);
    expect(vetIssuesParallel).not.toHaveBeenCalled();
    // A rate-limited batch is not a failed batch.
    expect(result.allReposFailed).toBe(false);
  });

  it("reports rateLimitHit when the vetter hit the limit", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 1) });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: urls.map((u) => makeCandidate(u)),
        allFailed: false,
        rateLimitHit: true,
      })),
    );

    const result = await fetchWarmRepoCandidates(
      octokit,
      vetter,
      ["owner/repo"],
      5,
      identity,
      noScore,
    );

    expect(result.rateLimitHit).toBe(true);
    expect(result.candidates).toHaveLength(1);
  });

  it("sets allReposFailed only when every repo failed", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const { vetter } = approvingVetter();

    const allFailed = await fetchWarmRepoCandidates(
      makeOctokit(graphql),
      vetter,
      ["a/r", "b/r"],
      5,
      identity,
      noScore,
    );
    expect(allFailed.allReposFailed).toBe(true);
    expect(allFailed.candidates).toEqual([]);

    // One of two resolves: not all failed.
    const partial = Object.assign(new Error("partial"), {
      data: { r0: repoNode([issueNode()]), r1: null },
      errors: [{ type: "NOT_FOUND", path: ["r1"] }],
    });
    const some = await fetchWarmRepoCandidates(
      makeOctokit(vi.fn().mockRejectedValue(partial)),
      vetter,
      ["a/r", "b/r"],
      5,
      identity,
      noScore,
    );
    expect(some.allReposFailed).toBe(false);
  });

  it("reports allReposFailed=false for an empty repo list without querying", async () => {
    const graphql = vi.fn();
    const { vetter, vetIssuesParallel } = approvingVetter();

    const result = await fetchWarmRepoCandidates(
      makeOctokit(graphql),
      vetter,
      [],
      5,
      identity,
      noScore,
    );

    expect(graphql).not.toHaveBeenCalled();
    expect(vetIssuesParallel).not.toHaveBeenCalled();
    expect(result).toEqual({
      candidates: [],
      allReposFailed: false,
      rateLimitHit: false,
      vetError: null,
    });
  });
});
