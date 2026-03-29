import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationError } from "../core/errors.js";
import type { IssueCandidate } from "../core/types.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockVetIssue = vi.fn<(url: string) => Promise<IssueCandidate>>();

vi.mock("../scout.js", () => ({
  createScout: vi.fn().mockImplementation(() =>
    Promise.resolve({
      vetIssue: mockVetIssue,
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

function makeVettedCandidate(): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: "https://github.com/owner/repo/issues/42",
      repo: "owner/repo",
      number: 42,
      title: "Add feature X",
      status: "candidate",
      labels: ["enhancement", "help wanted"],
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
      notes: ["CONTRIBUTING.md found"],
    },
    projectHealth: {
      repo: "owner/repo",
      lastCommitAt: "2025-01-10T00:00:00Z",
      daysSinceLastCommit: 3,
      openIssuesCount: 15,
      avgIssueResponseDays: 1.2,
      ciStatus: "passing",
      isActive: true,
    },
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: ["Active project", "Clear requirements"],
    viabilityScore: 92,
    searchPriority: "normal",
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("runVet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates URL, creates scout, and returns VetOutput", async () => {
    const candidate = makeVettedCandidate();
    mockVetIssue.mockResolvedValue(candidate);

    const { runVet } = await import("./vet.js");
    const result = await runVet({
      issueUrl: "https://github.com/owner/repo/issues/42",
    });

    expect(mockVetIssue).toHaveBeenCalledWith(
      "https://github.com/owner/repo/issues/42",
    );
    expect(result.issue.repo).toBe("owner/repo");
    expect(result.issue.number).toBe(42);
    expect(result.issue.title).toBe("Add feature X");
    expect(result.issue.url).toBe("https://github.com/owner/repo/issues/42");
    expect(result.issue.labels).toEqual(["enhancement", "help wanted"]);
  });

  it("returns recommendation and reasons", async () => {
    const candidate = makeVettedCandidate();
    mockVetIssue.mockResolvedValue(candidate);

    const { runVet } = await import("./vet.js");
    const result = await runVet({
      issueUrl: "https://github.com/owner/repo/issues/42",
    });

    expect(result.recommendation).toBe("approve");
    expect(result.reasonsToApprove).toEqual([
      "Active project",
      "Clear requirements",
    ]);
    expect(result.reasonsToSkip).toEqual([]);
  });

  it("returns projectHealth", async () => {
    const candidate = makeVettedCandidate();
    mockVetIssue.mockResolvedValue(candidate);

    const { runVet } = await import("./vet.js");
    const result = await runVet({
      issueUrl: "https://github.com/owner/repo/issues/42",
    });

    expect(result.projectHealth.repo).toBe("owner/repo");
    expect(result.projectHealth.isActive).toBe(true);
    expect(result.projectHealth.ciStatus).toBe("passing");
    expect(result.projectHealth.daysSinceLastCommit).toBe(3);
  });

  it("returns vettingResult", async () => {
    const candidate = makeVettedCandidate();
    mockVetIssue.mockResolvedValue(candidate);

    const { runVet } = await import("./vet.js");
    const result = await runVet({
      issueUrl: "https://github.com/owner/repo/issues/42",
    });

    expect(result.vettingResult.passedAllChecks).toBe(true);
    expect(result.vettingResult.checks.noExistingPR).toBe(true);
    expect(result.vettingResult.checks.notClaimed).toBe(true);
  });

  it("throws ValidationError for invalid URL (not a GitHub issue)", async () => {
    const { runVet } = await import("./vet.js");

    await expect(
      runVet({ issueUrl: "https://github.com/owner/repo/pull/42" }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for overly long URL", async () => {
    const { runVet } = await import("./vet.js");

    const longUrl =
      "https://github.com/owner/repo/issues/42" + "a".repeat(2048);
    await expect(runVet({ issueUrl: longUrl })).rejects.toThrow(
      ValidationError,
    );
  });
});
