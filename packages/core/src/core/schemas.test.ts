import { describe, it, expect } from "vitest";
import {
  ScoutStateSchema,
  ScoutPreferencesSchema,
  parseScoutState,
  RepoScoreSchema,
  SavedCandidateSchema,
  HorizonSchema,
  LinkedPRSchema,
} from "./schemas.js";

describe("ScoutStateSchema", () => {
  it("parses minimal valid state", () => {
    const state = ScoutStateSchema.parse({ version: 1 });
    expect(state.version).toBe(1);
    expect(state.preferences.languages).toEqual(["any"]);
    expect(state.repoScores).toEqual({});
    expect(state.starredRepos).toEqual([]);
    expect(state.mergedPRs).toEqual([]);
    expect(state.closedPRs).toEqual([]);
  });

  it("rejects wrong version", () => {
    expect(() => ScoutStateSchema.parse({ version: 2 })).toThrow();
    expect(() => ScoutStateSchema.parse({ version: 0 })).toThrow();
  });

  it("applies preference defaults", () => {
    const state = ScoutStateSchema.parse({ version: 1 });
    expect(state.preferences.minStars).toBe(50);
    expect(state.preferences.maxIssueAgeDays).toBe(90);
    expect(state.preferences.includeDocIssues).toBe(true);
    expect(state.preferences.minRepoScoreThreshold).toBe(4);
    expect(state.preferences.interPhaseDelayMs).toBe(30000);
    expect(state.preferences.aiPolicyBlocklist).toEqual([
      "matplotlib/matplotlib",
    ]);
  });

  it("accepts custom preferences", () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: {
        githubUsername: "testuser",
        languages: ["python"],
        labels: ["help wanted"],
        minStars: 100,
      },
    });
    expect(state.preferences.githubUsername).toBe("testuser");
    expect(state.preferences.languages).toEqual(["python"]);
    expect(state.preferences.minStars).toBe(100);
  });

  it("accepts repo scores", () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      repoScores: {
        "owner/repo": {
          repo: "owner/repo",
          score: 8,
          mergedPRCount: 3,
          closedWithoutMergeCount: 0,
          avgResponseDays: 2.5,
          lastEvaluatedAt: "2025-01-01T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });
    expect(state.repoScores["owner/repo"].score).toBe(8);
  });

  it("accepts merged and closed PRs", () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      mergedPRs: [
        {
          url: "https://github.com/o/r/pull/1",
          title: "Fix bug",
          mergedAt: "2025-01-01T00:00:00Z",
        },
      ],
      closedPRs: [
        {
          url: "https://github.com/o/r/pull/2",
          title: "Rejected",
          closedAt: "2025-01-01T00:00:00Z",
        },
      ],
    });
    expect(state.mergedPRs).toHaveLength(1);
    expect(state.closedPRs).toHaveLength(1);
  });
});

