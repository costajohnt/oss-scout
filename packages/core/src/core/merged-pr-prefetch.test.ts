import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Octokit } from "@octokit/rest";

// ── Mocks ──────────────────────────────────────────────────────────
//
// A single stateful cache stub shared across both modules under test:
// prefetchMergedPRCounts (issue-graphql) writes to it, and
// checkUserMergedPRsInRepo (issue-eligibility) reads from it. This proves the
// two paths agree on the cache key (via the shared mergedPRsCacheKey helper).

const cacheStub = vi.hoisted(() => {
  const store = new Map<string, { body: unknown; at: number }>();
  return {
    store,
    getIfFresh: vi.fn((key: string, maxAgeMs: number) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.at > maxAgeMs) return null;
      return entry.body;
    }),
    set: vi.fn((key: string, _etag: string, body: unknown) => {
      store.set(key, { body, at: Date.now() });
    }),
  };
});

vi.mock("./http-cache.js", () => ({
  versionedCacheKey: (key: string) => `v1:${key}`,
  getHttpCache: () => cacheStub,
  // Passthrough — dedup itself is covered in http-cache.test.ts.
  withInflightDedup: async (
    _cache: unknown,
    _key: string,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./search-budget.js", () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    waitForBudget: vi.fn().mockResolvedValue(undefined),
    recordCall: vi.fn(),
  })),
}));

vi.mock("./pagination.js", () => ({
  paginateAll: vi.fn(),
}));

import {
  prefetchMergedPRCounts,
  type MergedPRRepoRef,
} from "./issue-graphql.js";
import {
  checkUserMergedPRsInRepo,
  mergedPRsCacheKey,
} from "./issue-eligibility.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeOctokit(
  graphql: ReturnType<typeof vi.fn>,
  search?: ReturnType<typeof vi.fn>,
): Octokit {
  return {
    graphql,
    search: { issuesAndPullRequests: search ?? vi.fn() },
  } as unknown as Octokit;
}

/** The authenticated-identity probe folded into every batch response. */
const VIEWER = { login: "octocat" };

const REPOS: MergedPRRepoRef[] = [
  { owner: "o1", repo: "r1" },
  { owner: "o2", repo: "r2" },
];

