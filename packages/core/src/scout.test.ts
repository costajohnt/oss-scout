import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScout, OssScout, toGistOctokit } from "./scout.js";
import { GistStateStore } from "./core/gist-state-store.js";
import type { BootstrapResult } from "./core/gist-state-store.js";
import { ScoutStateSchema } from "./core/schemas.js";
import type { ScoutState } from "./core/schemas.js";
import type { IssueCandidate } from "./core/types.js";
import type { Octokit } from "@octokit/rest";

vi.mock("./core/feature-discovery.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./core/feature-discovery.js")>();
  return {
    ...actual,
    discoverFeatures: vi.fn(),
  };
});

import { discoverFeatures } from "./core/feature-discovery.js";

// In-memory local-state stub so the default ("local") createScout path is
// hermetic and never touches the developer's real ~/.oss-scout/state.json.
// Tests seed `localStateStore.current` (see beforeEach) with a parsed state.
const localStateStore = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./core/local-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/local-state.js")>();
  return {
    ...actual,
    loadLocalState: vi.fn(() => localStateStore.current),
    saveLocalState: vi.fn((s: unknown) => {
      localStateStore.current = s;
    }),
  };
});

// Stub the shared cache singleton so cache-burning entry points
// (search/features/vetList) never touch the real ~/.oss-scout/cache in tests.
vi.mock("./core/http-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./core/http-cache.js")>();
  return {
    ...actual,
    getHttpCache: () =>
      ({ evictStale: () => 0 }) as unknown as ReturnType<
        typeof actual.getHttpCache
      >,
  };
});

// Replace only the GistStateStore class so createScout's gist path is testable
// (#162); mergeStates and the rest of the module stay real.
vi.mock("./core/gist-state-store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./core/gist-state-store.js")>();
  return { ...actual, GistStateStore: vi.fn() };
});

function makeState(overrides: Partial<ScoutState> = {}): ScoutState {
  return ScoutStateSchema.parse({ version: 1, ...overrides });
}

describe("createScout", () => {
  beforeEach(() => {
    localStateStore.current = ScoutStateSchema.parse({ version: 1 });
  });

  it("default (local) mode loads local state, not throwaway in-memory (#116)", async () => {
    // The stored local state carries a real preference; the default scout
    // must surface it rather than silently starting from blank defaults
    localStateStore.current = ScoutStateSchema.parse({
      version: 1,
      preferences: { githubUsername: "stored-user" },
    });
    const scout = await createScout({ githubToken: "test-token" });
    expect(scout).toBeInstanceOf(OssScout);
    expect(scout.getPreferences().githubUsername).toBe("stored-user");
  });

  it("default (local) mode persists on checkpoint (#116)", async () => {
    const { saveLocalState } = await import("./core/local-state.js");
    const scout = await createScout({ githubToken: "test-token" });
    scout.recordMergedPR({
      url: "https://github.com/o/r/pull/1",
      title: "t",
      mergedAt: "2026-01-01T00:00:00Z",
      repo: "o/r",
    });
    const ok = await scout.checkpoint();
    expect(ok).toBe(true);
    expect(saveLocalState).toHaveBeenCalled();
    // The saved state actually contains the recorded PR (not a no-op success)
    const saved = localStateStore.current as ScoutState;
    expect(saved.mergedPRs).toHaveLength(1);
  });

  it("creates instance with provided state", async () => {
    const state = makeState({
      preferences: {
        githubUsername: "testuser",
        languages: ["python"],
        labels: ["help wanted"],
        excludeRepos: [],
        aiPolicyBlocklist: [],
        projectCategories: [],
        minStars: 100,
        maxIssueAgeDays: 60,
        includeDocIssues: false,
        minRepoScoreThreshold: 5,
      },
    });
    const scout = await createScout({
      githubToken: "test-token",
      persistence: "provided",
      initialState: state,
    });
    expect(scout.getPreferences().githubUsername).toBe("testuser");
    expect(scout.getPreferences().languages).toEqual(["python"]);
  });
});

