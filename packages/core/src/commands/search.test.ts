import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueCandidate, SearchResult } from "../core/types.js";
import type { ScoutState, RepoScore } from "../core/schemas.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockSearch = vi.fn<() => Promise<SearchResult>>();
const mockSaveResults = vi.fn();
const mockCheckpoint = vi.fn<() => Promise<boolean>>();
const mockGetState = vi.fn<() => ScoutState>();
const mockGetRepoScoreRecord = vi.fn<(repo: string) => RepoScore | undefined>();
const mockIsDirty = vi.fn<() => boolean>();

vi.mock("../scout.js", () => ({
  createScout: vi.fn().mockImplementation(() =>
    Promise.resolve({
      search: mockSearch,
      saveResults: mockSaveResults,
      checkpoint: mockCheckpoint,
      getState: mockGetState,
      getRepoScoreRecord: mockGetRepoScoreRecord,
      isDirty: mockIsDirty,
    }),
  ),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
  getDataDir: () => "/tmp/oss-scout-test",
}));

vi.mock("../core/local-state.js", () => ({
  saveLocalState: vi.fn(),
  loadLocalState: vi.fn(() => ({
    version: 1,
    preferences: { persistence: "local" },
    savedResults: [],
    skippedIssues: [],
    mergedPRs: [],
    closedPRs: [],
    openPRs: [],
    repoScores: {},
    starredRepos: [],
  })),
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

  it("persists dirty state when a zero-candidate ValidationError is thrown", async () => {
    // withScout's persist epilogue never runs when search throws, but the
    // language-rotation cursor advances even on a zero-candidate broad run
    // (#249 follow-up) — that advance must land on disk before rethrowing.
    const { ValidationError } = await import("../core/errors.js");
    const { saveLocalState } = await import("../core/local-state.js");
    mockSearch.mockRejectedValue(
      new ValidationError("No issue candidates found", ["broad"]),
    );
    mockIsDirty.mockReturnValue(true);
    mockGetState.mockReturnValue({ version: 1 } as ScoutState);

    const { runSearch } = await import("./search.js");
    await expect(runSearch({ maxResults: 5 })).rejects.toThrow(
      "No issue candidates found",
    );

    expect(saveLocalState).toHaveBeenCalled();
    expect(mockCheckpoint).toHaveBeenCalled();
  });

  it("does not persist on non-ValidationError failures", async () => {
    const { saveLocalState } = await import("../core/local-state.js");
    mockSearch.mockRejectedValue(new Error("network exploded"));
    mockIsDirty.mockReturnValue(true);

    const { runSearch } = await import("./search.js");
    await expect(runSearch({ maxResults: 5 })).rejects.toThrow(
      "network exploded",
    );

    expect(saveLocalState).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
  });

  it("marks linkedPR.isStalled when the linked PR is open and stale (#97)", async () => {
    const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeCandidate({
      vettingResult: {
        passedAllChecks: false,
        checks: {
          noExistingPR: false,
          notClaimed: true,
          projectActive: true,
          clearRequirements: true,
          contributionGuidelinesFound: true,
        },
        notes: [],
        linkedPR: {
          number: 99,
          author: "alice",
          state: "open",
          merged: false,
          url: "https://github.com/test/repo/pull/99",
          updatedAt: stale,
        },
      },
    });
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].linkedPR).toBeDefined();
    expect(result.candidates[0].linkedPR!.number).toBe(99);
    expect(result.candidates[0].linkedPR!.isStalled).toBe(true);
  });

  it("does not flag a fresh linked PR as stalled (#97)", async () => {
    const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeCandidate({
      vettingResult: {
        passedAllChecks: false,
        checks: {
          noExistingPR: false,
          notClaimed: true,
          projectActive: true,
          clearRequirements: true,
          contributionGuidelinesFound: true,
        },
        notes: [],
        linkedPR: {
          number: 100,
          author: "alice",
          state: "open",
          merged: false,
          url: "https://github.com/test/repo/pull/100",
          updatedAt: fresh,
        },
      },
    });
    mockSearch.mockResolvedValue({
      candidates: [candidate],
      excludedRepos: [],
      aiPolicyBlocklist: [],
      strategiesUsed: ["broad"],
    });
    mockGetRepoScoreRecord.mockReturnValue(undefined);

    const { runSearch } = await import("./search.js");
    const result = await runSearch({ maxResults: 5 });

    expect(result.candidates[0].linkedPR!.isStalled).toBe(false);
  });

  it("omits linkedPR when no PR is linked (#97)", async () => {
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

    expect(result.candidates[0].linkedPR).toBeUndefined();
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
