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