describe("OssScout", () => {
  function makeScout(stateOverrides: Partial<ScoutState> = {}): OssScout {
    return new OssScout("test-token", makeState(stateOverrides));
  }

  describe("state reads", () => {
    it("returns empty arrays for fresh state", () => {
      const scout = makeScout();
      expect(scout.getReposWithMergedPRs()).toEqual([]);
      expect(scout.getStarredRepos()).toEqual([]);
    });

    it("returns preferences", () => {
      const scout = makeScout();
      const prefs = scout.getPreferences();
      expect(prefs.languages).toEqual(["any"]);
    });

    it("returns null for unknown repo score", () => {
      const scout = makeScout();
      expect(scout.getRepoScore("unknown/repo")).toBeNull();
    });

    it("returns score for known repo", () => {
      const scout = makeScout({
        repoScores: {
          "owner/repo": {
            repo: "owner/repo",
            score: 8,
            mergedPRCount: 3,
            closedWithoutMergeCount: 0,
            avgResponseDays: null,
            lastEvaluatedAt: "2025-01-01T00:00:00Z",
            signals: {
              hasActiveMaintainers: true,
              isResponsive: true,
              hasHostileComments: false,
            },
          },
        },
      });
      expect(scout.getRepoScore("owner/repo")).toBe(8);
    });
  });

  describe("recordMergedPR", () => {
    it("adds PR to state", () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Fix bug",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      expect(scout.getState().mergedPRs).toHaveLength(1);
      expect(scout.getReposWithMergedPRs()).toEqual(["owner/repo"]);
      expect(scout.isDirty()).toBe(true);
    });

    it("deduplicates by URL", () => {
      const scout = makeScout();
      const pr = {
        url: "https://github.com/owner/repo/pull/1",
        title: "Fix bug",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      };
      scout.recordMergedPR(pr);
      scout.recordMergedPR(pr);
      expect(scout.getState().mergedPRs).toHaveLength(1);
    });

    it("updates repo score", () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Fix bug",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      const score = scout.getRepoScoreRecord("owner/repo");
      expect(score).toBeDefined();
      expect(score!.mergedPRCount).toBe(1);
      expect(score!.score).toBeGreaterThanOrEqual(1);
      expect(score!.score).toBeLessThanOrEqual(10);
    });
  });

  describe("recordOpenPR", () => {
    it("adds PR to state and surfaces repo via getReposWithOpenPRs", () => {
      const scout = makeScout();
      scout.recordOpenPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Draft PR",
        openedAt: "2026-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      expect(scout.getState().openPRs).toHaveLength(1);
      expect(scout.getReposWithOpenPRs()).toEqual(["owner/repo"]);
      expect(scout.isDirty()).toBe(true);
    });

    it("deduplicates by URL", () => {
      const scout = makeScout();
      const pr = {
        url: "https://github.com/owner/repo/pull/1",
        title: "Draft",
        openedAt: "2026-01-01T00:00:00Z",
        repo: "owner/repo",
      };
      scout.recordOpenPR(pr);
      scout.recordOpenPR(pr);
      expect(scout.getState().openPRs).toHaveLength(1);
    });

    it("does not update repo score (open PRs are not a merge signal)", () => {
      const scout = makeScout();
      scout.recordOpenPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Draft",
        openedAt: "2026-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      expect(scout.getRepoScoreRecord("owner/repo")).toBeUndefined();
    });
  });

  describe("recordClosedPR", () => {
    it("adds PR to state and updates score", () => {
      const scout = makeScout();
      scout.recordClosedPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Rejected PR",
        closedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      expect(scout.getState().closedPRs).toHaveLength(1);
      const score = scout.getRepoScoreRecord("owner/repo");
      expect(score!.closedWithoutMergeCount).toBe(1);
    });

    it("deduplicates by URL", () => {
      const scout = makeScout();
      const pr = {
        url: "https://github.com/owner/repo/pull/1",
        title: "Rejected",
        closedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      };
      scout.recordClosedPR(pr);
      scout.recordClosedPR(pr);
      expect(scout.getState().closedPRs).toHaveLength(1);
    });
  });

  describe("getClosedWithoutMergeCount", () => {
    it("returns the tracked repo-score count when a score record exists", () => {
      const scout = makeScout();
      scout.recordClosedPR({
        url: "https://github.com/owner/repo/pull/1",
        title: "Rejected PR",
        closedAt: "2025-01-01T00:00:00Z",
        repo: "owner/repo",
      });
      scout.recordClosedPR({
        url: "https://github.com/owner/repo/pull/2",
        title: "Also rejected",
        closedAt: "2025-02-01T00:00:00Z",
        repo: "owner/repo",
      });
      expect(scout.getClosedWithoutMergeCount("owner/repo")).toBe(2);
    });

    it("falls back to counting closedPRs when no score record exists", () => {
      const state = makeState({
        closedPRs: [
          {
            url: "https://github.com/owner/repo/pull/9",
            title: "Old rejection",
            closedAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
      const scout = new OssScout("fake-token", state);
      expect(scout.getClosedWithoutMergeCount("owner/repo")).toBe(1);
      expect(scout.getClosedWithoutMergeCount("other/repo")).toBe(0);
    });
  });

  describe("updatePreferences", () => {
    it("updates specific preferences", () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ["rust"], minStars: 200 });
      expect(scout.getPreferences().languages).toEqual(["rust"]);
      expect(scout.getPreferences().minStars).toBe(200);
      expect(scout.isDirty()).toBe(true);
    });

    it("preserves other preferences", () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ["rust"] });
      expect(scout.getPreferences().labels).toEqual([
        "good first issue",
        "help wanted",
      ]);
    });
  });

  describe("deletion tombstones (#117)", () => {
    it("records a tombstone when an issue is unskipped", () => {
      const scout = makeScout();
      scout.skipIssue("https://github.com/a/b/issues/1");
      scout.unskipIssue("https://github.com/a/b/issues/1");
      const tombstones = scout.getState().tombstones ?? [];
      expect(tombstones.map((t) => t.url)).toContain(
        "https://github.com/a/b/issues/1",
      );
    });

    it("records tombstones when the skip list is cleared", () => {
      const scout = makeScout();
      scout.skipIssue("https://github.com/a/b/issues/1");
      scout.skipIssue("https://github.com/a/b/issues/2");
      scout.clearSkippedIssues();
      const urls = (scout.getState().tombstones ?? []).map((t) => t.url);
      expect(urls).toContain("https://github.com/a/b/issues/1");
      expect(urls).toContain("https://github.com/a/b/issues/2");
    });

    it("records tombstones when results are cleared", () => {
      const scout = makeScout({
        savedResults: [
          {
            issueUrl: "https://github.com/a/b/issues/3",
            repo: "a/b",
            number: 3,
            title: "t",
            labels: [],
            recommendation: "approve",
            viabilityScore: 80,
            searchPriority: "normal",
            firstSeenAt: "2026-06-01T00:00:00Z",
            lastSeenAt: "2026-06-01T00:00:00Z",
            lastScore: 80,
          },
        ],
      });
      scout.clearResults();
      expect((scout.getState().tombstones ?? []).map((t) => t.url)).toContain(
        "https://github.com/a/b/issues/3",
      );
    });

    it("does not record a tombstone when unskip removes nothing", () => {
      const scout = makeScout();
      scout.unskipIssue("https://github.com/a/b/issues/nope");
      expect(scout.getState().tombstones ?? []).toHaveLength(0);
    });
  });

  describe("setStarredRepos", () => {
    it("updates starred repos with timestamp", () => {
      const scout = makeScout();
      scout.setStarredRepos(["owner/repo1", "owner/repo2"]);
      expect(scout.getStarredRepos()).toEqual(["owner/repo1", "owner/repo2"]);
      expect(scout.getState().starredReposLastFetched).toBeDefined();
    });
  });

  describe("checkpoint", () => {
    it("resets dirty flag", async () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ["go"] });
      expect(scout.isDirty()).toBe(true);
      await scout.checkpoint();
      expect(scout.isDirty()).toBe(false);
    });

    it("returns true when not dirty", async () => {
      const scout = makeScout();
      const result = await scout.checkpoint();
      expect(result).toBe(true);
    });
  });

  describe("getReposWithMergedPRs", () => {
    it("sorts by merge count descending", () => {
      const scout = makeScout();
      // Add 1 PR to repo-a
      scout.recordMergedPR({
        url: "https://github.com/a/repo/pull/1",
        title: "PR 1",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "a/repo",
      });
      // Add 2 PRs to repo-b
      scout.recordMergedPR({
        url: "https://github.com/b/repo/pull/1",
        title: "PR 1",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "b/repo",
      });
      scout.recordMergedPR({
        url: "https://github.com/b/repo/pull/2",
        title: "PR 2",
        mergedAt: "2025-01-02T00:00:00Z",
        repo: "b/repo",
      });
      expect(scout.getReposWithMergedPRs()).toEqual(["b/repo", "a/repo"]);
    });
  });

  describe("score calculation", () => {
    it("clamps score to 1-10 range", () => {
      const scout = makeScout();
      // Record many closed PRs to drive score down
      for (let i = 1; i <= 5; i++) {
        scout.recordClosedPR({
          url: `https://github.com/bad/repo/pull/${i}`,
          title: `Rejected ${i}`,
          closedAt: "2025-01-01T00:00:00Z",
          repo: "bad/repo",
        });
      }
      const score = scout.getRepoScoreRecord("bad/repo");
      expect(score!.score).toBeGreaterThanOrEqual(1);
    });

    it("increases score for merged PRs", () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: "https://github.com/good/repo/pull/1",
        title: "PR",
        mergedAt: "2025-01-01T00:00:00Z",
        repo: "good/repo",
      });
      const score = scout.getRepoScoreRecord("good/repo");
      expect(score!.score).toBeGreaterThan(5); // base is 5, merged adds
    });
  });
});

