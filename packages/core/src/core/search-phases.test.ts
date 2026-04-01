import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueCandidate } from "./types.js";
import type { GitHubSearchItem } from "./issue-filtering.js";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  extractRepoFromUrl: (url: string) => {
    const api = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)/);
    if (api) return api[1];
    const web = url.match(/github\.com\/([^/]+\/[^/]+)/);
    return web ? web[1] : null;
  },
}));

vi.mock("./errors.js", () => ({
  errorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
  isRateLimitError: vi.fn(() => false),
  getHttpStatusCode: vi.fn(() => undefined),
}));

vi.mock("./search-budget.js", () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    waitForBudget: vi.fn().mockResolvedValue(undefined),
    recordCall: vi.fn(),
  })),
}));

// Mock http-cache: getHttpCache returns a stable mock with no-op caching by default.
const mockCache = {
  getIfFresh: vi.fn(() => null),
  set: vi.fn(),
};
vi.mock("./http-cache.js", () => ({
  getHttpCache: vi.fn(() => mockCache),
}));

vi.mock("./issue-filtering.js", () => ({
  detectLabelFarmingRepos: vi.fn(() => new Set<string>()),
}));

vi.mock("./issue-vetting.js", () => ({
  IssueVetter: vi.fn(),
}));

import {
  buildEffectiveLabels,
  interleaveArrays,
  cachedSearchIssues,
  fetchIssuesFromMaintainedRepos,
  searchWithChunkedLabels,
  filterVetAndScore,
  fetchIssuesFromKnownRepos,
  searchInRepos,
} from "./search-phases.js";
import { isRateLimitError } from "./errors.js";
import type { Octokit } from "@octokit/rest";
import type { IssueVetter } from "./issue-vetting.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeItem(url: string, repoFullName: string): GitHubSearchItem {
  return {
    html_url: url,
    repository_url: `https://api.github.com/repos/${repoFullName}`,
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function makeCandidate(
  url: string,
  stars: number,
  checkFailed = false,
): IssueCandidate {
  return {
    issue: {
      url,
      repo: "owner/repo",
      number: 1,
      title: "Test",
      labels: [],
      createdAt: "",
      updatedAt: "",
    },
    vettingResult: {
      recommendation: "approve",
      reasonsToApprove: [],
      reasonsToSkip: [],
      viabilityScore: 80,
    },
    projectHealth: {
      repo: "owner/repo",
      lastCommitAt: "",
      daysSinceLastCommit: 0,
      openIssuesCount: 0,
      avgIssueResponseDays: 0,
      ciStatus: "unknown",
      isActive: true,
      stargazersCount: stars,
      checkFailed,
    },
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 80,
    searchPriority: "normal",
  };
}

function makeMockOctokit(items: GitHubSearchItem[] = []): Octokit {
  return {
    search: {
      issuesAndPullRequests: vi
        .fn()
        .mockResolvedValue({ data: { total_count: items.length, items } }),
    },
  } as unknown as Octokit;
}

function makeMockVetter(
  candidates: IssueCandidate[],
  opts?: { allFailed?: boolean; rateLimitHit?: boolean },
) {
  return {
    vetIssuesParallel: vi.fn().mockResolvedValue({
      candidates,
      allFailed: opts?.allFailed ?? false,
      rateLimitHit: opts?.rateLimitHit ?? false,
    }),
  } as unknown as IssueVetter;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("buildEffectiveLabels", () => {
  it("returns beginner labels for single beginner scope", () => {
    const result = buildEffectiveLabels(["beginner"], []);
    expect(result).toEqual(
      expect.arrayContaining([
        "good first issue",
        "help wanted",
        "easy",
        "up-for-grabs",
        "first-timers-only",
        "beginner",
      ]),
    );
    expect(result).toHaveLength(6);
  });

  it("combines labels from multiple scopes", () => {
    const result = buildEffectiveLabels(["beginner", "intermediate"], []);
    // Should include labels from both scopes
    expect(result).toEqual(
      expect.arrayContaining(["good first issue", "enhancement"]),
    );
    expect(result).toHaveLength(10); // 6 beginner + 4 intermediate
  });

  it("merges custom labels with scope labels", () => {
    const result = buildEffectiveLabels(["beginner"], ["my-custom-label"]);
    expect(result).toContain("my-custom-label");
    expect(result).toContain("good first issue");
    expect(result).toHaveLength(7); // 6 beginner + 1 custom
  });

  it("deduplicates overlapping labels", () => {
    // 'good first issue' is already in beginner scope — passing it as custom should not double it
    const result = buildEffectiveLabels(["beginner"], ["good first issue"]);
    const occurrences = result.filter((l) => l === "good first issue");
    expect(occurrences).toHaveLength(1);
    expect(result).toHaveLength(6); // still 6, no duplication
  });
});

describe("interleaveArrays", () => {
  it("round-robins two equal-length arrays", () => {
    const result = interleaveArrays([
      ["a1", "a2", "a3"],
      ["b1", "b2", "b3"],
    ]);
    expect(result).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
  });

  it("handles unequal-length arrays (shorter stops, longer continues)", () => {
    const result = interleaveArrays([["a1", "a2", "a3"], ["b1"]]);
    expect(result).toEqual(["a1", "b1", "a2", "a3"]);
  });

  it("returns the other array when one is empty", () => {
    const result = interleaveArrays([[], ["b1", "b2"]]);
    expect(result).toEqual(["b1", "b2"]);
  });

  it("returns empty array when both are empty", () => {
    const result = interleaveArrays([[], []]);
    expect(result).toEqual([]);
  });
});

describe("cachedSearchIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls octokit search and returns results", async () => {
    const items = [
      makeItem("https://github.com/owner/repo/issues/1", "owner/repo"),
    ];
    const octokit = makeMockOctokit(items);

    const result = await cachedSearchIssues(octokit, {
      q: "is:issue is:open",
      sort: "created",
      order: "desc",
      per_page: 10,
    });

    expect(result.total_count).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].html_url).toBe(
      "https://github.com/owner/repo/issues/1",
    );
  });

  it("returns cached results on second call with same query", async () => {
    const items = [
      makeItem("https://github.com/owner/repo/issues/1", "owner/repo"),
    ];
    const octokit = makeMockOctokit(items);
    const cachedResult = { total_count: 1, items };

    // First call: cache miss, hits API, result gets cached (non-empty)
    mockCache.getIfFresh.mockReturnValueOnce(null);
    await cachedSearchIssues(octokit, {
      q: "test",
      sort: "created",
      order: "desc",
      per_page: 10,
    });
    expect(mockCache.set).toHaveBeenCalledTimes(1);

    // Second call: cache hit, returns cached result
    mockCache.getIfFresh.mockReturnValueOnce(cachedResult);
    const result2 = await cachedSearchIssues(octokit, {
      q: "test",
      sort: "created",
      order: "desc",
      per_page: 10,
    });

    expect(result2).toEqual(cachedResult);
    // octokit was only called once (second call returned cache)
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it("does not cache empty results to prevent rate-limit poisoning", async () => {
    const octokit = makeMockOctokit([]);

    await cachedSearchIssues(octokit, {
      q: "test",
      sort: "created",
      order: "desc",
      per_page: 10,
    });

    // Empty results should NOT be cached
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it("calls API again for a different query", async () => {
    const octokit = makeMockOctokit([]);

    await cachedSearchIssues(octokit, {
      q: "query-a",
      sort: "created",
      order: "desc",
      per_page: 10,
    });
    await cachedSearchIssues(octokit, {
      q: "query-b",
      sort: "created",
      order: "desc",
      per_page: 10,
    });

    // Different queries produce different cache keys, so API is called both times
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });
});

describe("searchInRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches 3 repos in a single batch", async () => {
    const items = [
      makeItem("https://github.com/a/b/issues/1", "a/b"),
      makeItem("https://github.com/c/d/issues/2", "c/d"),
    ];
    const octokit = makeMockOctokit(items);
    const candidates = [makeCandidate("https://github.com/a/b/issues/1", 100)];
    const vetter = makeMockVetter(candidates);

    const result = await searchInRepos(
      octokit,
      vetter,
      ["a/b", "c/d", "e/f"],
      "is:issue is:open",
      ["good first issue"],
      10,
      "normal",
      (items) => items,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.allBatchesFailed).toBe(false);
    // Only 1 batch of 3 repos — API called once per label chunk
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalled();
  });

  it("searches 6 repos in two batches", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const octokit = makeMockOctokit(items);
    const vetter = makeMockVetter([makeCandidate("url", 100)]);

    await searchInRepos(
      octokit,
      vetter,
      ["a/b", "c/d", "e/f", "g/h", "i/j", "k/l"],
      "is:issue is:open",
      ["good first issue"],
      10,
      "normal",
      (items) => items,
    );

    // 6 repos / BATCH_SIZE(3) = 2 batches, each calls the API at least once
    expect(
      (octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mock
        .calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("returns allBatchesFailed: true when all batches fail", async () => {
    const octokit = {
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockRejectedValue(new Error("API error")),
      },
    } as unknown as Octokit;

    const vetter = makeMockVetter([]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ["a/b", "c/d", "e/f"],
      "is:issue is:open",
      ["good first issue"],
      10,
      "normal",
      (items) => items,
    );

    expect(result.allBatchesFailed).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("returns partial results when some batches succeed", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    let callCount = 0;
    const octokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return { data: { total_count: 1, items } };
          throw new Error("API error"); // second batch fails
        }),
      },
    } as unknown as Octokit;
    const vetter = makeMockVetter([makeCandidate("url", 100)]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ["a/b", "c/d", "e/f", "g/h", "i/j", "k/l"],
      "is:issue is:open",
      [],
      10,
      "normal",
      (items) => items,
    );

    expect(result.allBatchesFailed).toBe(false);
    expect(result.candidates).toHaveLength(1);
  });

  it("sets rateLimitHit: true when rate limit error occurs", async () => {
    vi.mocked(isRateLimitError).mockReturnValue(true);

    const octokit = {
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockRejectedValue(new Error("rate limit")),
      },
    } as unknown as Octokit;
    const vetter = makeMockVetter([]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ["a/b"],
      "is:issue is:open",
      [],
      10,
      "normal",
      (items) => items,
    );

    expect(result.rateLimitHit).toBe(true);
  });
});