describe("ScoutPreferencesSchema", () => {
  it("applies all defaults", () => {
    const prefs = ScoutPreferencesSchema.parse({});
    expect(prefs.githubUsername).toBe("");
    expect(prefs.languages).toEqual(["any"]);
    expect(prefs.labels).toEqual(["good first issue", "help wanted"]);
    expect(prefs.excludeRepos).toEqual([]);
    expect(prefs.projectCategories).toEqual([]);
  });

  it("validates scope enum values", () => {
    const prefs = ScoutPreferencesSchema.parse({
      scope: ["beginner", "intermediate"],
    });
    expect(prefs.scope).toEqual(["beginner", "intermediate"]);
  });

  it("rejects invalid scope values", () => {
    expect(() => ScoutPreferencesSchema.parse({ scope: ["expert"] })).toThrow();
  });

  it("validates project category enum values", () => {
    const prefs = ScoutPreferencesSchema.parse({
      projectCategories: ["devtools", "education"],
    });
    expect(prefs.projectCategories).toEqual(["devtools", "education"]);
  });

  it("defaults interPhaseDelayMs to 30000", () => {
    const prefs = ScoutPreferencesSchema.parse({});
    expect(prefs.interPhaseDelayMs).toBe(30000);
  });

  it("accepts custom interPhaseDelayMs", () => {
    const prefs = ScoutPreferencesSchema.parse({ interPhaseDelayMs: 5000 });
    expect(prefs.interPhaseDelayMs).toBe(5000);
  });

  it("accepts interPhaseDelayMs of 0 (no delay)", () => {
    const prefs = ScoutPreferencesSchema.parse({ interPhaseDelayMs: 0 });
    expect(prefs.interPhaseDelayMs).toBe(0);
  });

  it("rejects interPhaseDelayMs above 120000", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ interPhaseDelayMs: 200000 }),
    ).toThrow();
  });

  it("rejects negative interPhaseDelayMs", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ interPhaseDelayMs: -1 }),
    ).toThrow();
  });

  it("applies broadPhaseDelayMs default of 0 (broad phase now runs on GraphQL)", () => {
    const prefs = ScoutPreferencesSchema.parse({});
    expect(prefs.broadPhaseDelayMs).toBe(0);
  });

  it("applies skipBroadWhenSufficientResults default of 8 (below default maxResults)", () => {
    const prefs = ScoutPreferencesSchema.parse({});
    expect(prefs.skipBroadWhenSufficientResults).toBe(8);
  });

  it("accepts custom broadPhaseDelayMs", () => {
    const prefs = ScoutPreferencesSchema.parse({ broadPhaseDelayMs: 60000 });
    expect(prefs.broadPhaseDelayMs).toBe(60000);
  });

  it("rejects broadPhaseDelayMs exceeding 300000", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ broadPhaseDelayMs: 400000 }),
    ).toThrow();
  });

  it("accepts skipBroadWhenSufficientResults of 0", () => {
    const prefs = ScoutPreferencesSchema.parse({
      skipBroadWhenSufficientResults: 0,
    });
    expect(prefs.skipBroadWhenSufficientResults).toBe(0);
  });

  it("defaults featuresAnchorThreshold to 3 and featuresSplitRatio to 0.6", () => {
    const prefs = ScoutPreferencesSchema.parse({});
    expect(prefs.featuresAnchorThreshold).toBe(3);
    expect(prefs.featuresSplitRatio).toBe(0.6);
  });

  it("accepts custom featuresAnchorThreshold and featuresSplitRatio", () => {
    const prefs = ScoutPreferencesSchema.parse({
      featuresAnchorThreshold: 5,
      featuresSplitRatio: 0.4,
    });
    expect(prefs.featuresAnchorThreshold).toBe(5);
    expect(prefs.featuresSplitRatio).toBe(0.4);
  });

  it("rejects featuresAnchorThreshold below 1", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ featuresAnchorThreshold: 0 }),
    ).toThrow();
  });

  it("rejects featuresAnchorThreshold above 50", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ featuresAnchorThreshold: 51 }),
    ).toThrow();
  });

  it("rejects non-integer featuresAnchorThreshold", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ featuresAnchorThreshold: 3.5 }),
    ).toThrow();
  });

  it("rejects featuresSplitRatio outside 0..1", () => {
    expect(() =>
      ScoutPreferencesSchema.parse({ featuresSplitRatio: -0.1 }),
    ).toThrow();
    expect(() =>
      ScoutPreferencesSchema.parse({ featuresSplitRatio: 1.1 }),
    ).toThrow();
  });
});

describe("RepoScoreSchema", () => {
  it("requires all mandatory fields", () => {
    expect(() => RepoScoreSchema.parse({})).toThrow();
  });

  it("parses valid repo score", () => {
    const score = RepoScoreSchema.parse({
      repo: "owner/repo",
      score: 7,
      mergedPRCount: 2,
      closedWithoutMergeCount: 1,
      avgResponseDays: null,
      lastEvaluatedAt: "2025-01-01T00:00:00Z",
      signals: {
        hasActiveMaintainers: true,
        isResponsive: false,
        hasHostileComments: false,
      },
    });
    expect(score.score).toBe(7);
    expect(score.avgResponseDays).toBeNull();
  });

  it("accepts optional fields", () => {
    const score = RepoScoreSchema.parse({
      repo: "owner/repo",
      score: 5,
      mergedPRCount: 0,
      closedWithoutMergeCount: 0,
      avgResponseDays: null,
      lastEvaluatedAt: "2025-01-01T00:00:00Z",
      signals: {
        hasActiveMaintainers: false,
        isResponsive: false,
        hasHostileComments: false,
      },
      stargazersCount: 5000,
      language: "typescript",
      lastMergedAt: "2025-01-01T00:00:00Z",
    });
    expect(score.stargazersCount).toBe(5000);
    expect(score.language).toBe("typescript");
  });
});

describe("HorizonSchema", () => {
  it("accepts quick-win and bigger-bet", () => {
    expect(HorizonSchema.parse("quick-win")).toBe("quick-win");
    expect(HorizonSchema.parse("bigger-bet")).toBe("bigger-bet");
  });
  it("rejects unknown values", () => {
    expect(() => HorizonSchema.parse("medium")).toThrow();
  });
});