describe("OssScout.features", () => {
  it("delegates to discoverFeatures and persists results with horizon stamped", async () => {
    const fakeQuick = {
      issue: {
        url: "https://github.com/foo/bar/issues/1",
        repo: "foo/bar",
        number: 1,
        title: "qw",
        labels: ["enhancement"],
        updatedAt: "2026-05-08",
      },
      vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
      projectHealth: {},
      antiLLMPolicy: { matched: false, matchedKeywords: [], sourceFile: null },
      slmTriage: null,
      recommendation: "approve",
      reasonsToApprove: [],
      reasonsToSkip: [],
      viabilityScore: 80,
      searchPriority: "merged_pr",
      horizon: "quick-win" as const,
    };
    const fakeBigger = {
      ...fakeQuick,
      issue: {
        ...fakeQuick.issue,
        url: "https://github.com/foo/bar/issues/2",
        number: 2,
      },
      horizon: "bigger-bet" as const,
    };
    vi.mocked(discoverFeatures).mockResolvedValue({
      quickWins: [fakeQuick],
      biggerBets: [fakeBigger],
      anchorRepos: ["foo/bar"],
      message: null,
    } as never);

    const state = ScoutStateSchema.parse({
      version: 1,
      repoScores: {
        "foo/bar": {
          repo: "foo/bar",
          score: 5,
          mergedPRCount: 4,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-05-08T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });
    const scout = new OssScout("test-token", state);
    const result = await scout.features({ count: 10 });
    expect(result.quickWins).toHaveLength(1);
    expect(result.biggerBets).toHaveLength(1);
    expect(scout.getSavedResults().find((r) => r.number === 1)?.horizon).toBe(
      "quick-win",
    );
    expect(scout.getSavedResults().find((r) => r.number === 2)?.horizon).toBe(
      "bigger-bet",
    );
  });

  it("forwards featuresAnchorThreshold + featuresSplitRatio prefs to discoverFeatures", async () => {
    vi.mocked(discoverFeatures).mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: null,
    } as never);
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: {
        featuresAnchorThreshold: 5,
        featuresSplitRatio: 0.4,
      },
    });
    const scout = new OssScout("test-token", state);
    await scout.features();
    expect(discoverFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorThreshold: 5,
        splitRatio: 0.4,
        count: 10,
      }),
    );
  });

  it("per-call overrides take precedence over preferences", async () => {
    vi.mocked(discoverFeatures).mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: null,
    } as never);
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: {
        featuresAnchorThreshold: 5,
        featuresSplitRatio: 0.4,
      },
    });
    const scout = new OssScout("test-token", state);
    await scout.features({ count: 4, anchorThreshold: 2, splitRatio: 0.75 });
    expect(discoverFeatures).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorThreshold: 2,
        splitRatio: 0.75,
        count: 4,
      }),
    );
  });
});