describe("filterVetAndScore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters out issues from excludedRepoSets", async () => {
    const items = [
      makeItem("https://github.com/excluded/repo/issues/1", "excluded/repo"),
      makeItem("https://github.com/good/repo/issues/2", "good/repo"),
    ];
    const excludedSet = new Set(["excluded/repo"]);
    const vetter = makeMockVetter([makeCandidate("url", 100)]);

    await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [excludedSet],
      10,
      0,
      "Phase2",
    );

    // Vetter should only receive the non-excluded issue
    const vetterCall = vi.mocked(vetter.vetIssuesParallel).mock.calls[0];
    expect(vetterCall[0]).toEqual(["https://github.com/good/repo/issues/2"]);
  });

  it("filters out low-star repos below minStars", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const lowStarCandidate = makeCandidate("url", 5); // 5 stars
    const vetter = makeMockVetter([lowStarCandidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      50, // minStars = 50
      "Phase2",
    );

    expect(result.candidates).toHaveLength(0); // filtered out because 5 < 50
  });

  it("keeps candidates with checkFailed regardless of star count", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const checkFailedCandidate = makeCandidate("url", 0, true); // 0 stars but checkFailed
    const vetter = makeMockVetter([checkFailedCandidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      50,
      "Phase2",
    );

    expect(result.candidates).toHaveLength(1); // kept despite 0 stars
  });

  it("vets remaining issues in parallel via vetter", async () => {
    const items = [
      makeItem("https://github.com/a/b/issues/1", "a/b"),
      makeItem("https://github.com/c/d/issues/2", "c/d"),
    ];
    const vetter = makeMockVetter([
      makeCandidate("url1", 100),
      makeCandidate("url2", 100),
    ]);

    await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      0,
      "Phase2",
    );

    expect(vetter.vetIssuesParallel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vetter.vetIssuesParallel).mock.calls[0][0]).toEqual([
      "https://github.com/a/b/issues/1",
      "https://github.com/c/d/issues/2",
    ]);
  });

  it("returns scored candidates from vetter", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const candidate = makeCandidate("url", 200);
    const vetter = makeMockVetter([candidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      0,
      "Phase2",
    );

    expect(result.candidates).toEqual([candidate]);
    expect(result.allVetFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
  });
});

