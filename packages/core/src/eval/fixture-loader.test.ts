import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureSetHash, loadFixtures, quickSubset } from "./fixture-loader.js";
import type { VetFixture } from "./types.js";

function makeFixture(
  id: string,
  outcomeLabel: VetFixture["outcome"]["label"],
): VetFixture {
  return {
    id,
    url: `https://github.com/o/r/issues/${id}`,
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
    repoMeta: { stars: 1, forks: 1 },
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
    outcome: { label: outcomeLabel, date: "2026-01-02", detail: "d" },
    measurable: true,
    expectedVerdict: "pursue",
    fidelityNote: "n",
    vaultSource: "test",
  };
}

describe("loadFixtures", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vet-fixtures-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads and validates fixtures from a directory, sorted by filename", () => {
    writeFileSync(
      path.join(dir, "b.json"),
      JSON.stringify(makeFixture("b", "merged")),
    );
    writeFileSync(
      path.join(dir, "a.json"),
      JSON.stringify(makeFixture("a", "skip_correct")),
    );
    const fixtures = loadFixtures(dir);
    expect(fixtures.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("throws on a fixture that fails schema validation", () => {
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ id: "bad" }));
    expect(() => loadFixtures(dir)).toThrow();
  });

  it("ignores non-JSON files in the directory", () => {
    writeFileSync(
      path.join(dir, "a.json"),
      JSON.stringify(makeFixture("a", "merged")),
    );
    writeFileSync(path.join(dir, "README.md"), "not a fixture");
    expect(loadFixtures(dir).length).toBe(1);
  });
});

describe("fixtureSetHash", () => {
  it("is stable for the same fixture content regardless of array order", () => {
    const a = makeFixture("a", "merged");
    const b = makeFixture("b", "skip_correct");
    expect(fixtureSetHash([a, b])).toBe(fixtureSetHash([b, a]));
  });

  it("changes when any fixture's content changes", () => {
    const a = makeFixture("a", "merged");
    const aEdited = { ...a, issue: { ...a.issue, title: "different title" } };
    expect(fixtureSetHash([a])).not.toBe(fixtureSetHash([aEdited]));
  });

  it("changes when a fixture is added or removed", () => {
    const a = makeFixture("a", "merged");
    const b = makeFixture("b", "skip_correct");
    expect(fixtureSetHash([a])).not.toBe(fixtureSetHash([a, b]));
  });
});

describe("quickSubset", () => {
  it("includes at least one fixture per outcome label present", () => {
    const fixtures = [
      makeFixture("m1", "merged"),
      makeFixture("m2", "merged"),
      makeFixture("lr", "lost_race"),
      makeFixture("mf", "maintainer_fixed"),
      makeFixture("sk", "skip_correct"),
    ];
    const subset = quickSubset(fixtures);
    const labels = new Set(subset.map((f) => f.outcome.label));
    expect(labels).toEqual(
      new Set(["merged", "lost_race", "maintainer_fixed", "skip_correct"]),
    );
  });

  it("caps out around 10 fixtures even when given many more", () => {
    const fixtures = Array.from({ length: 30 }, (_, i) =>
      makeFixture(`f${i}`, i % 2 === 0 ? "merged" : "skip_correct"),
    );
    expect(quickSubset(fixtures).length).toBeLessThanOrEqual(10);
  });

  it("never returns more fixtures than it was given", () => {
    const fixtures = [makeFixture("only", "merged")];
    expect(quickSubset(fixtures).length).toBe(1);
  });
});
