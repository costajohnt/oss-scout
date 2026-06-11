/**
 * Tests for personalization boost (#1244).
 *
 * Mutation semantics: `annotateBoost` sets `boostScore`/`boostReasons`
 * on each matched candidate. The caller (issue-discovery) re-sorts
 * using those values; these tests just verify the annotation itself.
 */

import { describe, it, expect } from "vitest";
import {
  annotateBoost,
  applyDiversityRatio,
  LANGUAGE_BOOST,
  REPO_BOOST,
} from "./personalization.js";
import type { IssueCandidate } from "./types.js";

function makeCandidate(
  repo: string,
  language: string | null | undefined,
): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: `https://github.com/${repo}/issues/1`,
      repo,
      number: 1,
      title: "Test issue",
      status: "candidate",
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      vetted: true,
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
      lastCommitAt: "",
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
      stargazersCount: 500,
      language,
    },
    antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
    slmTriage: null,
    recommendation: "approve",
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 70,
    searchPriority: "normal",
  };
}

describe("annotateBoost", () => {
  it("is a no-op when no preferences are supplied", () => {
    const candidates = [
      makeCandidate("vercel/next.js", "TypeScript"),
      makeCandidate("rails/rails", "Ruby"),
    ];

    annotateBoost(candidates, undefined, undefined);

    for (const c of candidates) {
      expect(c.boostScore).toBeUndefined();
      expect(c.boostReasons).toBeUndefined();
    }
  });

  it("is a no-op when preference lists are empty", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, [], []);

    expect(candidates[0].boostScore).toBeUndefined();
    expect(candidates[0].boostReasons).toBeUndefined();
  });

  it("matches language case-insensitively and tags reason", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, ["typescript"], undefined);

    expect(candidates[0].boostScore).toBe(LANGUAGE_BOOST);
    expect(candidates[0].boostReasons).toEqual(["language match: TypeScript"]);
  });

  it("matches repo slug exactly and tags reason", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, undefined, ["vercel/next.js"]);

    expect(candidates[0].boostScore).toBe(REPO_BOOST);
    expect(candidates[0].boostReasons).toEqual([
      "repo affinity: vercel/next.js",
    ]);
  });

  it("matches repo slug case-insensitively (#130)", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, undefined, ["Vercel/Next.js"]);

    expect(candidates[0].boostScore).toBe(REPO_BOOST);
    expect(candidates[0].boostReasons).toEqual([
      "repo affinity: vercel/next.js",
    ]);
  });

  it("stacks repo and language boosts when both match", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, ["typescript"], ["vercel/next.js"]);

    expect(candidates[0].boostScore).toBe(REPO_BOOST + LANGUAGE_BOOST);
    expect(candidates[0].boostReasons).toEqual([
      "repo affinity: vercel/next.js",
      "language match: TypeScript",
    ]);
  });

  it("leaves boostScore undefined on candidates that match nothing", () => {
    const candidates = [
      makeCandidate("rails/rails", "Ruby"),
      makeCandidate("vercel/next.js", "TypeScript"),
    ];

    annotateBoost(candidates, ["typescript"], ["vercel/next.js"]);

    expect(candidates[0].boostScore).toBeUndefined();
    expect(candidates[0].boostReasons).toBeUndefined();
    expect(candidates[1].boostScore).toBe(REPO_BOOST + LANGUAGE_BOOST);
  });

  it("handles candidates with null/undefined language without crashing", () => {
    const candidates = [
      makeCandidate("foo/bar", null),
      makeCandidate("baz/qux", undefined),
    ];

    annotateBoost(candidates, ["typescript"], undefined);

    expect(candidates[0].boostScore).toBeUndefined();
    expect(candidates[1].boostScore).toBeUndefined();
  });

  it("trims whitespace and ignores empty entries in preference lists", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(
      candidates,
      [" typescript ", "", "  "],
      [" ", "vercel/next.js"],
    );

    expect(candidates[0].boostScore).toBe(REPO_BOOST + LANGUAGE_BOOST);
  });
});