describe("LinkedPRSchema", () => {
  const base = {
    number: 99,
    author: "alice",
    state: "open" as const,
    merged: false,
    url: "https://github.com/foo/bar/pull/99",
  };
  it("validates without updatedAt (backwards compat)", () => {
    const parsed = LinkedPRSchema.parse(base);
    expect(parsed.updatedAt).toBeUndefined();
    expect(parsed.number).toBe(99);
  });
  it("validates with updatedAt populated", () => {
    const parsed = LinkedPRSchema.parse({
      ...base,
      updatedAt: "2026-01-01T00:00:00Z",
    });
    expect(parsed.updatedAt).toBe("2026-01-01T00:00:00Z");
  });
  it("rejects non-string updatedAt", () => {
    expect(() => LinkedPRSchema.parse({ ...base, updatedAt: 12345 })).toThrow();
  });
});

describe("SavedCandidateSchema horizon field", () => {
  const base = {
    issueUrl: "https://github.com/foo/bar/issues/1",
    repo: "foo/bar",
    number: 1,
    title: "t",
    labels: [],
    recommendation: "approve" as const,
    viabilityScore: 80,
    searchPriority: "merged_pr" as const,
    firstSeenAt: "2026-05-08T00:00:00Z",
    lastSeenAt: "2026-05-08T00:00:00Z",
    lastScore: 80,
  };
  it("validates without horizon (backwards compat)", () => {
    expect(() => SavedCandidateSchema.parse(base)).not.toThrow();
  });
  it("validates with horizon set", () => {
    expect(() =>
      SavedCandidateSchema.parse({ ...base, horizon: "quick-win" }),
    ).not.toThrow();
  });
});

// ── parseScoutState / unknown-key round-trip (#137) ─────────────────

describe("parseScoutState", () => {
  it("round-trips unknown top-level keys instead of stripping them", () => {
    const parsed = parseScoutState({
      version: 1,
      futureTopLevelField: { from: "a newer binary" },
    });
    expect((parsed as Record<string, unknown>).futureTopLevelField).toEqual({
      from: "a newer binary",
    });
  });

  it("round-trips unknown keys on nested persisted objects", () => {
    const parsed = parseScoutState({
      version: 1,
      preferences: { futurePref: true },
      savedResults: [
        {
          issueUrl: "https://github.com/o/r/issues/1",
          repo: "o/r",
          number: 1,
          title: "t",
          labels: [],
          recommendation: "approve",
          viabilityScore: 80,
          searchPriority: "normal",
          firstSeenAt: "2026-05-08T00:00:00Z",
          lastSeenAt: "2026-05-08T00:00:00Z",
          lastScore: 80,
          futureCandidateField: "kept",
        },
      ],
    });
    expect((parsed.preferences as Record<string, unknown>).futurePref).toBe(
      true,
    );
    expect(
      (parsed.savedResults[0] as Record<string, unknown>).futureCandidateField,
    ).toBe("kept");
  });

  it("still rejects an unknown version", () => {
    expect(() => parseScoutState({ version: 2 })).toThrow();
  });
});

// ── searchRotation (#249 follow-up) ──────────────────────────────────

describe("searchRotation", () => {
  it("defaults on legacy state with no searchRotation key", () => {
    const state = parseScoutState({ version: 1 });
    expect(state.searchRotation).toEqual({ languageOffset: 0 });
  });

  it("defaults languageOffset when searchRotation is present but empty", () => {
    const state = parseScoutState({ version: 1, searchRotation: {} });
    expect(state.searchRotation.languageOffset).toBe(0);
    expect(state.searchRotation.lastRotatedAt).toBeUndefined();
  });

  it("round-trips a persisted offset and timestamp", () => {
    const state = parseScoutState({
      version: 1,
      searchRotation: {
        languageOffset: 3,
        lastRotatedAt: "2026-07-01T00:00:00Z",
      },
    });
    expect(state.searchRotation).toEqual({
      languageOffset: 3,
      lastRotatedAt: "2026-07-01T00:00:00Z",
    });
  });

  it("round-trips unknown keys on searchRotation (loose object)", () => {
    const parsed = parseScoutState({
      version: 1,
      searchRotation: { languageOffset: 1, futureField: "kept" },
    });
    expect(
      (parsed.searchRotation as Record<string, unknown>).futureField,
    ).toBe("kept");
  });
});