describe("prefetchMergedPRCounts", () => {
  beforeEach(() => {
    cacheStub.store.clear();
    cacheStub.set.mockClear();
    cacheStub.getIfFresh.mockClear();
  });

  it("no-ops without calling GraphQL when there are no repos", async () => {
    const graphql = vi.fn();
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", []);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("builds one aliased search query, passing query strings as variables", async () => {
    const graphql = vi.fn().mockResolvedValue({
      viewer: VIEWER,
      r0: { issueCount: 3 },
      r1: { issueCount: 0 },
    });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS);

    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = graphql.mock.calls[0];
    expect(query).toContain(
      "r0: search(query: $q0, type: ISSUE, first: 1) { issueCount }",
    );
    // Identity probe folded into the same round-trip.
    expect(query).toContain("viewer { login }");
    expect(query).toContain("$q0: String!");
    expect(query).toContain("$q1: String!");
    // User data lives in variables, never interpolated into the query document.
    expect(variables).toEqual({
      q0: "is:pr is:merged author:octocat repo:o1/r1",
      q1: "is:pr is:merged author:octocat repo:o2/r2",
    });
  });

  it("writes resolved counts to the cache under mergedPRsCacheKey", async () => {
    const graphql = vi.fn().mockResolvedValue({
      viewer: VIEWER,
      r0: { issueCount: 3 },
      r1: { issueCount: 7 },
    });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS);

    expect(cacheStub.set).toHaveBeenCalledWith(
      mergedPRsCacheKey("o1", "r1"),
      "",
      3,
    );
    expect(cacheStub.set).toHaveBeenCalledWith(
      mergedPRsCacheKey("o2", "r2"),
      "",
      7,
    );
  });

  it("caches a count of 0 (no merged PRs is a real answer, not an error)", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ viewer: VIEWER, r0: { issueCount: 0 } });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [REPOS[0]]);
    expect(cacheStub.set).toHaveBeenCalledWith(
      mergedPRsCacheKey("o1", "r1"),
      "",
      0,
    );
  });

  it("lets the per-call path hit the prefetched cache without a Search call", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ viewer: VIEWER, r0: { issueCount: 5 } });
    const search = vi.fn();
    const octokit = makeOctokit(graphql, search);

    await prefetchMergedPRCounts(octokit, "octocat", [
      { owner: "o1", repo: "r1" },
    ]);
    const count = await checkUserMergedPRsInRepo(octokit, "o1", "r1");

    expect(count).toBe(5);
    // The whole point: the Search API is never touched for a warmed repo.
    expect(search).not.toHaveBeenCalled();
  });

  it("dedups repeated repos into a single alias", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ viewer: VIEWER, r0: { issueCount: 1 } });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [
      { owner: "o1", repo: "r1" },
      { owner: "o1", repo: "r1" },
    ]);
    const [, variables] = graphql.mock.calls[0];
    expect(variables).not.toHaveProperty("q1");
  });

  it("splits repos beyond the batch size into multiple queries", async () => {
    const graphql = vi.fn().mockResolvedValue({});
    const many: MergedPRRepoRef[] = Array.from({ length: 16 }, (_, i) => ({
      owner: "o",
      repo: `r${i}`,
    }));
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", many);
    // 16 repos / batch size 15 → two queries (15 + 1).
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("drops repos with hostile names but keeps the valid ones", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ viewer: VIEWER, r0: { issueCount: 2 } });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [
      { owner: "good", repo: "repo" },
      { owner: "evil", repo: 'x") { viewer { login } } #' },
    ]);
    expect(graphql).toHaveBeenCalledTimes(1);
    const [, variables] = graphql.mock.calls[0];
    // Only the valid repo survives; the hostile one never enters the query.
    expect(variables).toEqual({
      q0: "is:pr is:merged author:octocat repo:good/repo",
    });
  });

  it("never calls GraphQL when every repo fails validation", async () => {
    const graphql = vi.fn();
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [
      { owner: "evil", repo: "a b c" },
      { owner: "also/bad", repo: "r" },
    ]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("no-ops on an empty or invalid username (REST falls back to @me)", async () => {
    const graphql = vi.fn();
    await prefetchMergedPRCounts(makeOctokit(graphql), "", REPOS);
    await prefetchMergedPRCounts(makeOctokit(graphql), "bad user!", REPOS);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("uses partial data on a GraphQL error: caches resolved, leaves errored cold", async () => {
    const err = Object.assign(new Error("Could not resolve"), {
      data: { viewer: VIEWER, r0: { issueCount: 2 }, r1: null },
    });
    const graphql = vi.fn().mockRejectedValue(err);
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS);

    expect(cacheStub.store.get(mergedPRsCacheKey("o1", "r1"))?.body).toBe(2);
    // The errored alias stays cold so the per-call REST path fetches it.
    expect(cacheStub.store.has(mergedPRsCacheKey("o2", "r2"))).toBe(false);
  });

  it("leaves the cache cold when the authenticated login differs from username", async () => {
    // getGitHubUsername() is stale/misconfigured: the token authenticates as
    // someone else. Trusting the author:${username} count would poison the
    // cache and suppress the authoritative REST author:@me query.
    const graphql = vi.fn().mockResolvedValue({
      viewer: { login: "different-account" },
      r0: { issueCount: 9 },
    });
    const search = vi.fn().mockResolvedValue({ data: { total_count: 4 } });
    const octokit = makeOctokit(graphql, search);

    await prefetchMergedPRCounts(octokit, "octocat", [
      { owner: "o1", repo: "r1" },
    ]);
    expect(cacheStub.set).not.toHaveBeenCalled();

    // The per-call path falls through to the authoritative REST @me query.
    const count = await checkUserMergedPRsInRepo(octokit, "o1", "r1");
    expect(count).toBe(4);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("matches the authenticated login case-insensitively", async () => {
    const graphql = vi.fn().mockResolvedValue({
      viewer: { login: "OctoCat" },
      r0: { issueCount: 6 },
    });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [
      { owner: "o1", repo: "r1" },
    ]);
    expect(cacheStub.set).toHaveBeenCalledWith(
      mergedPRsCacheKey("o1", "r1"),
      "",
      6,
    );
  });

  it("leaves the cache cold when viewer identity cannot be read", async () => {
    // A response missing viewer (e.g. dropped in a partial error) must not be
    // trusted — cache nothing and let REST answer.
    const graphql = vi.fn().mockResolvedValue({ r0: { issueCount: 3 } });
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", [
      { owner: "o1", repo: "r1" },
    ]);
    expect(cacheStub.set).not.toHaveBeenCalled();
  });

  it("caches nothing on a non-fatal error with no partial data", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS);
    expect(cacheStub.set).not.toHaveBeenCalled();
  });

  it("propagates a 401 auth error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("Bad credentials"), { status: 401 });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS),
    ).rejects.toThrow("Bad credentials");
  });

  it("propagates a rate-limit error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
    });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      prefetchMergedPRCounts(makeOctokit(graphql), "octocat", REPOS),
    ).rejects.toThrow("rate limit");
  });
});
