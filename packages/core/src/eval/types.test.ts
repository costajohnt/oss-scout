import { describe, expect, it } from "vitest";
import { loadFixtures } from "./fixture-loader.js";
import { VetFixtureSchema } from "./types.js";

describe("VetFixtureSchema", () => {
  it("accepts a minimal well-formed fixture", () => {
    const fixture = {
      id: "example-1",
      url: "https://github.com/o/r/issues/1",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      vetDate: "2026-01-01",
      issue: {
        title: "t",
        body: "b",
        labels: ["bug"],
        state: "open",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAtObserved: "2026-01-01T00:00:00Z",
      },
      repoMeta: { stars: 10, forks: 2 },
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
      outcome: { label: "merged", date: "2026-01-02", detail: "d" },
      measurable: true,
      expectedVerdict: "pursue",
      fidelityNote: "n",
      vaultSource: "s",
    };
    expect(() => VetFixtureSchema.parse(fixture)).not.toThrow();
  });

  it("rejects an unknown outcome label", () => {
    const fixture = {
      id: "example-1",
      url: "https://github.com/o/r/issues/1",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      vetDate: "2026-01-01",
      issue: {
        title: "t",
        body: "b",
        labels: [],
        state: "open",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAtObserved: "2026-01-01T00:00:00Z",
      },
      repoMeta: { stars: 0, forks: 0 },
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
      outcome: { label: "abandoned_hope", date: "2026-01-02", detail: "d" },
      measurable: true,
      expectedVerdict: "pursue",
      fidelityNote: "n",
      vaultSource: "s",
    };
    expect(() => VetFixtureSchema.parse(fixture)).toThrow();
  });

  it("rejects a negative issueNumber", () => {
    const fixture = {
      id: "example-1",
      url: "https://github.com/o/r/issues/1",
      owner: "o",
      repo: "r",
      issueNumber: -1,
      vetDate: "2026-01-01",
      issue: {
        title: "t",
        body: "b",
        labels: [],
        state: "open",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAtObserved: "2026-01-01T00:00:00Z",
      },
      repoMeta: { stars: 0, forks: 0 },
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
      outcome: { label: "merged", date: "2026-01-02", detail: "d" },
      measurable: true,
      expectedVerdict: "pursue",
      fidelityNote: "n",
      vaultSource: "s",
    };
    expect(() => VetFixtureSchema.parse(fixture)).toThrow();
  });
});

describe("real vet fixtures (eval/fixtures/vet/*.json)", () => {
  const fixtures = loadFixtures();

  it("loads exactly 30 fixtures", () => {
    expect(fixtures.length).toBe(30);
  });

  it("every fixture has a unique id", () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every fixture parses against VetFixtureSchema", () => {
    for (const fixture of fixtures) {
      expect(() => VetFixtureSchema.parse(fixture)).not.toThrow();
    }
  });

  it("every unmeasurable fixture explains why in fidelityNote", () => {
    for (const fixture of fixtures.filter((f) => !f.measurable)) {
      expect(fixture.fidelityNote.length).toBeGreaterThan(20);
    }
  });

  it("covers all four outcome labels", () => {
    const labels = new Set(fixtures.map((f) => f.outcome.label));
    expect(labels).toEqual(
      new Set(["merged", "lost_race", "maintainer_fixed", "skip_correct"]),
    );
  });
});
