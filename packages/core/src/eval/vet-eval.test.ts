import { describe, expect, it } from "vitest";
import type { VetFixture } from "./types.js";
import {
  gradeVerdict,
  runFixture,
  summarize,
  syntheticUpdatedAt,
} from "./vet-eval.js";

function makeFixture(overrides: Partial<VetFixture> = {}): VetFixture {
  return {
    id: "synthetic-1",
    url: "https://github.com/o/r/issues/1",
    owner: "o",
    repo: "r",
    issueNumber: 1,
    vetDate: "2026-01-01",
    issue: {
      title: "A clear bug report",
      body:
        "Steps to reproduce:\n1. Do the thing\n2. Watch it fail\n\nExpected: it should not fail. " +
        "This is a longer body so the length indicator crosses the 200-char threshold easily, " +
        "giving analyzeRequirements enough signal to call this clear.",
      labels: ["bug"],
      state: "open",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAtObserved: "2026-01-01T00:00:00Z",
    },
    repoMeta: { stars: 100, forks: 10 },
    vetTimeFacts: {
      hasExistingPR: false,
      isClaimed: false,
      projectActive: true,
      contributionGuidelinesFound: true,
      mergedPRCount: 0,
      orgHasMergedPRs: false,
      matchesPreferredCategory: false,
      closedWithoutMergeCount: 0,
    },
    outcome: { label: "merged", date: "2026-01-02", detail: "test fixture" },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "synthetic test fixture",
    vaultSource: "test",
    ...overrides,
  };
}

describe("gradeVerdict", () => {
  it("grades an approve on an expected-pursue fixture as correct", () => {
    expect(gradeVerdict("approve", "pursue")).toBe("correct");
  });
  it("grades a needs_review on an expected-pursue fixture as cautious", () => {
    expect(gradeVerdict("needs_review", "pursue")).toBe("cautious");
  });
  it("grades a skip on an expected-pursue fixture as wrong", () => {
    expect(gradeVerdict("skip", "pursue")).toBe("wrong");
  });
  it("grades a skip on an expected-skip fixture as correct", () => {
    expect(gradeVerdict("skip", "skip")).toBe("correct");
  });
  it("grades a needs_review on an expected-skip fixture as cautious", () => {
    expect(gradeVerdict("needs_review", "skip")).toBe("cautious");
  });
  it("grades an approve on an expected-skip fixture as wrong", () => {
    expect(gradeVerdict("approve", "skip")).toBe("wrong");
  });
});

describe("syntheticUpdatedAt", () => {
  it("preserves the vet-time freshness gap against a fixed 'now'", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    // Issue was updated exactly on vetDate (0-day-old at vet time) —
    // synthetic timestamp should land exactly on `now`.
    const result = syntheticUpdatedAt(
      "2026-06-01T00:00:00Z",
      "2026-06-01",
      now,
    );
    expect(new Date(result).getTime()).toBe(now.getTime());
  });

  it("preserves a nonzero staleness gap", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    // Issue was already 10 days stale at vet time.
    const result = syntheticUpdatedAt(
      "2026-05-22T00:00:00Z",
      "2026-06-01",
      now,
    );
    const gapDays =
      (now.getTime() - new Date(result).getTime()) / (1000 * 60 * 60 * 24);
    expect(gapDays).toBeCloseTo(10, 5);
  });

  it("never produces a negative gap when updatedAt is after vetDate", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    const result = syntheticUpdatedAt(
      "2026-06-10T00:00:00Z",
      "2026-06-01",
      now,
    );
    expect(new Date(result).getTime()).toBe(now.getTime());
  });
});

describe("runFixture", () => {
  it("recommends approve for a clean pursue-shaped fixture", () => {
    const result = runFixture(makeFixture());
    expect(result.recommendation).toBe("approve");
    expect(result.pursued).toBe(true);
    expect(result.verdictGrade).toBe("correct");
  });

  it(
    "does not recommend a hard skip for a single existing-PR signal, " +
      "and grades that as cautious rather than wrong (real deriveRecommendation " +
      "behavior: skip requires >2 reasonsToSkip)",
    () => {
      const result = runFixture(
        makeFixture({
          vetTimeFacts: {
            hasExistingPR: true,
            isClaimed: false,
            projectActive: true,
            contributionGuidelinesFound: true,
            mergedPRCount: 0,
            orgHasMergedPRs: false,
            matchesPreferredCategory: false,
            closedWithoutMergeCount: 0,
          },
          outcome: {
            label: "skip_correct",
            date: "2026-01-02",
            detail: "taken",
          },
          expectedVerdict: "skip",
        }),
      );
      expect(result.recommendation).toBe("needs_review");
      expect(result.verdictGrade).toBe("cautious");
    },
  );

  it("recommends skip when enough negative signals stack up", () => {
    const result = runFixture(
      makeFixture({
        vetTimeFacts: {
          hasExistingPR: true,
          isClaimed: true,
          projectActive: false,
          contributionGuidelinesFound: false,
          mergedPRCount: 0,
          orgHasMergedPRs: false,
          matchesPreferredCategory: false,
          closedWithoutMergeCount: 0,
        },
        outcome: { label: "skip_correct", date: "2026-01-02", detail: "dead" },
        expectedVerdict: "skip",
      }),
    );
    expect(result.recommendation).toBe("skip");
    expect(result.verdictGrade).toBe("correct");
  });

  it("marks unmeasurable fixtures as cautious regardless of recommendation", () => {
    const result = runFixture(makeFixture({ measurable: false }));
    expect(result.verdictGrade).toBe("cautious");
  });

  it("computes clearRequirements from the real issue body via analyzeRequirements", () => {
    const result = runFixture(
      makeFixture({ issue: { ...makeFixture().issue, body: "short" } }),
    );
    expect(result.clearRequirements).toBe(false);
  });
});

describe("summarize", () => {
  it("excludes unmeasurable fixtures from accuracy but includes them in byOutcomeLabel", () => {
    const results = [
      runFixture(makeFixture({ id: "a" })),
      runFixture(
        makeFixture({
          id: "b",
          measurable: false,
          outcome: { label: "lost_race", date: "2026-01-02", detail: "x" },
        }),
      ),
    ];
    const summary = summarize(results);
    expect(summary.accuracy.total).toBe(1);
    expect(summary.unmeasurable.length).toBe(1);
    expect(Object.keys(summary.byOutcomeLabel).sort()).toEqual([
      "lost_race",
      "merged",
    ]);
  });

  it("computes lenientRate and strictRate distinctly when needs_review is involved", () => {
    const cautiousResult = runFixture(
      makeFixture({
        id: "c",
        vetTimeFacts: {
          hasExistingPR: true,
          isClaimed: false,
          projectActive: true,
          contributionGuidelinesFound: true,
          mergedPRCount: 0,
          orgHasMergedPRs: false,
          matchesPreferredCategory: false,
          closedWithoutMergeCount: 0,
        },
        outcome: { label: "skip_correct", date: "2026-01-02", detail: "taken" },
        expectedVerdict: "skip",
      }),
    );
    const summary = summarize([cautiousResult]);
    expect(summary.accuracy.strictRate).toBe(0);
    expect(summary.accuracy.lenientRate).toBe(1);
  });
});
