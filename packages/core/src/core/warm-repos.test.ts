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

import { warn } from "./logger.js";
import { sleep } from "./utils.js";

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
    assignees: { totalCount: 0 },
    comments: { totalCount: 0 },
    labels: { nodes: [{ name: "bug" }] },
    closedByPullRequestsReferences: { totalCount: 0 },
    ...over,
  };
}

function repoNode(
  nodes: Array<ReturnType<typeof issueNode> | null>,
  over: Partial<Record<string, unknown>> = {},
) {
  return { isArchived: false, issues: { nodes }, ...over };
}

/**
 * A resolved batch response: alias `r<i>` for each repo, each with one issue
 * whose URL is derived from the repo name so results are attributable.
 */
function resolvedBatch(repos: string[]) {
  const res: Record<string, unknown> = {};
  repos.forEach((repo, i) => {
    res[`r${i}`] = repoNode([
      issueNode({ url: `https://github.com/${repo}/issues/1` }),
    ]);
  });
  return res;
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
          if (m) res[`r${m[1]}`] = repoNode([issueNode()]);
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
        r0: repoNode([issueNode({ url: "https://github.com/a/one/issues/1" })]),
        r1: null,
        r2: repoNode([
          issueNode({ url: "https://github.com/c/three/issues/1" }),
        ]),
      })
      // Solo retry of b/two resolves.
      .mockResolvedValueOnce({
        r0: repoNode([issueNode({ url: "https://github.com/b/two/issues/1" })]),
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

  it("counts the whole batch as failed on a non-fatal error with no data and continues with the next batch", async () => {
    const repos = Array.from({ length: 10 }, (_, i) => `org${i}/repo${i}`);
    const graphql = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(resolvedBatch(repos.slice(8)));

    const result = await listWarmRepoIssues(makeOctokit(graphql), repos);

    expect(graphql).toHaveBeenCalledTimes(2);
    expect(result.failedRepos).toBe(8);
    expect(result.items.map((i) => i.repo)).toEqual([
      "org8/repo8",
      "org9/repo9",
    ]);
    expect(result.rateLimitHit).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "warm-repos",
      expect.stringContaining("Failed to list issues for org0/repo0"),
    );
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
          res[`r${m[1]}`] = repoNode(issuesByRepo[repo] ?? []);
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

    expect(filterFn).toHaveBeenCalledTimes(1);
    expect(filterFn.mock.calls[0][0]).toHaveLength(3);
    expect(vetIssuesParallel).toHaveBeenCalledTimes(1);
    expect(vetIssuesParallel.mock.calls[0][0]).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/owner/repo/issues/2",
    ]);
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
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: [...urls].reverse().map((u) => makeCandidate(u)),
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

    expect(result.candidates.map((c) => c.issue.url)).toEqual([
      "https://github.com/owner/repo/issues/1",
      "https://github.com/owner/repo/issues/2",
      "https://github.com/owner/repo/issues/3",
    ]);
  });

  it("places non-skip candidates before skip candidates, each group in rank order", async () => {
    const octokit = listingOctokit({ "owner/repo": issuesIn("owner/repo", 3) });
    const { vetter } = makeVetter(
      vi.fn(async (urls: string[]) => ({
        candidates: urls.map((u) =>
          makeCandidate(u, u.endsWith("/1") ? "skip" : "approve"),
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
      ["https://github.com/owner/repo/issues/3", "approve"],
      ["https://github.com/owner/repo/issues/1", "skip"],
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
    });
  });
});
