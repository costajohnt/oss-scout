import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "./schemas.js";
import type { IssueCandidate, ProjectHealth } from "./types.js";

const { searchResult } = vi.hoisted(() => ({
  searchResult: { current: null as { candidates: IssueCandidate[] } | null },
}));

vi.mock("./issue-discovery.js", () => ({
  IssueDiscovery: class {
    rateLimitWarning: string | null = null;
    async searchIssues() {
      return {
        candidates: searchResult.current?.candidates ?? [],
        strategiesUsed: ["broad"],
      };
    }
  },
}));

vi.mock("./http-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-cache.js")>();
  return {
    ...actual,
    getHttpCache: () =>
      ({ evictStale: () => 0 }) as unknown as ReturnType<
        typeof actual.getHttpCache
      >,
  };
});

const { OssScout } = await import("../scout.js");

function candidateWithHealth(health: Partial<ProjectHealth>): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: "https://github.com/owner/repo/issues/1",
      repo: "owner/repo",
      number: 1,
      title: "t",
      status: "candidate",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
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
      repo: "owner/repo",
      lastCommitAt: "2026-03-01T00:00:00Z",
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
      ...health,
    },
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 70,
    searchPriority: "normal",
  };
}

describe("repo-score active-maintainers signal from search (#167)", () => {
  beforeEach(() => {
    searchResult.current = null;
  });

  it("sets hasActiveMaintainers from an active projectHealth and bumps the score", async () => {
    searchResult.current = {
      candidates: [candidateWithHealth({ isActive: true })],
    };
    const scout = new OssScout("token", ScoutStateSchema.parse({ version: 1 }));
    await scout.search({ maxResults: 5 });

    const record = scout.getRepoScoreRecord("owner/repo");
    expect(record).toBeDefined();
    expect(record!.signals.hasActiveMaintainers).toBe(true);
    // base 5 + active(+1) = 6. isResponsive is NOT set (no real measurement).
    expect(record!.signals.isResponsive).toBe(false);
    expect(record!.score).toBe(6);
  });

  it("leaves hasActiveMaintainers false for an inactive repo", async () => {
    searchResult.current = {
      candidates: [candidateWithHealth({ isActive: false })],
    };
    const scout = new OssScout("token", ScoutStateSchema.parse({ version: 1 }));
    await scout.search({ maxResults: 5 });

    const record = scout.getRepoScoreRecord("owner/repo");
    expect(record!.signals.hasActiveMaintainers).toBe(false);
    expect(record!.score).toBe(5); // no signal adjustments
  });

  it("does not write signals when the health check failed", async () => {
    searchResult.current = {
      candidates: [candidateWithHealth({ checkFailed: true })],
    };
    const scout = new OssScout("token", ScoutStateSchema.parse({ version: 1 }));
    await scout.search({ maxResults: 5 });

    // No score record created from a failed health check.
    expect(scout.getRepoScoreRecord("owner/repo")).toBeUndefined();
  });
});
