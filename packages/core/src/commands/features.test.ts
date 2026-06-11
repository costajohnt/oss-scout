import { describe, it, expect, vi, beforeEach } from "vitest";
import { runFeatures } from "./features.js";
import { createScout } from "../scout.js";
import type { FeatureCandidate } from "../core/feature-discovery.js";
import type { LinkedPR } from "../core/schemas.js";

vi.mock("../scout.js", () => ({
  createScout: vi.fn(),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
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
}));

function makeFeatureCandidate(
  horizon: "quick-win" | "bigger-bet",
  linkedPR?: LinkedPR,
): FeatureCandidate {
  return {
    issue: {
      id: 1,
      url: "https://github.com/test/repo/issues/42",
      repo: "test/repo",
      number: 42,
      title: "Add a thing",
      status: "candidate",
      labels: ["enhancement"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      vetted: true,
    },
    vettingResult: {
      passedAllChecks: linkedPR ? false : true,
      checks: {
        noExistingPR: !linkedPR,
        notClaimed: true,
        projectActive: true,
        clearRequirements: true,
        contributionGuidelinesFound: true,
      },
      notes: [],
      linkedPR: linkedPR ?? null,
    },
    projectHealth: {
      repo: "test/repo",
      lastCommitAt: "2026-01-01T00:00:00Z",
      daysSinceLastCommit: 5,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
    },
    antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
    slmTriage: null,
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 70,
    searchPriority: "normal",
    horizon,
  };
}

describe("runFeatures", () => {
  let featuresFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    featuresFn = vi.fn().mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: "No anchor repos yet",
    });
    vi.mocked(createScout).mockResolvedValue({
      features: featuresFn,
      getState: () => ({}),
      saveResults: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(true),
      getRepoScoreRecord: vi.fn().mockReturnValue(undefined),
    } as never);
  });

  it("returns the features result envelope", async () => {
    const out = await runFeatures({ maxResults: 10 });
    expect(out.quickWins).toEqual([]);
    expect(out.biggerBets).toEqual([]);
    expect(out.message).toBe("No anchor repos yet");
  });

  it("forwards anchorThreshold and splitRatio to scout.features", async () => {
    await runFeatures({
      maxResults: 8,
      anchorThreshold: 4,
      splitRatio: 0.3,
    });
    expect(featuresFn).toHaveBeenCalledWith({
      count: 8,
      anchorThreshold: 4,
      splitRatio: 0.3,
    });
  });

  it("passes undefined overrides through unchanged", async () => {
    await runFeatures({ maxResults: 5 });
    expect(featuresFn).toHaveBeenCalledWith({
      count: 5,
      anchorThreshold: undefined,
      splitRatio: undefined,
    });
  });

  it("marks linkedPR.isStalled on quick-win candidates with stale linked PRs (#97)", async () => {
    const stale = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeFeatureCandidate("quick-win", {
      number: 99,
      author: "alice",
      state: "open",
      merged: false,
      url: "https://github.com/test/repo/pull/99",
      updatedAt: stale,
    });
    featuresFn.mockResolvedValue({
      quickWins: [candidate],
      biggerBets: [],
      anchorRepos: ["test/repo"],
      message: null,
    });

    const out = await runFeatures({ maxResults: 5 });
    expect(out.quickWins[0].linkedPR).toBeDefined();
    expect(out.quickWins[0].linkedPR!.number).toBe(99);
    expect(out.quickWins[0].linkedPR!.isStalled).toBe(true);
  });

  it("marks linkedPR.isStalled on bigger-bet candidates with stale linked PRs (#97)", async () => {
    const stale = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeFeatureCandidate("bigger-bet", {
      number: 200,
      author: "bob",
      state: "open",
      merged: false,
      url: "https://github.com/test/repo/pull/200",
      updatedAt: stale,
    });
    featuresFn.mockResolvedValue({
      quickWins: [],
      biggerBets: [candidate],
      anchorRepos: ["test/repo"],
      message: null,
    });

    const out = await runFeatures({ maxResults: 5 });
    expect(out.biggerBets[0].linkedPR!.isStalled).toBe(true);
  });

  it("does not flag fresh linked PRs as stalled (#97)", async () => {
    const fresh = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = makeFeatureCandidate("quick-win", {
      number: 101,
      author: "alice",
      state: "open",
      merged: false,
      url: "https://github.com/test/repo/pull/101",
      updatedAt: fresh,
    });
    featuresFn.mockResolvedValue({
      quickWins: [candidate],
      biggerBets: [],
      anchorRepos: ["test/repo"],
      message: null,
    });

    const out = await runFeatures({ maxResults: 5 });
    expect(out.quickWins[0].linkedPR!.isStalled).toBe(false);
  });

  it("omits linkedPR when no PR is linked (#97)", async () => {
    const candidate = makeFeatureCandidate("quick-win");
    featuresFn.mockResolvedValue({
      quickWins: [candidate],
      biggerBets: [],
      anchorRepos: ["test/repo"],
      message: null,
    });

    const out = await runFeatures({ maxResults: 5 });
    expect(out.quickWins[0].linkedPR).toBeUndefined();
  });
});
