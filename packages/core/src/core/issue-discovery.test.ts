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
    constructor(
      message: string,
      public readonly strategiesUsed?: string[],
    ) {
      super(message);
      this.name = "ValidationError";
    }
  },
  errorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
  getHttpStatusCode: vi.fn((e: unknown) => {
    if (e && typeof e === "object" && "status" in e) {
      const s = (e as { status: unknown }).status;
      return typeof s === "number" ? s : undefined;
    }
    return undefined;
  }),
  isRateLimitError: vi.fn((e: unknown) => {
    if (e && typeof e === "object" && "status" in e) {
      const s = (e as { status: unknown }).status;
      if (s === 429) return true;
      if (
        s === 403 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("rate limit")
      ) {
        return true;
      }
    }
    return false;
  }),
}));

const mockFetchIssuesFromKnownRepos = vi.fn().mockResolvedValue({
  candidates: [],
  allReposFailed: false,
  rateLimitHit: false,
});

const mockSearchAcrossLanguagesAndLabels = vi.fn().mockResolvedValue([]);

const mockFilterVetAndScore = vi.fn().mockResolvedValue({
  candidates: [],
  allVetFailed: false,
  rateLimitHit: false,
});

const mockSearchIssuesGraphQLFirst = vi.fn().mockResolvedValue({
  total_count: 0,
  items: [],
});

const mockFetchIssuesFromMaintainedRepos = vi
  .fn()
  .mockResolvedValue([] as GitHubSearchItem[]);

let mockGraphqlSearchQueryCount = 0;

vi.mock("./search-phases.js", () => ({
  buildEffectiveLabels: vi.fn((_scopes: string[], labels: string[]) =>
    labels.length > 0 ? labels : ["good first issue"],
  ),
  interleaveArrays: vi.fn((arrays: unknown[][]) => arrays.flat()),
  fetchIssuesFromKnownRepos: (...args: unknown[]) =>
    mockFetchIssuesFromKnownRepos(...args),
  searchAcrossLanguagesAndLabels: (...args: unknown[]) =>
    mockSearchAcrossLanguagesAndLabels(...args),
  filterVetAndScore: (...args: unknown[]) => mockFilterVetAndScore(...args),
  searchIssuesGraphQLFirst: (...args: unknown[]) =>
    mockSearchIssuesGraphQLFirst(...args),
  fetchIssuesFromMaintainedRepos: (...args: unknown[]) =>
    mockFetchIssuesFromMaintainedRepos(...args),
  getGraphQLSearchQueryCount: () => mockGraphqlSearchQueryCount,
  resetGraphQLSearchQueryCount: () => {
    mockGraphqlSearchQueryCount = 0;
  },
}));

import { IssueDiscovery } from "./issue-discovery.js";
import { checkRateLimit } from "./github.js";
import { applyPerRepoCap } from "./issue-filtering.js";
import { sleep, daysBetween } from "./utils.js";
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
    getReposWithOpenPRs: vi.fn(() => []),
    getStarredRepos: vi.fn(() => []),
    getProjectCategories: vi.fn(() => []),
    getRepoScore: vi.fn(() => null),
    getSLMTriageConfig: vi.fn(() => null),
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

