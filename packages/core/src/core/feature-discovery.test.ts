import { describe, it, expect } from "vitest";
import type { RepoScore } from "./schemas.js";
import {
  resolveAnchorRepos,
  ANCHOR_THRESHOLD,
  classifyHorizon,
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