describe("applyDiversityRatio", () => {
  function boosted(repo: string): IssueCandidate {
    const c = makeCandidate(repo, "TypeScript");
    c.boostScore = REPO_BOOST;
    c.boostReasons = [`repo affinity: ${repo}`];
    return c;
  }

  it("collapses to slice(0, maxResults) when ratio is 0", () => {
    const candidates = [
      boosted("a/b"),
      makeCandidate("c/d", "Go"),
      makeCandidate("e/f", "Python"),
    ];

    const picks = applyDiversityRatio(candidates, 2, 0);

    expect(picks).toHaveLength(2);
    expect(picks[0].issue.repo).toBe("a/b");
    expect(picks[1].issue.repo).toBe("c/d");
    expect(picks.some((p) => p.diversitySlot)).toBe(false);
  });

  it("reserves diversity slots for unboosted candidates", () => {
    const candidates = [
      boosted("a/b"),
      boosted("c/d"),
      boosted("e/f"),
      boosted("g/h"),
      makeCandidate("i/j", "Rust"),
      makeCandidate("k/l", "Elixir"),
    ];

    // 5 results, 40% diversity -> 2 reserve slots, 3 main slots.
    const picks = applyDiversityRatio(candidates, 5, 0.4);

    expect(picks).toHaveLength(5);
    expect(picks.slice(0, 3).every((p) => p.boostScore === REPO_BOOST)).toBe(
      true,
    );
    expect(picks.slice(3).every((p) => p.diversitySlot === true)).toBe(true);
    expect(picks.slice(3).every((p) => !p.boostScore)).toBe(true);
    expect(picks[3].issue.repo).toBe("i/j");
    expect(picks[4].issue.repo).toBe("k/l");
  });

  it("tops up from main pool when diversity pool is too small", () => {
    const candidates = [
      boosted("a/b"),
      boosted("c/d"),
      boosted("e/f"),
      makeCandidate("i/j", "Rust"),
    ];

    // 4 results, 50% diversity -> 2 reserve, 2 main. Only 1 unboosted
    // candidate exists, so the second reserve slot falls back to main.
    const picks = applyDiversityRatio(candidates, 4, 0.5);

    expect(picks).toHaveLength(4);
    expect(picks[0].issue.repo).toBe("a/b");
    expect(picks[1].issue.repo).toBe("c/d");
    expect(picks[2].issue.repo).toBe("i/j");
    expect(picks[2].diversitySlot).toBe(true);
    expect(picks[3].issue.repo).toBe("e/f");
    expect(picks[3].diversitySlot).toBeUndefined();
  });

  it("clamps ratio above 1 to a full diversity pass", () => {
    const candidates = [
      boosted("a/b"),
      boosted("c/d"),
      makeCandidate("i/j", "Rust"),
      makeCandidate("k/l", "Elixir"),
    ];

    // ratio clamped to 1: reserve all slots for diversity. With 2
    // unboosted candidates and 4 main, they fill 2 slots first; the
    // remaining 2 fall back to main pool.
    const picks = applyDiversityRatio(candidates, 4, 1.5);

    expect(picks).toHaveLength(4);
    expect(picks[0].issue.repo).toBe("i/j");
    expect(picks[0].diversitySlot).toBe(true);
    expect(picks[1].issue.repo).toBe("k/l");
    expect(picks[1].diversitySlot).toBe(true);
    expect(picks[2].issue.repo).toBe("a/b");
    expect(picks[3].issue.repo).toBe("c/d");
  });

  it("returns empty for maxResults <= 0", () => {
    const candidates = [boosted("a/b"), makeCandidate("c/d", "Go")];

    expect(applyDiversityRatio(candidates, 0, 0.5)).toEqual([]);
    expect(applyDiversityRatio(candidates, -1, 0.5)).toEqual([]);
  });
});