function makeMockOctokitWithRest(
  issues: Array<{
    html_url: string;
    updated_at: string;
    title: string;
    labels: Array<{ name?: string } | string>;
  }> = [],
) {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: issues }),
    },
    search: {
      issuesAndPullRequests: vi
        .fn()
        .mockResolvedValue({ data: { total_count: 0, items: [] } }),
    },
  } as unknown as Octokit;
}

function makeRestIssue(
  repoFullName: string,
  number: number,
  opts?: { title?: string; labels?: Array<{ name?: string } | string> },
) {
  return {
    html_url: `https://github.com/${repoFullName}/issues/${number}`,
    updated_at: "2026-01-01T00:00:00Z",
    title: opts?.title ?? `Issue ${number}`,
    labels: opts?.labels ?? [],
  };
}

describe("fetchIssuesFromKnownRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches issues from multiple repos", async () => {
    const issues = [makeRestIssue("a/b", 1), makeRestIssue("a/b", 2)];
    const octokit = makeMockOctokitWithRest(issues);
    const candidate1 = makeCandidate("https://github.com/a/b/issues/1", 100);
    const candidate2 = makeCandidate("https://github.com/c/d/issues/1", 100);
    const vetter = {
      vetIssuesParallel: vi
        .fn()
        .mockResolvedValueOnce({
          candidates: [candidate1],
          allFailed: false,
          rateLimitHit: false,
        })
        .mockResolvedValueOnce({
          candidates: [candidate2],
          allFailed: false,
          rateLimitHit: false,
        }),
    } as unknown as IssueVetter;

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b", "c/d"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.allReposFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
    // Should call listForRepo for each repo
    expect(
      (
        octokit as unknown as {
          issues: { listForRepo: ReturnType<typeof vi.fn> };
        }
      ).issues.listForRepo,
    ).toHaveBeenCalledTimes(2);
    // Vetter called once per repo
    expect(vetter.vetIssuesParallel).toHaveBeenCalledTimes(2);
  });

  it("handles empty results", async () => {
    const octokit = makeMockOctokitWithRest([]);
    const vetter = makeMockVetter([]);

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.allReposFailed).toBe(false);
    // Vetter should not be called when there are no issues
    expect(vetter.vetIssuesParallel).not.toHaveBeenCalled();
  });

  it("handles per-repo errors gracefully", async () => {
    const octokit = {
      issues: {
        listForRepo: vi
          .fn()
          .mockResolvedValueOnce({
            data: [makeRestIssue("a/b", 1)],
          })
          .mockRejectedValueOnce(new Error("404 Not Found")),
      },
      search: {
        issuesAndPullRequests: vi.fn(),
      },
    } as unknown as Octokit;
    const candidates = [makeCandidate("https://github.com/a/b/issues/1", 100)];
    const vetter = makeMockVetter(candidates);

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b", "c/d"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    // Should still return results from the repo that succeeded
    expect(result.candidates).toHaveLength(1);
    expect(result.allReposFailed).toBe(false);
  });

  it("stops when maxResults reached", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [makeRestIssue("a/b", 1)],
        }),
      },
      search: {
        issuesAndPullRequests: vi.fn(),
      },
    } as unknown as Octokit;
    const candidates = [makeCandidate("https://github.com/a/b/issues/1", 100)];
    const vetter = makeMockVetter(candidates);

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b", "c/d", "e/f"],
      [],
      1, // maxResults = 1
      "merged_pr",
      (items) => items,
    );

    expect(result.candidates).toHaveLength(1);
    // Should only call listForRepo once since maxResults was reached after first repo
    expect(
      (
        octokit as unknown as {
          issues: { listForRepo: ReturnType<typeof vi.fn> };
        }
      ).issues.listForRepo,
    ).toHaveBeenCalledTimes(1);
  });

  it("applies filter function", async () => {
    const issues = [makeRestIssue("a/b", 1), makeRestIssue("a/b", 2)];
    const octokit = makeMockOctokitWithRest(issues);
    const vetter = makeMockVetter([]);

    await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b"],
      [],
      10,
      "merged_pr",
      // Filter that removes all items
      () => [],
    );

    // Vetter should not be called because filter removed all items
    expect(vetter.vetIssuesParallel).not.toHaveBeenCalled();
  });

  it("returns allReposFailed: true when all repos fail", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockRejectedValue(new Error("API error")),
      },
      search: {
        issuesAndPullRequests: vi.fn(),
      },
    } as unknown as Octokit;
    const vetter = makeMockVetter([]);

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b", "c/d"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    expect(result.allReposFailed).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it("tracks rateLimitHit", async () => {
    vi.mocked(isRateLimitError).mockReturnValue(true);

    const octokit = {
      issues: {
        listForRepo: vi.fn().mockRejectedValue(new Error("rate limit")),
      },
      search: {
        issuesAndPullRequests: vi.fn(),
      },
    } as unknown as Octokit;
    const vetter = makeMockVetter([]);

    const result = await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["a/b"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    expect(result.rateLimitHit).toBe(true);
  });

  it("passes labels as comma-joined string to listForRepo", async () => {
    const octokit = makeMockOctokitWithRest([]);
    const vetter = makeMockVetter([]);

    await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["owner/repo"],
      ["good first issue", "help wanted"],
      10,
      "starred",
      (items) => items,
    );

    expect(
      (
        octokit as unknown as {
          issues: { listForRepo: ReturnType<typeof vi.fn> };
        }
      ).issues.listForRepo,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "owner",
        repo: "repo",
        state: "open",
        labels: "good first issue,help wanted",
      }),
    );
  });

  it("omits labels param when labels array is empty", async () => {
    const octokit = makeMockOctokitWithRest([]);
    const vetter = makeMockVetter([]);

    await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      ["owner/repo"],
      [],
      10,
      "merged_pr",
      (items) => items,
    );

    const call = (
      octokit as unknown as {
        issues: { listForRepo: ReturnType<typeof vi.fn> };
      }
    ).issues.listForRepo.mock.calls[0][0];
    expect(call).not.toHaveProperty("labels");
  });
});

