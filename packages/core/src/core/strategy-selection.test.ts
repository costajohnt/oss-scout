/**
 * Tests for configurable search strategy selection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SearchStrategySchema, CONCRETE_STRATEGIES } from "./schemas.js";
import type { SearchStrategy } from "./schemas.js";

// ── Shared mock state ──────────────────────────────────────────────

const mockVetIssuesParallel = vi.fn();

vi.mock("./github.js", () => ({
  getOctokit: () => ({}),
  checkRateLimit: vi.fn().mockResolvedValue({
    remaining: 100,
    limit: 100,
    resetAt: new Date().toISOString(),
  }),
}));

vi.mock("./search-budget.js", () => ({
  getSearchBudgetTracker: () => ({
    init: vi.fn(),
    getTotalCalls: () => 0,
  }),
}));

vi.mock("./search-phases.js", () => ({
  buildEffectiveLabels: vi.fn((_scopes: unknown, labels: string[]) => labels),
  interleaveArrays: vi.fn((arrays: unknown[][]) => arrays.flat()),
  cachedSearchIssues: vi.fn().mockResolvedValue({ total_count: 0, items: [] }),
  filterVetAndScore: vi.fn().mockResolvedValue({
    candidates: [],
    allVetFailed: false,
    rateLimitHit: false,
  }),
  searchInRepos: vi.fn().mockResolvedValue({
    candidates: [],
    allBatchesFailed: false,
    rateLimitHit: false,
  }),
  searchWithChunkedLabels: vi.fn().mockResolvedValue([]),
}));

vi.mock("./issue-vetting.js", () => {
  return {
    IssueVetter: class MockIssueVetter {
      vetIssuesParallel = mockVetIssuesParallel;
      vetIssue = vi.fn();
    },
  };
});

vi.mock("./utils.js", () => ({
  daysBetween: () => 1,
  sleep: vi.fn().mockResolvedValue(undefined),
  extractRepoFromUrl: (url: string) => {
    const api = url.match(/api\.github\.com\/repos\/([^/]+\/[^/]+)/);
    if (api) return api[1];
    const web = url.match(/github\.com\/([^/]+\/[^/]+)/);
    return web ? web[1] : null;
  },
}));

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./errors.js", () => ({
  ValidationError: class ValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ValidationError";
    }
  },
  errorMessage: (e: unknown) => String(e),
  getHttpStatusCode: () => null,
  isRateLimitError: () => false,
}));

vi.mock("./category-mapping.js", () => ({
  getTopicsForCategories: () => [],
}));

// ── Helper ─────────────────────────────────────────────────────────

function makeFakeCandidate(repo: string, priority: string) {
  return {
    issue: {
      id: 1,
      url: `https://github.com/${repo}/issues/1`,
      repo,
      number: 1,
      title: "Test issue",
      status: "candidate",
      labels: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      lastCommitAt: new Date().toISOString(),
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing" as const,
      isActive: true,
    },
    recommendation: "approve" as const,
    reasonsToSkip: [],
    reasonsToApprove: ["active"],
    viabilityScore: 80,
    searchPriority: priority,
  };
}

// ── Import after mocks ─────────────────────────────────────────────

const { IssueDiscovery } = await import("./issue-discovery.js");
const { searchInRepos, searchWithChunkedLabels } =
  await import("./search-phases.js");

const basePreferences = {
  githubUsername: "test",
  languages: ["typescript"],
  labels: ["good first issue"],
  excludeRepos: [],
  aiPolicyBlocklist: [],
  preferredOrgs: [],
  projectCategories: [],
  minStars: 50,
  maxIssueAgeDays: 90,
  includeDocIssues: true,
  minRepoScoreThreshold: 4,
};

const baseStateReader = {
  getReposWithMergedPRs: () => [] as string[],
  getStarredRepos: () => [] as string[],
  getPreferredOrgs: () => [] as string[],
  getProjectCategories: () => [] as string[],
  getRepoScore: () => null,
};

describe("Strategy Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (searchInRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [makeFakeCandidate("owner/merged-repo", "merged_pr")],
      allBatchesFailed: false,
      rateLimitHit: false,
    });
    mockVetIssuesParallel.mockResolvedValue({
      candidates: [],
      allFailed: false,
      rateLimitHit: false,
    });
  });

  it("returns strategiesUsed in the result", async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
    };
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({ strategies: ["merged"] });
    expect(result).toHaveProperty("strategiesUsed");
    expect(result).toHaveProperty("candidates");
    expect(result.strategiesUsed).toContain("merged");
  });

  it("only runs merged strategy when specified", async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({ strategies: ["merged"] });
    expect(result.strategiesUsed).toEqual(["merged"]);
    expect(searchInRepos).toHaveBeenCalledTimes(1);
  });

  it("only runs orgs strategy when specified", async () => {
    const prefs = { ...basePreferences, preferredOrgs: ["myorg"] };
    const discovery = new IssueDiscovery("token", prefs, baseStateReader);
    (searchWithChunkedLabels as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        html_url: "https://github.com/myorg/repo/issues/1",
        repository_url: "https://api.github.com/repos/myorg/repo",
        updated_at: new Date().toISOString(),
      },
    ]);
    mockVetIssuesParallel.mockResolvedValue({
      candidates: [makeFakeCandidate("myorg/repo", "preferred_org")],
      allFailed: false,
      rateLimitHit: false,
    });
    const result = await discovery.searchIssues({ strategies: ["orgs"] });
    expect(result.strategiesUsed).toEqual(["orgs"]);
    expect(searchInRepos).not.toHaveBeenCalled();
  });

  it("only runs starred strategy when specified", async () => {
    const stateReader = {
      ...baseStateReader,
      getStarredRepos: () => ["owner/starred"],
    };
    (searchInRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [makeFakeCandidate("owner/starred", "starred")],
      allBatchesFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({ strategies: ["starred"] });
    expect(result.strategiesUsed).toEqual(["starred"]);
    expect(searchInRepos).toHaveBeenCalledTimes(1);
  });

  it('runs all strategies when "all" is specified', async () => {
    const prefs = { ...basePreferences, preferredOrgs: ["myorg"] };
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    const discovery = new IssueDiscovery("token", prefs, stateReader);
    const result = await discovery.searchIssues({
      strategies: ["all"],
      maxResults: 100,
    });
    expect(result.strategiesUsed).toContain("merged");
  });

  it('defaults to "all" when no strategies specified', async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
    };
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({});
    expect(result.strategiesUsed).toContain("merged");
  });

  it("uses defaultStrategy from preferences when no options.strategies", async () => {
    const prefs = {
      ...basePreferences,
      defaultStrategy: ["merged"] as SearchStrategy[],
    };
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    const discovery = new IssueDiscovery("token", prefs, stateReader);
    const result = await discovery.searchIssues({});
    expect(result.strategiesUsed).toEqual(["merged"]);
    expect(searchInRepos).toHaveBeenCalledTimes(1);
  });

  it("can combine multiple strategies", async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    (searchInRepos as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        candidates: [makeFakeCandidate("owner/repo", "merged_pr")],
        allBatchesFailed: false,
        rateLimitHit: false,
      })
      .mockResolvedValueOnce({
        candidates: [makeFakeCandidate("owner/starred", "starred")],
        allBatchesFailed: false,
        rateLimitHit: false,
      });
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({
      strategies: ["merged", "starred"],
      maxResults: 100,
    });
    expect(result.strategiesUsed).toContain("merged");
    expect(result.strategiesUsed).toContain("starred");
    expect(result.strategiesUsed).not.toContain("broad");
    expect(result.strategiesUsed).not.toContain("maintained");
  });

  it("throws ValidationError when enabled phase has no data", async () => {
    const discovery = new IssueDiscovery(
      "token",
      basePreferences,
      baseStateReader,
    );
    await expect(
      discovery.searchIssues({ strategies: ["merged"] }),
    ).rejects.toThrow(/No issue candidates found/);
    expect(searchInRepos).not.toHaveBeenCalled();
  });
});

describe("SearchStrategySchema", () => {
  it("validates all concrete strategies", () => {
    for (const strategy of CONCRETE_STRATEGIES) {
      expect(SearchStrategySchema.safeParse(strategy).success).toBe(true);
    }
  });

  it('validates the "all" meta-strategy', () => {
    expect(SearchStrategySchema.safeParse("all").success).toBe(true);
  });

  it("rejects invalid strategy names", () => {
    expect(SearchStrategySchema.safeParse("invalid").success).toBe(false);
    expect(SearchStrategySchema.safeParse("").success).toBe(false);
    expect(SearchStrategySchema.safeParse(123).success).toBe(false);
  });

  it('CONCRETE_STRATEGIES excludes "all"', () => {
    expect(CONCRETE_STRATEGIES).not.toContain("all");
    expect(CONCRETE_STRATEGIES).toHaveLength(5);
  });
});
