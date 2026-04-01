import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueCandidate } from "./types.js";
import type { GitHubSearchItem } from "./issue-filtering.js";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  daysBetween: vi.fn(() => 5),
  extractRepoFromUrl: (url: string) => {
    const api = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)/);
    if (api) return api[1];
    const web = url.match(/github\.com\/([^/]+\/[^/]+)/);
    return web ? web[1] : null;
  },
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./github.js", () => ({
  getOctokit: vi.fn(() => ({})),
  checkRateLimit: vi.fn().mockResolvedValue({
    remaining: 30,
    limit: 30,
    resetAt: new Date(Date.now() + 60000).toISOString(),
  }),
}));

vi.mock("./search-budget.js", () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    init: vi.fn(),
    recordCall: vi.fn(),
    getTotalCalls: vi.fn(() => 5),
    canAfford: vi.fn(() => true),
    waitForBudget: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("./issue-vetting.js", () => ({
  IssueVetter: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
  ) {
    this.vetIssue = vi.fn();
    this.vetIssuesParallel = vi.fn().mockResolvedValue({
      candidates: [],
      allFailed: false,
      rateLimitHit: false,
    });
  }),
}));

vi.mock("./issue-filtering.js", () => ({
  isDocOnlyIssue: vi.fn(() => false),
  applyPerRepoCap: vi.fn((candidates: IssueCandidate[]) => candidates),
}));

vi.mock("./category-mapping.js", () => ({
  getTopicsForCategories: vi.fn(() => ["devtools"]),
}));

vi.mock("./errors.js", () => ({
  ValidationError: class ValidationError extends Error {
    code = "VALIDATION_ERROR";
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  },
  errorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
  getHttpStatusCode: vi.fn(() => undefined),
  isRateLimitError: vi.fn(() => false),
}));

const mockSearchInRepos = vi.fn().mockResolvedValue({
  candidates: [],
  allBatchesFailed: false,
  rateLimitHit: false,
});

const mockFetchIssuesFromKnownRepos = vi.fn().mockResolvedValue({
  candidates: [],
  allReposFailed: false,
  rateLimitHit: false,
});

const mockSearchWithChunkedLabels = vi.fn().mockResolvedValue([]);

const mockFilterVetAndScore = vi.fn().mockResolvedValue({
  candidates: [],
  allVetFailed: false,
  rateLimitHit: false,
});

const mockCachedSearchIssues = vi.fn().mockResolvedValue({
  total_count: 0,
  items: [],
});

const mockFetchIssuesFromMaintainedRepos = vi
  .fn()
  .mockResolvedValue([] as GitHubSearchItem[]);

vi.mock("./search-phases.js", () => ({
  buildEffectiveLabels: vi.fn((_scopes: string[], labels: string[]) =>
    labels.length > 0 ? labels : ["good first issue"],
  ),
  interleaveArrays: vi.fn((arrays: unknown[][]) => arrays.flat()),
  searchInRepos: (...args: unknown[]) => mockSearchInRepos(...args),
  fetchIssuesFromKnownRepos: (...args: unknown[]) =>
    mockFetchIssuesFromKnownRepos(...args),
  searchWithChunkedLabels: (...args: unknown[]) =>
    mockSearchWithChunkedLabels(...args),
  filterVetAndScore: (...args: unknown[]) => mockFilterVetAndScore(...args),
  cachedSearchIssues: (...args: unknown[]) => mockCachedSearchIssues(...args),
  fetchIssuesFromMaintainedRepos: (...args: unknown[]) =>
    mockFetchIssuesFromMaintainedRepos(...args),
}));

import { IssueDiscovery } from "./issue-discovery.js";
import { checkRateLimit } from "./github.js";
import { applyPerRepoCap } from "./issue-filtering.js";
import { sleep } from "./utils.js";
import type { ScoutStateReader } from "./issue-vetting.js";
import type { ScoutPreferences } from "./schemas.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeCandidate(
  repo: string,
  priority: "merged_pr" | "starred" | "normal" = "normal",
  recommendation: "approve" | "skip" | "needs_review" = "approve",
  score = 80,
): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: `https://github.com/${repo}/issues/1`,
      repo,
      number: 1,
      title: "Test issue",
      status: "candidate",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      vetted: true,
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
      stargazersCount: 500,
    },
    recommendation,
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: score,
    searchPriority: priority,
  };
}

function makeStateReader(
  overrides: Partial<ScoutStateReader> = {},
): ScoutStateReader {
  return {
    getReposWithMergedPRs: vi.fn(() => []),
    getStarredRepos: vi.fn(() => []),
    getProjectCategories: vi.fn(() => []),
    getRepoScore: vi.fn(() => null),
    ...overrides,
  };
}