/** Minimal SearchBudgetTracker stand-in for injection assertions. */
function makeFakeTracker() {
  return {
    init: vi.fn(),
    recordCall: vi.fn(),
    getTotalCalls: vi.fn(() => 7),
    canAfford: vi.fn(() => true),
    waitForBudget: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("IssueDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mocks to defaults
    mockFetchIssuesFromKnownRepos.mockResolvedValue({
      candidates: [],
      allReposFailed: false,
      rateLimitHit: false,
    });
    mockSearchAcrossLanguagesAndLabels.mockResolvedValue([]);
    mockFilterVetAndScore.mockResolvedValue({
      candidates: [],
      allVetFailed: false,
      rateLimitHit: false,
    });
    mockSearchIssuesGraphQLFirst.mockResolvedValue({
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
        30, // PHASE0_PER_PAGE — deeper than the default 5 so the backlog is reachable
      );
    });

    it("Phase 0: uses a relaxed age filter that admits issues older than the default 90-day cutoff", async () => {
      const c = makeCandidate("org/merged-repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
      });

      await discovery.searchIssues({ maxResults: 5 });

      // The 7th positional arg is the filter function passed to Phase 0.
      const phase0Filter = mockFetchIssuesFromKnownRepos.mock.calls[0][6] as (
        items: GitHubSearchItem[],
      ) => GitHubSearchItem[];

      // utils.daysBetween is globally stubbed to 5 in this file; use the real
      // day math so the age window is actually exercised, then restore.
      vi.mocked(daysBetween).mockImplementation(
        (from: Date, to: Date = new Date()) =>
          Math.max(
            0,
            Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)),
          ),
      );
      try {
        const daysAgo = (n: number): string =>
          new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
        const item = (updatedAt: string): GitHubSearchItem => ({
          html_url: "https://github.com/org/merged-repo/issues/1",
          repository_url: "https://api.github.com/repos/org/merged-repo",
          updated_at: updatedAt,
          title: "An older but still-open issue",
          labels: [],
        });

        // 150 days old: rejected by the default 90-day filter, admitted by Phase 0.
        expect(phase0Filter([item(daysAgo(150))])).toHaveLength(1);
        // Beyond the relaxed 365-day window it is still excluded.
        expect(phase0Filter([item(daysAgo(400))])).toHaveLength(0);
      } finally {
        vi.mocked(daysBetween).mockReturnValue(5);
      }
    });

    it("Phase 0: unions merged-PR and open-PR repos, deduped, merged first", async () => {
      const c = makeCandidate("org/merged-a", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged-a", "org/shared"]),
        getReposWithOpenPRs: vi.fn(() => ["org/shared", "org/open-only"]),
      });

      await discovery.searchIssues({ maxResults: 5 });

      const phase0Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "merged_pr",
      );
      expect(phase0Call).toBeDefined();
      expect(phase0Call![2]).toEqual([
        "org/merged-a",
        "org/shared",
        "org/open-only",
      ]);
    });

    it("Phase 0: searches open-PR repos even when no merged PRs exist", async () => {
      const c = makeCandidate("org/open-only", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => []),
        getReposWithOpenPRs: vi.fn(() => ["org/open-only"]),
      });

      await discovery.searchIssues({ maxResults: 5 });

      const phase0Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "merged_pr",
      );
      expect(phase0Call).toBeDefined();
      expect(phase0Call![2]).toEqual(["org/open-only"]);
    });

    it("Phase 0: caps total repos at 10 across merged + open", async () => {
      const c = makeCandidate("org/merged-0", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const merged = Array.from({ length: 8 }, (_, i) => `org/merged-${i}`);
      const open = Array.from({ length: 8 }, (_, i) => `org/open-${i}`);

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => merged),
        getReposWithOpenPRs: vi.fn(() => open),
      });

      await discovery.searchIssues({ maxResults: 5 });

      const phase0Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "merged_pr",
      );
      expect(phase0Call).toBeDefined();
      expect(phase0Call![2]).toHaveLength(10);
      // Merged repos come first
      expect(phase0Call![2].slice(0, 8)).toEqual(merged);
    });

    it("caps Phase 0's share of maxResults so starred (Phase 1) still runs", async () => {
      // Regression: Phase 0 previously took the whole budget, so the
      // `allCandidates < maxResults` gate skipped Phase 1 even when starred
      // repos existed. Phase 0 is now capped at ceil(maxResults * 0.5).
      // The Phase 0 mock returns AS MANY as requested, so without the cap it
      // would fill maxResults and gate Phase 1 out — making this non-vacuous.
      const maxResults = 10;
      mockFetchIssuesFromKnownRepos.mockImplementation(
        async (
          _octokit: unknown,
          _vetter: unknown,
          _repos: unknown,
          _labels: unknown,
          reqMax: number,
          priority: string,
        ) => {
          const candidates =
            priority === "merged_pr"
              ? Array.from({ length: reqMax }, (_, i) =>
                  makeCandidate(`org/merged-${i}`, "merged_pr"),
                )
              : [makeCandidate("org/starred-repo", "starred")];
          return { candidates, allReposFailed: false, rateLimitHit: false };
        },
      );

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
        getStarredRepos: vi.fn(() => ["org/starred-repo"]),
      });

      await discovery.searchIssues({ maxResults });

      // Phase 0 (first call) was capped at ceil(10 * 0.5) = 5, not 10.
      const phase0Call = mockFetchIssuesFromKnownRepos.mock.calls[0];
      expect(phase0Call[5]).toBe("merged_pr");
      expect(phase0Call[4]).toBe(5);
      // Phase 0 returned its capped 5, leaving room, so Phase 1 (starred) ran.
      // Without the cap Phase 0 would have returned 10 and gated Phase 1 out.
      const phase1Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "starred",
      );
      expect(phase1Call).toBeDefined();
    });

    it("does NOT cap Phase 0 when no other strategy can run (no under-fill)", async () => {
      // A contributed-only user (no starred repos; broad/maintained disabled)
      // must still get the full budget from Phase 0 — the cap only applies
      // when a later phase can actually consume the reserved share.
      const c = makeCandidate("org/merged-repo", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery(
        {
          getReposWithMergedPRs: vi.fn(() => ["org/merged-repo"]),
          getStarredRepos: vi.fn(() => []),
        },
        { defaultStrategy: ["merged"] },
      );

      await discovery.searchIssues({ maxResults: 10 });

      // Phase 0 got the full budget (10), not the halved cap (5).
      const phase0Call = mockFetchIssuesFromKnownRepos.mock.calls[0];
      expect(phase0Call[5]).toBe("merged_pr");
      expect(phase0Call[4]).toBe(10);
    });

    it("Phase 1: excludes starred repos that are already searched as open-PR repos in Phase 0", async () => {
      const c = makeCandidate("org/shared", "merged_pr");
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [c],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => []),
        getReposWithOpenPRs: vi.fn(() => ["org/shared"]),
        getStarredRepos: vi.fn(() => ["org/shared", "org/other"]),
      });

      await discovery.searchIssues({ maxResults: 5 });

      const phase1Call = mockFetchIssuesFromKnownRepos.mock.calls.find(
        (call) => call[5] === "starred",
      );
      expect(phase1Call).toBeDefined();
      // "org/shared" was already searched in Phase 0 (as open-PR repo), so
      // Phase 1 only gets the non-overlapping starred repo.
      expect(phase1Call![2]).toEqual(["org/other"]);
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
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([item]);
      const c = makeCandidate("broad/repo", "normal");
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [c],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery();
      await discovery.searchIssues({ maxResults: 5 });

      expect(mockSearchAcrossLanguagesAndLabels).toHaveBeenCalled();
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

      mockSearchIssuesGraphQLFirst.mockResolvedValue({
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
      expect(mockSearchIssuesGraphQLFirst).toHaveBeenCalled();
    });

    it("Phase 3: propagates 401 from Search API fallback instead of swallowing", async () => {
      // REST returns empty so Phase 3 falls back to Search API.
      mockFetchIssuesFromMaintainedRepos.mockResolvedValue([]);

      // The Search API call rejects with 401.
      const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
      mockSearchIssuesGraphQLFirst.mockRejectedValue(authErr);

      // Phase 2 returns empty so we get to Phase 3.
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getStarredRepos: vi.fn(() => ["starred/repo"]),
      });

      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(
        "Unauthorized",
      );
    });

    it("Phase 3: falls back to Search API when no starred repos available", async () => {
      mockSearchIssuesGraphQLFirst.mockResolvedValue({
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
      expect(mockSearchIssuesGraphQLFirst).toHaveBeenCalled();
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
    it("skips only the starred phase when REST budget is critical (<10)", async () => {
      // Critical REST budget gates the starred phase (still REST-based) but not
      // broad/maintained, which now run on the GraphQL points bucket.
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
        interPhaseDelayMs: 0,
        broadPhaseDelayMs: 0,
      });

      expect(strategiesUsed).toContain("merged");
      expect(strategiesUsed).not.toContain("starred");
      expect(strategiesUsed).toContain("broad");
      expect(strategiesUsed).toContain("maintained");
    });

    it("still runs Phases 2 and 3 when REST budget is low (<20) since they use GraphQL", async () => {
      // Broad/maintained now bill the GraphQL points bucket, not the REST
      // Search bucket, so a low REST budget must NOT gate them off anymore.
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 15,
        limit: 30,
        resetAt: new Date(Date.now() + 60000).toISOString(),
      });

      // A merged-PR candidate keeps allCandidates > 0 (so the run doesn't throw)
      // while staying in the affinity set, so it doesn't trip the broad-skip gate.
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [makeCandidate("org/merged", "merged_pr")],
        allReposFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/merged"]),
        getStarredRepos: vi.fn(() => ["org/starred"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 10,
        interPhaseDelayMs: 0,
        broadPhaseDelayMs: 0,
      });

      expect(strategiesUsed).toContain("broad");
      expect(strategiesUsed).toContain("maintained");
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
        { interPhaseDelayMs: 0, broadPhaseDelayMs: 0 },
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
      // Phase 2 (broad) returns normal
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [normal],
        allVetFailed: false,
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
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue(items);

      const discovery = makeDiscovery({}, { excludeRepos: ["excluded/repo"] });

      // The filter function is passed to search phases; items matching
      // excludeRepos should be excluded. With no candidates from any phase,
      // searchIssues throws ValidationError.
      await expect(discovery.searchIssues({ maxResults: 5 })).rejects.toThrow(
        "No issue candidates found",
      );
    });

    it("filterIssues matches excludeRepos case-insensitively (#130)", async () => {
      const items: GitHubSearchItem[] = [
        {
          html_url: "https://github.com/excluded/repo/issues/1",
          repository_url: "https://api.github.com/repos/excluded/repo",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ];
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue(items);

      // User typed the slug with different casing than the API returns
      const discovery = makeDiscovery({}, { excludeRepos: ["Excluded/Repo"] });

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

    it("attaches strategiesUsed to the zero-candidate ValidationError", async () => {
      // scout.search() reads strategiesUsed off the error to advance the
      // language-rotation cursor even when the search found nothing — a broad
      // phase that ran and came up empty must still rotate (#249 follow-up).
      const discovery = makeDiscovery();
      await expect(
        discovery.searchIssues({ maxResults: 5 }),
      ).rejects.toMatchObject({
        name: "ValidationError",
        strategiesUsed: expect.any(Array),
      });
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

  describe("searchIssues — broad phase delay/skip logic", () => {
    it("runs Phase 2 when phases 0/1 found candidates only in affinity repos", async () => {
      // Phase 0 returns 15 candidates, all from the user's own merged-PR repos.
      // These must NOT gate off the broad phase — otherwise an affinity-heavy
      // user never discovers new repos (broad is the only phase that does).
      const affinityRepos = Array.from(
        { length: 15 },
        (_, i) => `org/affinity-${i}`,
      );
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: affinityRepos.map((r) => makeCandidate(r, "merged_pr")),
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => affinityRepos) },
        { skipBroadWhenSufficientResults: 15 },
      );

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 20,
      });

      expect(strategiesUsed).toContain("broad");
      expect(mockSearchAcrossLanguagesAndLabels).toHaveBeenCalled();
    });

    it("skips Phase 2 once enough candidates come from NEW repos", async () => {
      // The skip gate still fires, but only on candidates from repos outside the
      // user's affinity + starred sets. (Phase 0 searches "org/seed" here while
      // the candidates come from fresh repos — a mock decoupling that exercises
      // the gate; in normal flow new-repo candidates only appear via the broad
      // phase itself.)
      const freshRepos = Array.from({ length: 15 }, (_, i) => `org/fresh-${i}`);
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: freshRepos.map((r) => makeCandidate(r, "merged_pr")),
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["org/seed"]) },
        { skipBroadWhenSufficientResults: 15 },
      );

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 20,
      });

      // No broad query ran, so "broad" must NOT be reported as used (#130)
      expect(strategiesUsed).not.toContain("broad");
      expect(mockSearchAcrossLanguagesAndLabels).not.toHaveBeenCalled();
    });

    it("does not report starred when every starred repo was already covered by Phase 0", async () => {
      const candidates = [makeCandidate("org/repo-0", "merged_pr")];
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery({
        getReposWithMergedPRs: vi.fn(() => ["org/repo-0"]),
        // Starred list is a subset of Phase 0 repos, so Phase 1 has nothing
        // left to query
        getStarredRepos: vi.fn(() => ["org/repo-0"]),
      });

      const { strategiesUsed } = await discovery.searchIssues({
        maxResults: 5,
        strategies: ["merged", "starred"],
      });

      expect(strategiesUsed).toContain("merged");
      expect(strategiesUsed).not.toContain("starred");
    });

    it("applies broadPhaseDelayMs before Phase 2 when previous phases found some results", async () => {
      // Phase 0 returns 2 candidates (below skip threshold)
      const phase0Candidates = [
        makeCandidate("org/merged-1", "merged_pr"),
        makeCandidate("org/merged-2", "merged_pr"),
      ];
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: phase0Candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["org/merged-1"]) },
        { broadPhaseDelayMs: 60000, skipBroadWhenSufficientResults: 15 },
      );

      await discovery.searchIssues({ maxResults: 10 });

      // sleep should have been called with 60000 for the broad phase delay
      expect(sleep).toHaveBeenCalledWith(60000);
    });

    it("per-call delay overrides take precedence over preferences (#143)", async () => {
      const phase0Candidates = [
        makeCandidate("org/merged-1", "merged_pr"),
        makeCandidate("org/merged-2", "merged_pr"),
      ];
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: phase0Candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      // Preferences say 30s/90s, but the per-call override is 0/0
      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["org/merged-1"]) },
        { interPhaseDelayMs: 30000, broadPhaseDelayMs: 90000 },
      );

      await discovery.searchIssues({
        maxResults: 10,
        interPhaseDelayMs: 0,
        broadPhaseDelayMs: 0,
      });

      // No delay sleep fired with either the preference value or the broad value
      const sleepArgs = vi.mocked(sleep).mock.calls.map((c) => c[0]);
      expect(sleepArgs).not.toContain(30000);
      expect(sleepArgs).not.toContain(90000);
    });

    it("skips delay when previous phases found 0 results", async () => {
      // No Phase 0/1 candidates, so Phase 2 should run without the broad delay
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates: [],
        allReposFailed: false,
        rateLimitHit: false,
      });

      // Phase 2 returns candidates so we don't throw
      const broadCandidate = makeCandidate("broad/repo", "normal");
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [broadCandidate],
        allVetFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        {},
        { broadPhaseDelayMs: 90000, skipBroadWhenSufficientResults: 15 },
      );

      await discovery.searchIssues({ maxResults: 10 });

      // sleep should NOT have been called with 90000 (the broad delay)
      // It may have been called with the inter-phase delay (2000), but not the broad delay
      const sleepCalls = vi.mocked(sleep).mock.calls.map((c) => c[0]);
      expect(sleepCalls).not.toContain(90000);
    });

    it("clamps an unsatisfiable threshold to maxResults - 1 (old persisted default 15 vs maxResults 10)", async () => {
      // 9 new-repo candidates: under maxResults (10), so Phase 2's gate is open;
      // threshold 15 would never fire unclamped, but clamped to 9 it skips the
      // broad phase. Phase 0 seeds an unrelated affinity repo, so all 9
      // candidates count as "new" toward the skip gate.
      const candidates = Array.from({ length: 9 }, (_, i) =>
        makeCandidate(`org/clamp-${i}`, "merged_pr"),
      );
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["org/seed"]) },
        { skipBroadWhenSufficientResults: 15 },
      );

      await discovery.searchIssues({ maxResults: 10 });

      expect(mockSearchAcrossLanguagesAndLabels).not.toHaveBeenCalled();
    });

    it("skipBroadWhenSufficientResults=0 means never skip Phase 2", async () => {
      // Phase 0 returns many candidates
      const candidates = Array.from({ length: 20 }, (_, i) =>
        makeCandidate(`org/repo-${i}`, "merged_pr"),
      );
      mockFetchIssuesFromKnownRepos.mockResolvedValue({
        candidates,
        allReposFailed: false,
        rateLimitHit: false,
      });
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = makeDiscovery(
        { getReposWithMergedPRs: vi.fn(() => ["org/repo-0"]) },
        { skipBroadWhenSufficientResults: 0 },
      );

      // maxResults must be higher than candidates count so Phase 2 condition passes
      await discovery.searchIssues({ maxResults: 25 });

      // Phase 2 should have run (searchWithChunkedLabels called)
      expect(mockSearchAcrossLanguagesAndLabels).toHaveBeenCalled();
    });
  });

  describe("budget tracker injection (#156)", () => {
    it("uses an injected tracker instead of the shared singleton", async () => {
      const item: GitHubSearchItem = {
        html_url: "https://github.com/broad/repo/issues/1",
        repository_url: "https://api.github.com/repos/broad/repo",
        updated_at: "2026-01-01T00:00:00Z",
      };
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([item]);
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [makeCandidate("broad/repo", "normal")],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const tracker = makeFakeTracker();
      const discovery = new IssueDiscovery(
        "test-token",
        makePreferences(),
        makeStateReader(),
        tracker,
      );
      await discovery.searchIssues({ maxResults: 5 });

      // Pre-flight init() ran on the injected instance, not the singleton.
      expect(tracker.init).toHaveBeenCalledOnce();

      // The same instance is threaded into the search-phases helper as the
      // `tracker` argument (now second-to-last: `languageRotationOffset`
      // trails it, #249 follow-up), so concurrent searches no longer share
      // budget state.
      const phaseCall = mockSearchAcrossLanguagesAndLabels.mock.calls.at(-1)!;
      expect(phaseCall.at(-2)).toBe(tracker);
    });

    it("falls back to the shared singleton when no tracker is injected", async () => {
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([
        {
          html_url: "https://github.com/broad/repo/issues/1",
          repository_url: "https://api.github.com/repos/broad/repo",
          updated_at: "2026-01-01T00:00:00Z",
        } as GitHubSearchItem,
      ]);
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [makeCandidate("broad/repo", "normal")],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery();
      await discovery.searchIssues({ maxResults: 5 });

      // Default path threads the mocked singleton (a defined tracker object),
      // never undefined, into the search-phases helper (second-to-last arg;
      // `languageRotationOffset` trails it, #249 follow-up).
      const phaseCall = mockSearchAcrossLanguagesAndLabels.mock.calls.at(-1)!;
      expect(phaseCall.at(-2)).toBeDefined();
    });
  });

  describe("languageRotationOffset threading (#249 follow-up)", () => {
    it("passes languageRotationOffset through to searchAcrossLanguagesAndLabels", async () => {
      const item: GitHubSearchItem = {
        html_url: "https://github.com/broad/repo/issues/1",
        repository_url: "https://api.github.com/repos/broad/repo",
        updated_at: "2026-01-01T00:00:00Z",
      };
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([item]);
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [makeCandidate("broad/repo", "normal")],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery();
      await discovery.searchIssues({
        maxResults: 5,
        languageRotationOffset: 3,
      });

      // Trailing arg on the search-phases helper (tracker, languageRotationOffset).
      const phaseCall = mockSearchAcrossLanguagesAndLabels.mock.calls.at(-1)!;
      expect(phaseCall.at(-1)).toBe(3);
    });

    it("defaults languageRotationOffset to 0 when not provided", async () => {
      const item: GitHubSearchItem = {
        html_url: "https://github.com/broad/repo/issues/1",
        repository_url: "https://api.github.com/repos/broad/repo",
        updated_at: "2026-01-01T00:00:00Z",
      };
      mockSearchAcrossLanguagesAndLabels.mockResolvedValue([item]);
      mockFilterVetAndScore.mockResolvedValue({
        candidates: [makeCandidate("broad/repo", "normal")],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = makeDiscovery();
      await discovery.searchIssues({ maxResults: 5 });

      const phaseCall = mockSearchAcrossLanguagesAndLabels.mock.calls.at(-1)!;
      expect(phaseCall.at(-1)).toBe(0);
    });
  });
});
