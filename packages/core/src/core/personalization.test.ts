/**
 * Tests for personalization boost (#1244, retyped in #158).
 *
 * `annotateBoost` returns a NEW candidate list (no in-place mutation) where
 * matched candidates carry `personalization: { kind: "boosted", ... }`.
 * `applyDiversityRatio` tags reserved picks with `{ kind: "diversity" }` on
 * shallow copies. These tests verify both annotations.
 */

import { describe, it, expect } from "vitest";
import {
  annotateBoost,
  applyDiversityRatio,
  LANGUAGE_BOOST,
  REPO_BOOST,
} from "./personalization.js";
import type { IssueCandidate } from "./types.js";

/** Boost score of a candidate, or undefined if it is not boosted. */
function boostScore(c: IssueCandidate): number | undefined {
  return c.personalization?.kind === "boosted"
    ? c.personalization.score
    : undefined;
}

/** Boost reasons of a candidate, or undefined if it is not boosted. */
function boostReasons(c: IssueCandidate): string[] | undefined {
  return c.personalization?.kind === "boosted"
    ? c.personalization.reasons
    : undefined;
}

/** Whether a candidate filled a diversity slot. */
function isDiversity(c: IssueCandidate): boolean {
  return c.personalization?.kind === "diversity";
}

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

    const out = annotateBoost(candidates, undefined, undefined);

    for (const c of out) {
      expect(c.personalization).toBeUndefined();
    }
  });

  it("is a no-op when preference lists are empty", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    const out = annotateBoost(candidates, [], []);

    expect(out[0].personalization).toBeUndefined();
  });

  it("does not mutate the input candidates", () => {
    const candidates = [makeCandidate("vercel/next.js", "TypeScript")];

    annotateBoost(candidates, ["typescript"], ["vercel/next.js"]);

    // The original object is untouched; the boost lives on the returned copy.
    expect(candidates[0].personalization).toBeUndefined();
  });

  it("matches language case-insensitively and tags reason", () => {
    const out = annotateBoost(
      [makeCandidate("vercel/next.js", "TypeScript")],
      ["typescript"],
      undefined,
    );

    expect(boostScore(out[0])).toBe(LANGUAGE_BOOST);
    expect(boostReasons(out[0])).toEqual(["language match: TypeScript"]);
  });

  it("matches repo slug exactly and tags reason", () => {
    const out = annotateBoost(
      [makeCandidate("vercel/next.js", "TypeScript")],
      undefined,
      ["vercel/next.js"],
    );

    expect(boostScore(out[0])).toBe(REPO_BOOST);
    expect(boostReasons(out[0])).toEqual(["repo affinity: vercel/next.js"]);
  });

  it("matches repo slug case-insensitively (#130)", () => {
    const out = annotateBoost(
      [makeCandidate("vercel/next.js", "TypeScript")],
      undefined,
      ["Vercel/Next.js"],
    );

    expect(boostScore(out[0])).toBe(REPO_BOOST);
    expect(boostReasons(out[0])).toEqual(["repo affinity: vercel/next.js"]);
  });

  it("stacks repo and language boosts when both match", () => {
    const out = annotateBoost(
      [makeCandidate("vercel/next.js", "TypeScript")],
      ["typescript"],
      ["vercel/next.js"],
    );

    expect(boostScore(out[0])).toBe(REPO_BOOST + LANGUAGE_BOOST);
    expect(boostReasons(out[0])).toEqual([
      "repo affinity: vercel/next.js",
      "language match: TypeScript",
    ]);
  });

  it("leaves personalization undefined on candidates that match nothing", () => {
    const out = annotateBoost(
      [
        makeCandidate("rails/rails", "Ruby"),
        makeCandidate("vercel/next.js", "TypeScript"),
      ],
      ["typescript"],
      ["vercel/next.js"],
    );

    expect(out[0].personalization).toBeUndefined();
    expect(boostScore(out[1])).toBe(REPO_BOOST + LANGUAGE_BOOST);
  });

  it("handles candidates with null/undefined language without crashing", () => {
    const out = annotateBoost(
      [makeCandidate("foo/bar", null), makeCandidate("baz/qux", undefined)],
      ["typescript"],
      undefined,
    );

    expect(out[0].personalization).toBeUndefined();
    expect(out[1].personalization).toBeUndefined();
  });

  it("trims whitespace and ignores empty entries in preference lists", () => {
    const out = annotateBoost(
      [makeCandidate("vercel/next.js", "TypeScript")],
      [" typescript ", "", "  "],
      [" ", "vercel/next.js"],
    );

    expect(boostScore(out[0])).toBe(REPO_BOOST + LANGUAGE_BOOST);
  });
});

describe("applyDiversityRatio", () => {
  function boosted(repo: string): IssueCandidate {
    const c = makeCandidate(repo, "TypeScript");
    c.personalization = {
      kind: "boosted",
      score: REPO_BOOST,
      reasons: [`repo affinity: ${repo}`],
    };
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
    expect(picks.some(isDiversity)).toBe(false);
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
    expect(picks.slice(0, 3).every((p) => boostScore(p) === REPO_BOOST)).toBe(
      true,
    );
    expect(picks.slice(3).every(isDiversity)).toBe(true);
    expect(picks.slice(3).every((p) => boostScore(p) === undefined)).toBe(true);
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
    expect(isDiversity(picks[2])).toBe(true);
    expect(picks[3].issue.repo).toBe("e/f");
    // e/f is a boosted top-up pick, not a diversity slot.
    expect(isDiversity(picks[3])).toBe(false);
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
    expect(isDiversity(picks[0])).toBe(true);
    expect(picks[1].issue.repo).toBe("k/l");
    expect(isDiversity(picks[1])).toBe(true);
    expect(picks[2].issue.repo).toBe("a/b");
    expect(picks[3].issue.repo).toBe("c/d");
  });

  it("returns empty for maxResults <= 0", () => {
    const candidates = [boosted("a/b"), makeCandidate("c/d", "Go")];

    expect(applyDiversityRatio(candidates, 0, 0.5)).toEqual([]);
    expect(applyDiversityRatio(candidates, -1, 0.5)).toEqual([]);
  });
});
