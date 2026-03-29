/**
 * E2E test — exercises the full OssScout flow without hitting GitHub.
 *
 * Uses the real OssScout class with provided state, verifying:
 *   search → saveResults → getSavedResults → clearResults
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OssScout } from "../scout.js";
import { ScoutStateSchema } from "../core/schemas.js";
import type { ScoutState } from "../core/schemas.js";
import type { IssueCandidate, SearchResult } from "../core/types.js";

// ── Mock the IssueDiscovery layer (avoids hitting GitHub) ────────────

function makeFakeCandidate(
  overrides: Partial<IssueCandidate> = {},
): IssueCandidate {
  return {
    issue: {
      id: 101,
      url: "https://github.com/test-org/test-repo/issues/7",
      repo: "test-org/test-repo",
      number: 7,
      title: "Add dark mode support",
      status: "candidate",
      labels: ["enhancement", "good first issue"],
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-05T00:00:00Z",
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
      repo: "test-org/test-repo",
      lastCommitAt: "2025-01-04T00:00:00Z",
      daysSinceLastCommit: 1,
      openIssuesCount: 20,
      avgIssueResponseDays: 0.5,
      ciStatus: "passing",
      isActive: true,
    },
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: ["Active project", "Good first issue"],
    viabilityScore: 88,
    searchPriority: "normal",
    ...overrides,
  };
}

vi.mock("../core/issue-discovery.js", () => {
  return {
    IssueDiscovery: class MockIssueDiscovery {
      rateLimitWarning: string | null = null;
      async searchIssues() {
        return {
          candidates: [makeFakeCandidate()],
          strategiesUsed: ["broad" as const],
        };
      }
      async vetIssue() {
        return makeFakeCandidate();
      }
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeState(overrides: Partial<ScoutState> = {}): ScoutState {
  return ScoutStateSchema.parse({ version: 1, ...overrides });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("E2E: search flow", () => {
  let scout: OssScout;

  beforeEach(() => {
    scout = new OssScout("fake-token", makeState());
  });

  it("search returns candidates", async () => {
    const result: SearchResult = await scout.search({ maxResults: 5 });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].issue.repo).toBe("test-org/test-repo");
    expect(result.candidates[0].viabilityScore).toBe(88);
    expect(result.strategiesUsed).toEqual(["broad"]);
  });

  it("saveResults persists candidates to state", async () => {
    const result = await scout.search({ maxResults: 5 });

    scout.saveResults(result.candidates);

    const saved = scout.getSavedResults();
    expect(saved).toHaveLength(1);
    expect(saved[0].issueUrl).toBe(
      "https://github.com/test-org/test-repo/issues/7",
    );
    expect(saved[0].repo).toBe("test-org/test-repo");
    expect(saved[0].number).toBe(7);
    expect(saved[0].title).toBe("Add dark mode support");
    expect(saved[0].viabilityScore).toBe(88);
    expect(saved[0].recommendation).toBe("approve");
  });

  it("getSavedResults returns persisted results", async () => {
    const result = await scout.search({ maxResults: 5 });
    scout.saveResults(result.candidates);

    // Re-read
    const savedAgain = scout.getSavedResults();
    expect(savedAgain).toHaveLength(1);
    expect(savedAgain[0].issueUrl).toBe(
      "https://github.com/test-org/test-repo/issues/7",
    );
  });

  it("clearResults removes all saved results", async () => {
    const result = await scout.search({ maxResults: 5 });
    scout.saveResults(result.candidates);
    expect(scout.getSavedResults()).toHaveLength(1);

    scout.clearResults();

    expect(scout.getSavedResults()).toEqual([]);
  });

  it("full flow: search → save → verify → clear → verify empty", async () => {
    // 1. Search
    const result = await scout.search({ maxResults: 10 });
    expect(result.candidates.length).toBeGreaterThan(0);

    // 2. Save
    scout.saveResults(result.candidates);

    // 3. Verify saved
    const saved = scout.getSavedResults();
    expect(saved).toHaveLength(result.candidates.length);
    expect(saved[0].repo).toBe(result.candidates[0].issue.repo);

    // 4. Clear
    scout.clearResults();

    // 5. Verify empty
    expect(scout.getSavedResults()).toEqual([]);
  });

  it("search updates lastSearchAt in state", async () => {
    const stateBefore = scout.getState();
    expect(stateBefore.lastSearchAt).toBeUndefined();

    await scout.search({ maxResults: 5 });

    const stateAfter = scout.getState();
    expect(stateAfter.lastSearchAt).toBeDefined();
    // Should be a valid ISO date
    const parsed = new Date(stateAfter.lastSearchAt!);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("marks scout as dirty after search", async () => {
    expect(scout.isDirty()).toBe(false);

    await scout.search({ maxResults: 5 });

    expect(scout.isDirty()).toBe(true);
  });

  it("checkpoint resets dirty flag", async () => {
    await scout.search({ maxResults: 5 });
    expect(scout.isDirty()).toBe(true);

    const ok = await scout.checkpoint();

    expect(ok).toBe(true);
    expect(scout.isDirty()).toBe(false);
  });

  it("saveResults deduplicates by URL", async () => {
    const result = await scout.search({ maxResults: 5 });

    scout.saveResults(result.candidates);
    scout.saveResults(result.candidates); // save again

    const saved = scout.getSavedResults();
    expect(saved).toHaveLength(1); // not 2
  });
});