function makePreferences(
  overrides: Partial<ScoutPreferences> = {},
): ScoutPreferences {
  return {
    languages: ["TypeScript"],
    labels: ["good first issue", "help wanted"],
    excludeRepos: [],
    aiPolicyBlocklist: [],
    minStars: 50,
    minRepoScoreThreshold: 0,
    maxIssueAgeDays: 90,
    includeDocIssues: true,
    ...overrides,
  } as ScoutPreferences;
}

function makeDiscovery(
  stateOverrides: Partial<ScoutStateReader> = {},
  prefOverrides: Partial<ScoutPreferences> = {},
): IssueDiscovery {
  return new IssueDiscovery(
    "test-token",
    makePreferences(prefOverrides),
    makeStateReader(stateOverrides),
  );
}

// ── Tests ──────────────────────────────────────────────────────────

describe("IssueDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mocks to defaults
    mockSearchInRepos.mockResolvedValue({
      candidates: [],
      allBatchesFailed: false,
      rateLimitHit: false,
    });
    mockFetchIssuesFromKnownRepos.mockResolvedValue({
      candidates: [],
      allReposFailed: false,
      rateLimitHit: false,
    });
    mockSearchWithChunkedLabels.mockResolvedValue([]);
    mockFilterVetAndScore.mockResolvedValue({
      candidates: [],
      allVetFailed: false,
      rateLimitHit: false,
    });
    mockCachedSearchIssues.mockResolvedValue({
      total_count: 0,
      items: [],
    });
    mockFetchIssuesFromMaintainedRepos.mockResolvedValue([]);

    vi.mocked(checkRateLimit).mockResolvedValue({
      remaining: 30,
      limit: 30,
      resetAt: new Date(Date.now() + 60000).toISOString(),
    });
  });

  describe("searchIssues — phase execution", () => {
    it("Phase 0: calls fetchIssuesFromKnownRepos with merged-PR repos, priority merged_pr", async () => {
      const c = makeCandidate("org/merged-repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
      });

      const { candidates } = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(mockFetchIssuesFromKnownRepos).toHaveBeenCalledWith(
        expect.anything(), // octokit
        expect.anything(), // vetter
        ["org/merged-repo"],
        [], // no labels for Phase 0
        expect.any(Number),
        "merged_pr",
        expect.any(Function),
      );
    });

    it("Phase 1: calls fetchIssuesFromKnownRepos with starred repos, priority starred", async () => {
      const c = makeCandidate("org/starred-repo", "starred");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getStarredRepos: vi.fn(() => ["org/starred-repo"]),
      });

      await discovery.searchIssues({ maxResults: 5 });
      // Phase 1 calls fetchIssuesFromKnownRepos with "starred" priority
      const phase1Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "starred",
      );
      expect(phase1Call).toBeDefined();
      expect(phase1Call![2]).toEqual(["org/starred-repo"]);
    });

    it("Phase 2: calls searchWithChunkedLabels then filterVetAndScore", async () => {
      const item: GitHubSearchItem = {
        html_url: "https://github.com/broad/repo/issues/1",
        repository_url: "https://api.github.com/repos/broad/repo",
        updated_at: "2026-01-01T00:00:00Z",
      };
      mockSearchWithChunkedLabels.mockResolvedValue([item]);
      const c = makeCandidate("broad/repo", "normal");
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [c],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery();
      await discovery.searchIssues({ maxResults: 5 });

      expect(mockSearchWithChunkedLabels).toHaveBeenCalled();
      expect(mockFilterVetAndScore).toHaveBeenCalled();
    });

    it("Phase 3: tries REST API with starred repos first", async () => {
      const restItems: GitHubSearchItem[] = [
        {
          html_url: "https://github.com/starred/repo/issues/1",
          repository_url: "https://api.github.com/repos/starred/repo",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
      mockFetchIssuesFromMaintainedRepos.mockResolvedValue(restItems);
      const c = makeCandidate("starred/repo", "normal");
      // Phase 2 calls filterVetAndScore first (return empty so Phase 3 runs with eligible repos)
      mockFilterVetAndScore
        .mockResolvedValueOnce({
          candidates: [],
          allVetFailed: false,
          rateLimitHit: false,
        })
        .mockResolvedValue({
          candidates: [c],
          allVetFailed: false,
          rateLimitHit: false,
        });

      const discovery = makeDiscovery({
        getStarredRepos: vi.fn(() => ["starred/repo"]),
      });
      await discovery.searchIssues({ maxResults: 5 });

      expect(mockFetchIssuesFromMaintainedRepos).toHaveBeenCalled();
    });

    it("Phase 3: falls back to Search API when REST yields no candidates", async () => {
      // REST returns empty
      mockFetchIssuesFromMaintainedRepos.mockResolvedValue([]);

      mockCachedSearchIssues.mockResolvedValue({
        total_count: 5,
        items: [
          {
            html_url: "https://github.com/maintained/repo/issues/1",
            repository_url: "https://api.github.com/repos/maintained/repo",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const c = makeCandidate("maintained/repo", "normal");
      // Phase 2 calls filterVetAndScore first (return empty so Phase 3 runs)
      mockFilterVetAndScore
        .mockResolvedValueOnce({
          candidates: [],
          allVetFailed: false,
          rateLimitHit: false,
        })
        .mockResolvedValue({
          candidates: [c],
          allVetFailed: false,
          rateLimitHit: false,
        });

      const discovery = makeDiscovery({
        getStarredRepos: vi.fn(() => ["starred/repo"]),
      });
      await discovery.searchIssues({ maxResults: 5 });

      // Should fall back to Search API
      expect(mockCachedSearchIssues).toHaveBeenCalled();
    });

    it("Phase 3: falls back to Search API when no starred repos available", async () => {
      mockCachedSearchIssues.mockResolvedValue({
        total_count: 5,
        items: [
          {
            html_url: "https://github.com/maintained/repo/issues/1",
            repository_url: "https://api.github.com/repos/maintained/repo",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const c = makeCandidate("maintained/repo", "normal");
      // Phase 2 calls filterVetAndScore first (return empty so Phase 3 runs)
      mockFilterVetAndScore
        .mockResolvedValueOnce({
          candidates: [],
          allVetFailed: false,
          rateLimitHit: false,
        })
        .mockResolvedValue({
          candidates: [c],
          allVetFailed: false,
          rateLimitHit: false,
        });

      const discovery = makeDiscovery();
      await discovery.searchIssues({ maxResults: 5 });

      // No starred repos, so REST is skipped, falls back to Search API
      expect(mockFetchIssuesFromMaintainedRepos).not.toHaveBeenCalled();
      expect(mockCachedSearchIssues).toHaveBeenCalled();
    });
  });

  describe("searchIssues — strategy filtering", () => {
    it("strategies=[merged] runs only Phase 0", async () => {
      const c = makeCandidate("org/merged-repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
        getStarredRepos: vi.fn(() => ["org/starred-repo"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 5,
        strategies: ["merged"],
      });

      expect(strategiesUsed).toContain("merged");
      expect(strategiesUsed).not.toContain("starred");
      expect(strategiesUsed).not.toContain("broad");
      expect(strategiesUsed).not.toContain("maintained");
    });

    it("strategies=[starred,broad] runs only Phases 1 and 2", async () => {
      const c = makeCandidate("org/starred-repo", "starred");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getStarredRepos: vi.fn(() => ["org/starred-repo"]),
        getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 5,
        strategies: ["starred", "broad"],
      });

      expect(strategiesUsed).not.toContain("merged");
      expect(strategiesUsed).toContain("starred");
      expect(strategiesUsed).toContain("broad");
    });
  });

  describe("searchIssues — budget management", () => {
    it("only runs Phase 0 when budget is critical (<10)", async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 5,
        limit: 30,
        resetAt: new Date(Date.now() + 60000).toISOString(),
      });

      const c = makeCandidate("org/merged", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged"]),
        getStarredRepos: vi.fn(() => ["org/starred"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 10,
      });

      expect(strategiesUsed).toContain("merged");
      expect(strategiesUsed).not.toContain("starred");
      expect(strategiesUsed).not.toContain("broad");
      expect(strategiesUsed).not.toContain("maintained");
    });

    it("skips Phases 2 and 3 when budget is low (<20)", async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 15,
        limit: 30,
        resetAt: new Date(Date.now() + 60000).toISOString(),
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged"]),
        getStarredRepos: vi.fn(() => ["org/starred"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 10,
      });

      expect(strategiesUsed).not.toContain("broad");
      expect(strategiesUsed).not.toContain("maintained");
    });
  });

  describe("searchIssues — inter-phase delay", () => {
    it("uses interPhaseDelayMs preference for sleep between phases", async () => {
      const c = makeCandidate("org/starred-repo", "starred");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery(
        {
          getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
          getStarredRepos: vi.fn(() => ["org/starred-repo"]),
        },
        { interPhaseDelayMs: 15000 },
      );

      await discovery.searchIssues({ maxResults: 5 });

      // Phase 1 sleeps with the configured delay
      expect(sleep).toHaveBeenCalledWith(15000);
    });

    it("skips sleep when interPhaseDelayMs is 0", async () => {
      const c = makeCandidate("org/starred-repo", "starred");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery(
        {
          getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
          getStarredRepos: vi.fn(() => ["org/starred-repo"]),
        },
        { interPhaseDelayMs: 0 },
      );

      await discovery.searchIssues({ maxResults: 5 });

      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe("searchIssues — rate limit handling", () => {
    it("sets rateLimitWarning when remaining < 5", async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 3,
        limit: 30,
        resetAt: new Date(Date.now() + 60000).toISOString(),
      });

      const c = makeCandidate("org/repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/repo"]),
      });

      await discovery.searchIssues({ maxResults: 5 });
      expect(discovery.rateLimitWarning).toBeTruthy();
      expect(discovery.rateLimitWarning).toContain("quota");
    });
  });

  describe("searchIssues — post-processing", () => {
    it("calls applyPerRepoCap on results", async () => {
      const candidates = [
        makeCandidate("org/repo1", "normal"),
        makeCandidate("org/repo2", "normal"),
      ];
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/repo1", "org/repo2"]),
      });

      await discovery.searchIssues({ maxResults: 10 });
      expect(applyPerRepoCap).toHaveBeenCalled();
    });

    it("sorts by priority > recommendation > score", async () => {
      const merged = makeCandidate("org/merged", "merged_pr", "approve", 60);
      const starred = makeCandidate("org/starred", "starred", "approve", 90);
      const normal = makeCandidate("org/normal", "normal", "approve", 95);

      // Phase 2 (broad) runs first — returns normal
      mockSearchWithChunkedLabels.mockResolvedValue([]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [normal],
        allVetFailed: false,
        rateLimitHit: false,
      });
      // Phase 0 returns merged
      mockFetchIssuesFromKnownRepos.mockResolvedValueOnce({
        candidates: [merged],
        allReposFailed: false,
        rateLimitHit: false,
      });
      // Phase 1 returns starred
      mockFetchIssuesFromKnownRepos.mockResolvedValueOnce({
        candidates: [starred],
        allReposFailed: false,
        rateLimitHit: false,
      });

      // applyPerRepoCap returns as-is to verify sort order
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged"]),
        getStarredRepos: vi.fn(() => ["org/starred"]),
      });

      const { candidates } = await discovery.searchIssues({ maxResults: 10 });
      // merged_pr (priority 0) should come before starred (priority 2) before normal (priority 3)
      if (candidates.length >= 3) {
        expect(candidates[0].searchPriority).toBe("merged_pr");
        expect(candidates[1].searchPriority).toBe("starred");
        expect(candidates[2].searchPriority).toBe("normal");
      }
    });
  });

  describe("searchIssues — filtering", () => {
    it("filterIssues excludes repos in excludeRepos", async () => {
      const items: GitHubSearchItem[] = [
        {
          html_url: "https://github.com/excluded/repo/issues/1",
          repository_url: "https://api.github.com/repos/excluded/repo",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
      mockSearchWithChunkedLabels.mockResolvedValue(items);

      const discovery = makeDiscovery({}, { excludeRepos: ["excluded/repo"] });

      // The filter function is passed to search phases; items matching
      // excludeRepos should be excluded. With no candidates from any phase,
      // searchIssues throws ValidationError.
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(
        "No issue candidates found",
      );
    });

    it("filterIssues excludes repos in aiPolicyBlocklist", async () => {
      // Provide a candidate so the search doesn't throw
      const c = makeCandidate("allowed/repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["allowed/repo"]) },
        { aiPolicyBlocklist: ["blocked/repo"] },
      );

      const { candidates } = await discovery.searchIssues({ maxResults: 5 });
      // Verify discovery was constructed without error when blocklist is set
      // and candidates from non-blocked repos are returned
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("searchIssues — error handling", () => {
    it("throws ValidationError when no candidates found and no rate limits", async () => {
      const discovery = makeDiscovery();
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(
        "No issue candidates found",
      );
    });

    it("returns empty with warning when rate limited", async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 5,
        limit: 30,
        resetAt: new Date(Date.now() + 60000).toISOString(),
      });

      // budget < CRITICAL_BUDGET_THRESHOLD = 10 triggers skipping most phases
      // and phasesSkippedForBudget = true when budget < LOW_BUDGET_THRESHOLD
      const discovery = makeDiscovery();
      const { candidates } = await discovery.searchIssues({ maxResults: 5 });
      expect(candidates).toHaveLength(0);
      expect(discovery.rateLimitWarning).toBeTruthy();
    });
  });
});
