import { describe, it, expect } from "vitest";
import {
  ScoutStateSchema,
  ScoutPreferencesSchema,
  RepoScoreSchema,
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
