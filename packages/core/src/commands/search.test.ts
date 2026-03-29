import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueCandidate, SearchResult } from "../core/types.js";
import type { ScoutState, RepoScore } from "../core/schemas.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockSearch = vi.fn<() => Promise<SearchResult>>();
const mockSaveResults = vi.fn();
const mockCheckpoint = vi.fn<() => Promise<boolean>>();
const mockGetState = vi.fn<() => ScoutState>();
const mockGetRepoScoreRecord = vi.fn<(repo: string) => RepoScore | undefined>();

vi.mock("../scout.js", () => ({
  createScout: vi.fn().mockImplementation(() =>
    Promise.resolve({
      search: mockSearch,
      saveResults: mockSaveResults,
      checkpoint: mockCheckpoint,
      getState: mockGetState,
      getRepoScoreRecord: mockGetRepoScoreRecord,
    }),
  ),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
  getDataDir: () => "/tmp/oss-scout-test",
}));

vi.mock("../core/local-state.js", () => ({
  saveLocalState: vi.fn(),
  loadLocalState: vi.fn(),
  hasLocalState: vi.fn().mockReturnValue(true),
}));

vi.mock("../core/logger.js", () => ({
  debug: () => {},
  warn: () => {},
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: "https://github.com/test/repo/issues/42",
      repo: "test/repo",
      number: 42,
      title: "Fix the thing",
      status: "candidate",
      labels: ["good first issue"],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
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
      repo: "test/repo",
      lastCommitAt: "2025-01-01T00:00:00Z",
      daysSinceLastCommit: 5,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
    },
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: ["Active project"],
    viabilityScore: 85,
    searchPriority: "normal",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckpoint.mockResolvedValue(true);
  });

  it("creates scout, searches, and returns SearchOutput", async () => {
    const candidate = makeCandidate();
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: ["excluded/repo"],
      aiPolicyBlocklist: ["blocked/repo"],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 10 });

    expect(mockSearch).toHaveBeenCalledWith({
      maxResults: 10,
      strategies: undefined,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.excludedRepos).toEqual(["excluded/repo"]);
    expect(result.aiPolicyBlocklist).toEqual(["blocked/repo"]);
    expect(result.strategiesUsed).toEqual(["broad"]);
  });

  it("includes repoUrl in issue objects", async () => {
    const candidate = makeCandidate();
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].issue.repoUrl).toBe(
      "https://github.com/test/repo",
    );
  });

  it("includes repoScore when available", async () => {
    const candidate = makeCandidate();
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue({
      repo: "test/repo",
      score: 8,
      mergedPRCount: 3,
      closedWithoutMergeCount: 0,
      avgResponseDays: 1.5,
      lastMergedAt: "2025-01-15T00:00:00Z",
      lastEvaluatedAt: "2025-01-20T00:00:00Z",
      signals: {
        hasActiveMaintainers: true,
        isResponsive: true,
        hasHostileComments: false,
      },
    });

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].repoScore).toBeDefined();
    expect(result.candidates[0].repoScore!.score).toBe(8);
    expect(result.candidates[0].repoScore!.mergedPRCount).toBe(3);
    expect(result.candidates[0].repoScore!.isResponsive).toBe(true);
    expect(result.candidates[0].repoScore!.lastMergedAt).toBe(
      "2025-01-15T00:00:00Z",
    );
  });

  it("omits repoScore when not available", async () => {
    const candidate = makeCandidate();
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].repoScore).toBeUndefined();
  });

  it("propagates rateLimitWarning from search result", async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      rateLimitWarning: "Only 3 API calls remaining",
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.rateLimitWarning).toBe("Only 3 API calls remaining");
  });

  it("saves state after search", async () => {
    const { saveLocalState } = await import("../core/local-state.js");
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);
    mockGetState.mockReturnValue({
      version: 1,
      preferences: {} as ScoutState["preferences"],
    } as ScoutState);

    const { runSearch } = await import("./search.js");
    await runSearch({ maxResults: 5 });

    expect(saveLocalState).toHaveBeenCalled();
  });

  it("calls checkpoint after search", async () => {
    mockSearch.mockResolvedValue({
      candidates: [],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);
    mockGetState.mockReturnValue({
      version: 1,
    } as ScoutState);

    const { runSearch } = await import("./search.js");
    await runSearch({ maxResults: 5 });

    expect(mockCheckpoint).toHaveBeenCalled();
  });

  it("calls saveResults with candidates", async () => {
    const candidate = makeCandidate();
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);
    mockGetState.mockReturnValue({
      version: 1,
    } as ScoutState);

    const { runSearch } = await import("./search.js");
    await runSearch({ maxResults: 5 });

    expect(mockSaveResults).toHaveBeenCalledWith([candidate]);
  });
});