describe("OssScout checkpoint + scoring branches (#162)", () => {
  type GistStoreArg = ConstructorParameters<typeof OssScout>[2];

  it("returns false and keeps the dirty flag when the gist push fails", async () => {
    const push = vi.fn().mockResolvedValue(false);
    const gistStore = { push } as unknown as GistStoreArg;
    const scout = new OssScout(
      "test-token",
      ScoutStateSchema.parse({ version: 1 }),
      gistStore,
    );

    // Dirty the scout so checkpoint actually attempts a push.
    scout.updatePreferences({ minStars: 123 });

    expect(await scout.checkpoint()).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);

    // Still dirty: the next checkpoint must retry the push, not no-op.
    expect(await scout.checkpoint()).toBe(false);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("returns true without pushing when nothing is dirty", async () => {
    const push = vi.fn().mockResolvedValue(true);
    const gistStore = { push } as unknown as GistStoreArg;
    const scout = new OssScout(
      "test-token",
      ScoutStateSchema.parse({ version: 1 }),
      gistStore,
    );

    expect(await scout.checkpoint()).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  describe("updateRepoScore signal branches", () => {
    function scoreAfter(update: Parameters<OssScout["updateRepoScore"]>[1]) {
      const scout = new OssScout(
        "test-token",
        ScoutStateSchema.parse({ version: 1 }),
      );
      scout.updateRepoScore("owner/repo", update);
      return scout.getRepoScore("owner/repo");
    }

    it("subtracts 2 for hostile comments", () => {
      expect(scoreAfter({ signals: { hasHostileComments: true } })).toBe(3);
    });

    it("adds 1 each for responsive and active maintainers", () => {
      expect(
        scoreAfter({
          signals: { isResponsive: true, hasActiveMaintainers: true },
        }),
      ).toBe(7);
    });

    it("clamps the upper bound at 10", () => {
      expect(
        scoreAfter({
          mergedPRCount: 3,
          signals: { isResponsive: true, hasActiveMaintainers: true },
        }),
      ).toBe(10);
    });

    it("clamps the lower bound at 1", () => {
      expect(
        scoreAfter({
          closedWithoutMergeCount: 3,
          signals: { hasHostileComments: true },
        }),
      ).toBe(1);
    });
  });
});

describe("createScout gist mode (#162)", () => {
  function stubBootstrap(result: BootstrapResult): void {
    // Must be a real function (not an arrow) so `new GistStateStore()` works.
    vi.mocked(GistStateStore).mockImplementation(function () {
      return {
        bootstrap: vi.fn().mockResolvedValue(result),
      } as unknown as GistStateStore;
    });
  }

  beforeEach(() => {
    localStateStore.current = ScoutStateSchema.parse({ version: 1 });
    vi.mocked(GistStateStore).mockReset();
  });

  it("adopts the bootstrapped gistId when no override is supplied", async () => {
    stubBootstrap({
      gistId: "boot-gist",
      state: ScoutStateSchema.parse({ version: 1 }),
      created: false,
    });
    const scout = await createScout({
      githubToken: "test-token",
      persistence: "gist",
    });
    expect(scout.getState().gistId).toBe("boot-gist");
  });

  it("config.gistId overrides the bootstrapped gistId", async () => {
    stubBootstrap({
      gistId: "boot-gist",
      state: ScoutStateSchema.parse({ version: 1 }),
      created: false,
    });
    const scout = await createScout({
      githubToken: "test-token",
      persistence: "gist",
      gistId: "explicit-gist",
    });
    expect(scout.getState().gistId).toBe("explicit-gist");
  });

  it("merges the bootstrapped gist state with local state (array union)", async () => {
    const skip = (n: number) => ({
      url: `https://github.com/o/r/issues/${n}`,
      repo: "o/r",
      number: n,
      title: `skip ${n}`,
      skippedAt: "2026-06-01T00:00:00Z",
    });
    // A local-only skip and a gist-only skip must both survive the merge —
    // proving mergeStates(local, gist) actually ran rather than the gist
    // state being adopted wholesale.
    localStateStore.current = ScoutStateSchema.parse({
      version: 1,
      skippedIssues: [skip(1)],
    });
    stubBootstrap({
      gistId: "g",
      state: ScoutStateSchema.parse({ version: 1, skippedIssues: [skip(2)] }),
      created: false,
    });
    const scout = await createScout({
      githubToken: "test-token",
      persistence: "gist",
    });
    const urls = scout.getSkippedIssues().map((s) => s.url);
    expect(urls).toContain("https://github.com/o/r/issues/1");
    expect(urls).toContain("https://github.com/o/r/issues/2");
  });

  it("still builds a scout when bootstrap reports a degraded (offline) result", async () => {
    stubBootstrap({
      gistId: "g",
      state: ScoutStateSchema.parse({ version: 1 }),
      created: false,
      degraded: true,
      degradedReason: "rate_limit",
    });
    const scout = await createScout({
      githubToken: "test-token",
      persistence: "gist",
    });
    expect(scout).toBeInstanceOf(OssScout);
  });
});

describe("toGistOctokit adapter (#162)", () => {
  function fakeOctokit(gists: Record<string, unknown>): Octokit {
    return { gists } as unknown as Octokit;
  }

  it("get maps files and drops undefined file entries", async () => {
    const adapter = toGistOctokit(
      fakeOctokit({
        get: async () => ({
          data: {
            id: "g1",
            files: { "state.json": { content: "{}" }, dropme: null },
          },
        }),
      }),
    );
    const { data } = await adapter.gists.get({ gist_id: "g1" });
    expect(data.id).toBe("g1");
    expect(data.files).toEqual({
      "state.json": { content: "{}" },
      dropme: undefined,
    });
  });

  it("get passes through null files", async () => {
    const adapter = toGistOctokit(
      fakeOctokit({ get: async () => ({ data: { id: "g1", files: null } }) }),
    );
    const { data } = await adapter.gists.get({ gist_id: "g1" });
    expect(data.files).toBeNull();
  });

  it("get throws when the response has no id", async () => {
    const adapter = toGistOctokit(
      fakeOctokit({
        get: async () => ({ data: { id: undefined, files: null } }),
      }),
    );
    await expect(adapter.gists.get({ gist_id: "g1" })).rejects.toThrow(/no id/);
  });

  it("create returns the id and throws without one", async () => {
    const ok = toGistOctokit(
      fakeOctokit({ create: async () => ({ data: { id: "new" } }) }),
    );
    expect((await ok.gists.create({ files: {} })).data.id).toBe("new");

    const bad = toGistOctokit(
      fakeOctokit({ create: async () => ({ data: { id: undefined } }) }),
    );
    await expect(bad.gists.create({ files: {} })).rejects.toThrow(/no id/);
  });

  it("update returns the id and throws without one", async () => {
    const ok = toGistOctokit(
      fakeOctokit({ update: async () => ({ data: { id: "g1" } }) }),
    );
    expect((await ok.gists.update({ gist_id: "g1", files: {} })).data.id).toBe(
      "g1",
    );

    const bad = toGistOctokit(
      fakeOctokit({ update: async () => ({ data: { id: undefined } }) }),
    );
    await expect(
      bad.gists.update({ gist_id: "g1", files: {} }),
    ).rejects.toThrow(/no id/);
  });

  it("list filters out id-less gists and defaults description to null", async () => {
    const adapter = toGistOctokit(
      fakeOctokit({
        list: async () => ({
          data: [
            { id: "g1", description: "mine" },
            { id: undefined, description: "skip" },
            { id: "g2" },
          ],
        }),
      }),
    );
    const { data } = await adapter.gists.list({});
    expect(data).toEqual([
      { id: "g1", description: "mine" },
      { id: "g2", description: null },
    ]);
  });
});

describe("OssScout.vetList partial-results discard (#162)", () => {
  function savedCandidate(n: number) {
    return {
      issueUrl: `https://github.com/o/r/issues/${n}`,
      repo: "o/r",
      number: n,
      title: `Issue ${n}`,
      labels: [],
      recommendation: "approve" as const,
      viabilityScore: 80,
      searchPriority: "normal" as const,
      firstSeenAt: "2026-06-01T00:00:00Z",
      lastSeenAt: "2026-06-01T00:00:00Z",
      lastScore: 80,
    };
  }

  it("discards a successful partial result and rethrows when a 401 lands mid-batch", async () => {
    const scout = new OssScout(
      "test-token",
      ScoutStateSchema.parse({
        version: 1,
        savedResults: [savedCandidate(1), savedCandidate(2)],
      }),
    );

    const okCandidate = {
      issueState: "open",
      vettingResult: { checks: { noExistingPR: true, notClaimed: true } },
      recommendation: "approve",
      viabilityScore: 80,
    } as unknown as IssueCandidate;
    const authErr = Object.assign(new Error("Bad credentials"), {
      status: 401,
    });

    // concurrency:1 forces the first issue to fully resolve (a real success
    // that gets discarded) before the second throws the fatal 401.
    vi.spyOn(scout, "vetIssue")
      .mockResolvedValueOnce(okCandidate)
      .mockRejectedValueOnce(authErr);

    await expect(scout.vetList({ concurrency: 1 })).rejects.toThrow(
      "Bad credentials",
    );
  });
});
