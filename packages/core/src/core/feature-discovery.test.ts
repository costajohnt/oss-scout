import { describe, it, expect } from "vitest";
import type { RepoScore } from "./schemas.js";
import {
  resolveAnchorRepos,
  ANCHOR_THRESHOLD,
  classifyHorizon,
  splitByHorizon,
  type FeatureCandidate,
} from "./feature-discovery.js";

const mkScore = (repo: string, mergedPRCount: number): RepoScore => ({
  repo,
  score: 5,
  mergedPRCount,
  closedWithoutMergeCount: 0,
  avgResponseDays: null,
  lastEvaluatedAt: "2026-05-08T00:00:00Z",
  signals: {
    hasActiveMaintainers: true,
    isResponsive: true,
    hasHostileComments: false,
  },
});

const mkScores = (
  ...entries: Array<[string, number]>
): Record<string, RepoScore> =>
  Object.fromEntries(
    entries.map(([repo, count]) => [repo, mkScore(repo, count)]),
  );

describe("resolveAnchorRepos", () => {
  it("returns empty array when no scores meet threshold", () => {
    const out = resolveAnchorRepos(mkScores(["a/b", 1], ["c/d", 2]));
    expect(out).toEqual([]);
  });
  it("filters by ANCHOR_THRESHOLD (3)", () => {
    expect(ANCHOR_THRESHOLD).toBe(3);
    const out = resolveAnchorRepos(
      mkScores(["a/b", 2], ["c/d", 3], ["e/f", 5]),
    );
    expect(out).toEqual(["e/f", "c/d"]);
  });
  it("sorts by mergedPRCount desc", () => {
    const out = resolveAnchorRepos(
      mkScores(["a/b", 4], ["c/d", 10], ["e/f", 7]),
    );
    expect(out).toEqual(["c/d", "e/f", "a/b"]);
  });
});

describe("classifyHorizon", () => {
  it("returns bigger-bet when issue has a milestone", () => {
    expect(classifyHorizon({ hasMilestone: true, labels: [] })).toBe(
      "bigger-bet",
    );
  });
  it("returns bigger-bet for roadmap label", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["roadmap"] })).toBe(
      "bigger-bet",
    );
  });
  it("returns bigger-bet for accepted-rfc label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["accepted-rfc"] }),
    ).toBe("bigger-bet");
  });
  it("returns bigger-bet for proposal label", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["proposal"] })).toBe(
      "bigger-bet",
    );
  });
  it("returns quick-win for plain enhancement label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["enhancement"] }),
    ).toBe("quick-win");
  });
  it("returns quick-win when no signals fire", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: [] })).toBe(
      "quick-win",
    );
  });
  it("is case-insensitive on label matching", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["Roadmap"] })).toBe(
      "bigger-bet",
    );
  });
});

const mkCand = (
  url: string,
  score: number,
  horizon: "quick-win" | "bigger-bet",
): FeatureCandidate =>
  ({
    issue: {
      url,
      repo: "x/y",
      number: 1,
      title: url,
      labels: [],
      updatedAt: "2026-05-08",
    },
    vettingResult: {} as never,
    projectHealth: {} as never,
    antiLLMPolicy: {} as never,
    slmTriage: null,
    recommendation: "approve",
    reasonsToApprove: [],
    reasonsToSkip: [],
    viabilityScore: score,
    searchPriority: "merged_pr",
    horizon,
  }) as never;

describe("splitByHorizon 60/40 split", () => {
  const quickWinPool = [
    mkCand("q1", 90, "quick-win"),
    mkCand("q2", 88, "quick-win"),
    mkCand("q3", 85, "quick-win"),
    mkCand("q4", 82, "quick-win"),
    mkCand("q5", 80, "quick-win"),
    mkCand("q6", 78, "quick-win"),
    mkCand("q7", 75, "quick-win"),
    mkCand("q8", 72, "quick-win"),
  ];
  const biggerBetPool = [
    mkCand("b1", 95, "bigger-bet"),
    mkCand("b2", 92, "bigger-bet"),
    mkCand("b3", 88, "bigger-bet"),
    mkCand("b4", 85, "bigger-bet"),
    mkCand("b5", 80, "bigger-bet"),
  ];

  it("returns 6 quick + 4 bigger when count=10 and both abundant", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins).toHaveLength(6);
    expect(out.biggerBets).toHaveLength(4);
  });
  it("returns 3 quick + 2 bigger when count=5", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 5);
    expect(out.quickWins).toHaveLength(3);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("redirects deficit to other bucket when one is short", () => {
    const out = splitByHorizon(
      [...quickWinPool, biggerBetPool[0], biggerBetPool[1]],
      10,
    );
    // target 6+4, but only 2 bigger bets exist → fill quick to 8.
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("returns all of one bucket when other is empty", () => {
    const out = splitByHorizon([...quickWinPool], 10);
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(0);
  });
  it("sorts each bucket by score desc", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins.map((c) => c.viabilityScore)).toEqual([
      90, 88, 85, 82, 80, 78,
    ]);
    expect(out.biggerBets.map((c) => c.viabilityScore)).toEqual([
      95, 92, 88, 85,
    ]);
  });
});