describe("searchWithChunkedLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCache.getIfFresh.mockReturnValue(null);
  });

  it("issues a single query when labels fit within operator limit", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const octokit = makeMockOctokit(items);

    const result = await searchWithChunkedLabels(
      octokit,
      ["good first issue", "help wanted"], // 2 labels, 1 OR op — well within limit
      0,
      (labelQ) => `is:issue is:open ${labelQ}`,
      10,
    );

    expect(result).toHaveLength(1);
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it("chunks labels into multiple queries when exceeding operator limit", async () => {
    const items = [makeItem("https://github.com/a/b/issues/1", "a/b")];
    const octokit = makeMockOctokit(items);

    // With reservedOps=0, maxPerChunk = 5 - 0 + 1 = 6. So 8 labels → 2 chunks.
    const labels = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];

    await searchWithChunkedLabels(
      octokit,
      labels,
      0,
      (labelQ) => `is:issue ${labelQ}`,
      10,
    );

    expect(
      (octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mock
        .calls.length,
    ).toBe(2);
  });

  it("deduplicates results across chunks", async () => {
    const sharedItem = makeItem("https://github.com/a/b/issues/1", "a/b");
    const uniqueItem = makeItem("https://github.com/c/d/issues/2", "c/d");

    let callCount = 0;
    const octokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1)
            return { data: { total_count: 1, items: [sharedItem] } };
          return {
            data: { total_count: 2, items: [sharedItem, uniqueItem] },
          };
        }),
      },
    } as unknown as Octokit;

    // Force 2 chunks: reservedOps=4, so maxPerChunk = 5-4+1 = 2. 3 labels → 2 chunks.
    const result = await searchWithChunkedLabels(
      octokit,
      ["l1", "l2", "l3"],
      4,
      (labelQ) => `is:issue ${labelQ}`,
      10,
    );

    expect(result).toHaveLength(2); // deduplicated: sharedItem appears once
    expect(result[0].html_url).toBe("https://github.com/a/b/issues/1");
    expect(result[1].html_url).toBe("https://github.com/c/d/issues/2");
  });
});

describe("fetchIssuesFromMaintainedRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMockOctokitForRest(opts: {
    repoData?: {
      pushed_at: string;
      stargazers_count: number;
      archived: boolean;
    };
    issues?: Array<{
      html_url: string;
      updated_at: string;
      title: string;
      labels: Array<{ name?: string } | string>;
      pull_request?: unknown;
    }>;
    repoError?: Error;
  }): Octokit {
    return {
      repos: {
        get: opts.repoError
          ? vi.fn().mockRejectedValue(opts.repoError)
          : vi.fn().mockResolvedValue({
              data: opts.repoData ?? {
                pushed_at: new Date().toISOString(),
                stargazers_count: 200,
                archived: false,
              },
            }),
      },
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: opts.issues ?? [],
        }),
      },
    } as unknown as Octokit;
  }

  it("fetches issues from actively maintained repos", async () => {
    const octokit = makeMockOctokitForRest({
      repoData: {
        pushed_at: new Date().toISOString(),
        stargazers_count: 200,
        archived: false,
      },
      issues: [
        {
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2026-01-01T00:00:00Z",
          title: "Fix bug",
          labels: [{ name: "bug" }],
        },
      ],
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo"],
      50,
      10,
    );

    expect(result).toHaveLength(1);
    expect(result[0].html_url).toBe("https://github.com/owner/repo/issues/1");
    expect(result[0].repository_url).toBe(
      "https://api.github.com/repos/owner/repo",
    );
    expect(result[0].title).toBe("Fix bug");
  });

  it("skips repos that were pushed more than 30 days ago", async () => {
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const octokit = makeMockOctokitForRest({
      repoData: {
        pushed_at: sixtyDaysAgo.toISOString(),
        stargazers_count: 200,
        archived: false,
      },
      issues: [
        {
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2026-01-01T00:00:00Z",
          title: "Bug",
          labels: [],
        },
      ],
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo"],
      50,
      10,
    );

    expect(result).toHaveLength(0);
  });

  it("skips repos below minimum star threshold", async () => {
    const octokit = makeMockOctokitForRest({
      repoData: {
        pushed_at: new Date().toISOString(),
        stargazers_count: 10,
        archived: false,
      },
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo"],
      50, // minStars = 50, repo has 10
      10,
    );

    expect(result).toHaveLength(0);
  });

  it("skips archived repos", async () => {
    const octokit = makeMockOctokitForRest({
      repoData: {
        pushed_at: new Date().toISOString(),
        stargazers_count: 200,
        archived: true,
      },
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo"],
      50,
      10,
    );

    expect(result).toHaveLength(0);
  });

  it("filters out pull requests from the issues endpoint", async () => {
    const octokit = makeMockOctokitForRest({
      issues: [
        {
          html_url: "https://github.com/owner/repo/issues/1",
          updated_at: "2026-01-01T00:00:00Z",
          title: "Real issue",
          labels: [],
        },
        {
          html_url: "https://github.com/owner/repo/pull/2",
          updated_at: "2026-01-01T00:00:00Z",
          title: "A pull request",
          labels: [],
          pull_request: {
            url: "https://api.github.com/repos/owner/repo/pulls/2",
          },
        },
      ],
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo"],
      50,
      10,
    );

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real issue");
  });

  it("handles API errors gracefully and continues", async () => {
    const octokit = makeMockOctokitForRest({
      repoError: new Error("Not Found"),
    });

    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["bad/repo"],
      50,
      10,
    );

    expect(result).toHaveLength(0);
  });

  it("stops fetching when maxResults * 3 items are collected", async () => {
    // Create an octokit that returns 4 issues per repo
    const makeIssues = (repoName: string) =>
      Array.from({ length: 4 }, (_, i) => ({
        html_url: `https://github.com/${repoName}/issues/${i + 1}`,
        updated_at: "2026-01-01T00:00:00Z",
        title: `Issue ${i + 1}`,
        labels: [],
      }));

    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: {
            pushed_at: new Date().toISOString(),
            stargazers_count: 200,
            archived: false,
          },
        }),
      },
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: makeIssues("owner/repo"),
        }),
      },
    } as unknown as Octokit;

    // maxResults=1, so cap is 1*3=3 items
    const result = await fetchIssuesFromMaintainedRepos(
      octokit,
      ["owner/repo1", "owner/repo2", "owner/repo3"],
      50,
      1,
    );

    // Should stop after collecting >= 3 items (cap is maxResults * 3)
    expect(result.length).toBeLessThanOrEqual(4); // first repo yields 4, then stops
    expect(
      (octokit.repos.get as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });
});
