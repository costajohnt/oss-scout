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
  searchIssuesGraphQLFirst: vi
    .fn()
    .mockResolvedValue({ total_count: 0, items: [] }),
  fetchIssuesFromMaintainedRepos: vi.fn().mockResolvedValue([]),
  filterVetAndScore: vi.fn().mockResolvedValue({
    candidates: [],
    allVetFailed: false,
    rateLimitHit: false,
  }),
  fetchIssuesFromKnownRepos: vi.fn().mockResolvedValue({
    candidates: [],
    allReposFailed: false,
    rateLimitHit: false,
  }),
  searchAcrossLanguagesAndLabels: vi.fn().mockResolvedValue([]),
  getGraphQLSearchQueryCount: () => 0,
  resetGraphQLSearchQueryCount: () => {},
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
const {
  fetchIssuesFromKnownRepos,
  searchAcrossLanguagesAndLabels,
  filterVetAndScore,
} = await import("./search-phases.js");

const basePreferences = {
  githubUsername: "test",
  languages: ["typescript"],
  labels: ["good first issue"],
  excludeRepos: [],
  aiPolicyBlocklist: [],
  projectCategories: [],
  minStars: 50,
  maxIssueAgeDays: 90,
  includeDocIssues: true,
  minRepoScoreThreshold: 4,
};

const baseStateReader = {
  getReposWithMergedPRs: () => [] as string[],
  getReposWithOpenPRs: () => [] as string[],
  getStarredRepos: () => [] as string[],
  getProjectCategories: () => [] as string[],
  getRepoScore: () => null,
  getSLMTriageConfig: () => null,
};

describe("Strategy Selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchIssuesFromKnownRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [makeFakeCandidate("owner/merged-repo", "merged_pr")],
      allReposFailed: false,
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
    expect(fetchIssuesFromKnownRepos).toHaveBeenCalledTimes(1);
  });

  it("only runs starred strategy when specified", async () => {
    const stateReader = {
      ...baseStateReader,
      getStarredRepos: () => ["owner/starred"],
    };
    (fetchIssuesFromKnownRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [makeFakeCandidate("owner/starred", "starred")],
      allReposFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
    const result = await discovery.searchIssues({ strategies: ["starred"] });
    expect(result.strategiesUsed).toEqual(["starred"]);
    expect(fetchIssuesFromKnownRepos).toHaveBeenCalledTimes(1);
  });

  it('runs all strategies when "all" is specified', async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    const discovery = new IssueDiscovery("token", basePreferences, stateReader);
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
    expect(fetchIssuesFromKnownRepos).toHaveBeenCalledTimes(1);
  });

  it("treats an empty defaultStrategy as unset and falls back to all", async () => {
    const prefs = {
      ...basePreferences,
      defaultStrategy: [] as SearchStrategy[],
    };
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    const discovery = new IssueDiscovery("token", prefs, stateReader);
    const result = await discovery.searchIssues({});
    // [] must not produce a zero-strategy (silently empty) search
    expect(result.strategiesUsed.length).toBeGreaterThan(0);
  });

  it("treats empty options.strategies as unset and applies defaultStrategy", async () => {
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
    const result = await discovery.searchIssues({ strategies: [] });
    expect(result.strategiesUsed).toEqual(["merged"]);
  });

  it("can combine multiple strategies", async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
      getStarredRepos: () => ["owner/starred"],
    };
    (fetchIssuesFromKnownRepos as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        candidates: [makeFakeCandidate("owner/repo", "merged_pr")],
        allReposFailed: false,
        rateLimitHit: false,
      })
      .mockResolvedValueOnce({
        candidates: [makeFakeCandidate("owner/starred", "starred")],
        allReposFailed: false,
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
    expect(fetchIssuesFromKnownRepos).not.toHaveBeenCalled();
  });
});

describe("orgs strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVetIssuesParallel.mockResolvedValue({
      candidates: [],
      allFailed: false,
      rateLimitHit: false,
    });
  });

  const orgPrefs = {
    ...basePreferences,
    preferredOrgs: ["one", "two"],
  };

  it("runs the orgs phase with org: qualifiers in the query", async () => {
    (filterVetAndScore as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      candidates: [makeFakeCandidate("one/repo", "normal")],
      allVetFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", orgPrefs, baseStateReader);
    const result = await discovery.searchIssues({ strategies: ["orgs"] });
    expect(result.strategiesUsed).toEqual(["orgs"]);
    expect(searchAcrossLanguagesAndLabels).toHaveBeenCalledTimes(1);
    const buildQuery = (
      searchAcrossLanguagesAndLabels as ReturnType<typeof vi.fn>
    ).mock.calls[0][4] as (langQ: string) => string;
    const query = buildQuery("language:typescript");
    expect(query).toContain("org:one org:two");
    expect(query).toContain("is:issue is:open");
  });

  it("skips the orgs phase when preferredOrgs is empty", async () => {
    const discovery = new IssueDiscovery(
      "token",
      { ...basePreferences, preferredOrgs: [] },
      baseStateReader,
    );
    await expect(
      discovery.searchIssues({ strategies: ["orgs"] }),
    ).rejects.toThrow(/No issue candidates found/);
    expect(searchAcrossLanguagesAndLabels).not.toHaveBeenCalled();
  });

  it("skips the orgs phase when the strategy is not enabled", async () => {
    const stateReader = {
      ...baseStateReader,
      getReposWithMergedPRs: () => ["owner/repo"],
    };
    (fetchIssuesFromKnownRepos as ReturnType<typeof vi.fn>).mockResolvedValue({
      candidates: [makeFakeCandidate("owner/repo", "merged_pr")],
      allReposFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", orgPrefs, stateReader);
    const result = await discovery.searchIssues({ strategies: ["merged"] });
    expect(result.strategiesUsed).toEqual(["merged"]);
    expect(searchAcrossLanguagesAndLabels).not.toHaveBeenCalled();
  });

  it("org-phase candidates do not suppress the broad phase", async () => {
    // 8 viable org-phase candidates (>= default skipBroadWhenSufficientResults
    // of 8) must not trip the broad-skip gate, because they come from the
    // user's own preferred orgs, not new repos.
    (filterVetAndScore as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      candidates: Array.from({ length: 8 }, (_, i) =>
        makeFakeCandidate(`one/repo${i}`, "normal"),
      ),
      allVetFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", orgPrefs, baseStateReader);
    const result = await discovery.searchIssues({
      strategies: ["orgs", "broad"],
      maxResults: 10,
    });
    expect(result.strategiesUsed).toContain("orgs");
    expect(result.strategiesUsed).toContain("broad");
  });

  it("non-org new-repo candidates still suppress the broad phase", async () => {
    (filterVetAndScore as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      candidates: Array.from({ length: 8 }, (_, i) =>
        makeFakeCandidate(`elsewhere${i}/repo`, "normal"),
      ),
      allVetFailed: false,
      rateLimitHit: false,
    });
    const discovery = new IssueDiscovery("token", orgPrefs, baseStateReader);
    const result = await discovery.searchIssues({
      strategies: ["orgs", "broad"],
      maxResults: 10,
    });
    expect(result.strategiesUsed).toContain("orgs");
    expect(result.strategiesUsed).not.toContain("broad");
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

  it('validates the "orgs" strategy', () => {
    expect(SearchStrategySchema.safeParse("orgs").success).toBe(true);
    expect(CONCRETE_STRATEGIES).toContain("orgs");
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
