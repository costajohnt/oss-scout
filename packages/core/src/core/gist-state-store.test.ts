import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ScoutStateSchema } from "./schemas.js";
import type { ScoutState } from "./schemas.js";

let tempDir: string;

vi.mock("./utils.js", () => ({
  getDataDir: () => tempDir,
}));

vi.mock("./logger.js", () => ({
  debug: () => {},
  warn: () => {},
}));

const { GistStateStore, mergeStates } = await import("./gist-state-store.js");

function makeState(overrides: Partial<ScoutState> = {}): ScoutState {
  return ScoutStateSchema.parse({ version: 1, ...overrides });
}

function makeOctokit(overrides: Record<string, unknown> = {}) {
  return {
    gists: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      list: vi.fn(),
      ...overrides,
    },
  };
}

function gistResponse(state: ScoutState, id = "gist-123") {
  return {
    data: {
      id,
      files: {
        "state.json": { content: JSON.stringify(state) },
      },
    },
  };
}

describe("GistStateStore", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-gist-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("bootstrap", () => {
    it("creates a new gist when none exists", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "new-gist-id" } }),
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.created).toBe(true);
      expect(result.gistId).toBe("new-gist-id");
      expect(result.state.version).toBe(1);
      expect(result.degraded).toBeUndefined();
      expect(octokit.gists.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "oss-scout-state",
          public: false,
        }),
      );
    });

    it("finds existing gist via search", async () => {
      const state = makeState({ preferences: { githubUsername: "testuser" } });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({
          data: [
            { id: "other-gist", description: "something-else" },
            { id: "found-gist", description: "oss-scout-state" },
          ],
        }),
        get: vi.fn().mockResolvedValue(gistResponse(state, "found-gist")),
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.created).toBe(false);
      expect(result.gistId).toBe("found-gist");
      expect(result.state.preferences.githubUsername).toBe("testuser");
    });

    it("uses cached gist ID from local file", async () => {
      fs.writeFileSync(path.join(tempDir, "gist-id"), "cached-id\n");
      const state = makeState();
      const octokit = makeOctokit({
        get: vi.fn().mockResolvedValue(gistResponse(state, "cached-id")),
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.created).toBe(false);
      expect(result.gistId).toBe("cached-id");
      expect(octokit.gists.list).not.toHaveBeenCalled();
    });

    it("falls back to search when cached gist ID is invalid", async () => {
      fs.writeFileSync(path.join(tempDir, "gist-id"), "stale-id\n");
      const state = makeState();
      const notFound = Object.assign(new Error("Not Found"), { status: 404 });
      const octokit = makeOctokit({
        get: vi
          .fn()
          .mockRejectedValueOnce(notFound)
          .mockResolvedValueOnce(gistResponse(state, "found-gist")),
        list: vi.fn().mockResolvedValue({
          data: [{ id: "found-gist", description: "oss-scout-state" }],
        }),
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(result.gistId).toBe("found-gist");
      expect(octokit.gists.list).toHaveBeenCalled();
    });

    it("paginates gist search up to 5 pages", async () => {
      const octokit = makeOctokit({
        list: vi
          .fn()
          .mockResolvedValueOnce({
            data: [{ id: "g1", description: "other1" }],
          })
          .mockResolvedValueOnce({
            data: [{ id: "g2", description: "other2" }],
          })
          .mockResolvedValueOnce({
            data: [{ id: "g3", description: "other3" }],
          })
          .mockResolvedValueOnce({
            data: [{ id: "g4", description: "other4" }],
          })
          .mockResolvedValueOnce({
            data: [{ id: "g5", description: "other5" }],
          }),
        create: vi.fn().mockResolvedValue({ data: { id: "new-id" } }),
      });

      const store = new GistStateStore(octokit);
      const result = await store.bootstrap();

      expect(octokit.gists.list).toHaveBeenCalledTimes(5);
      expect(result.created).toBe(true);
    });

    it("writes gist ID to local cache on bootstrap", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "new-gist-id" } }),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const cached = fs
        .readFileSync(path.join(tempDir, "gist-id"), "utf-8")
        .trim();
      expect(cached).toBe("new-gist-id");
    });

    it("writes state cache on bootstrap", async () => {
      const state = makeState({
        preferences: { githubUsername: "cached-user" },
      });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({
          data: [{ id: "gist-1", description: "oss-scout-state" }],
        }),
        get: vi.fn().mockResolvedValue(gistResponse(state, "gist-1")),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const cachePath = path.join(tempDir, "state-cache.json");
      expect(fs.existsSync(cachePath)).toBe(true);
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      expect(cached.preferences.githubUsername).toBe("cached-user");
    });

    describe("degraded mode", () => {
      it("falls back to local cache on API failure", async () => {
        const cachedState = makeState({
          preferences: { githubUsername: "cached" },
        });
        fs.writeFileSync(
          path.join(tempDir, "state-cache.json"),
          JSON.stringify(cachedState),
        );
        fs.writeFileSync(path.join(tempDir, "gist-id"), "old-id\n");

        const octokit = makeOctokit({
          get: vi.fn().mockRejectedValue(new Error("Network error")),
        });

        const store = new GistStateStore(octokit);
        const result = await store.bootstrap();

        expect(result.degraded).toBe(true);
        expect(result.state.preferences.githubUsername).toBe("cached");
        expect(result.gistId).toBe("old-id");
      });

      it("returns fresh state when no cache and API fails", async () => {
        const octokit = makeOctokit({
          get: vi.fn().mockRejectedValue(new Error("Network error")),
          list: vi.fn().mockRejectedValue(new Error("Network error")),
        });

        const store = new GistStateStore(octokit);
        const result = await store.bootstrap();

        expect(result.degraded).toBe(true);
        expect(result.gistId).toBe("");
        expect(result.state.version).toBe(1);
      });

      it("propagates 401 (does NOT fall back to cache silently)", async () => {
        // Pre-seed a cache so we can verify it's NOT used as the fallback.
        const sentinelCache = makeState({
          preferences: { githubUsername: "should-not-be-used" },
        });
        fs.writeFileSync(
          path.join(tempDir, "state-cache.json"),
          JSON.stringify(sentinelCache),
        );
        const authErr = Object.assign(new Error("Bad credentials"), {
          status: 401,
        });
        const octokit = makeOctokit({
          list: vi.fn().mockRejectedValue(authErr),
        });

        const store = new GistStateStore(octokit);
        await expect(store.bootstrap()).rejects.toThrow("Bad credentials");
        // Verify cache was not consumed as a side-effect-of-throwing.
        expect(store.getGistId()).toBeNull();
      });

      it("propagates 401 from cached-gist-ID fetch (not just the search path)", async () => {
        // Steady-state regression: any user past their first run has a cached
        // gist-id. A 401 on get-by-id must propagate, not silently fall through
        // to search-and-create-a-new-empty-gist.
        fs.writeFileSync(path.join(tempDir, "gist-id"), "stale-id\n");
        const authErr = Object.assign(new Error("Bad credentials"), {
          status: 401,
        });
        const create = vi.fn();
        const octokit = makeOctokit({
          get: vi.fn().mockRejectedValue(authErr),
          list: vi.fn().mockResolvedValue({ data: [] }),
          create,
        });

        const store = new GistStateStore(octokit);
        await expect(store.bootstrap()).rejects.toThrow("Bad credentials");
        // Critical: must NOT have created a new gist as a side effect of swallowing.
        expect(create).not.toHaveBeenCalled();
      });

      it("falls back to cache on rate-limit (offline mode is desirable)", async () => {
        // Rate-limit recovery deliberately stays as cache fallback so the
        // user can keep working until the limit resets.
        const cachedState = makeState({
          preferences: { githubUsername: "cached-during-ratelimit" },
        });
        fs.writeFileSync(
          path.join(tempDir, "state-cache.json"),
          JSON.stringify(cachedState),
        );
        const rateErr = Object.assign(new Error("API rate limit exceeded"), {
          status: 429,
        });
        const octokit = makeOctokit({
          list: vi.fn().mockRejectedValue(rateErr),
        });

        const store = new GistStateStore(octokit);
        const result = await store.bootstrap();

        expect(result.degraded).toBe(true);
        expect(result.state.preferences.githubUsername).toBe(
          "cached-during-ratelimit",
        );
      });
    });
  });

  describe("push", () => {
    it("updates gist and writes local cache", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        update: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const newState = makeState({ preferences: { githubUsername: "pushed" } });
      const ok = await store.push(newState);

      expect(ok).toBe(true);
      expect(octokit.gists.update).toHaveBeenCalledWith(
        expect.objectContaining({ gist_id: "gist-1" }),
      );
      const cached = JSON.parse(
        fs.readFileSync(path.join(tempDir, "state-cache.json"), "utf-8"),
      );
      expect(cached.preferences.githubUsername).toBe("pushed");
    });

    it("returns false when no gist ID", async () => {
      const octokit = makeOctokit();
      const store = new GistStateStore(octokit);

      const ok = await store.push(makeState());

      expect(ok).toBe(false);
    });

    it("returns false on API error but still writes cache", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        update: vi.fn().mockRejectedValue(new Error("API down")),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const ok = await store.push(makeState());

      expect(ok).toBe(false);
      expect(fs.existsSync(path.join(tempDir, "state-cache.json"))).toBe(true);
    });

    it("propagates 401 instead of returning false", async () => {
      const authErr = Object.assign(new Error("Bad credentials"), {
        status: 401,
      });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        update: vi.fn().mockRejectedValue(authErr),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      await expect(store.push(makeState())).rejects.toThrow("Bad credentials");
    });

    it("propagates rate-limit instead of returning false", async () => {
      // Local cache is written before the API call, so the user's work is
      // preserved even when push throws — they just get clear feedback that
      // the gist sync failed (vs. a buried warn line).
      const rateErr = Object.assign(new Error("API rate limit exceeded"), {
        status: 429,
      });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        update: vi.fn().mockRejectedValue(rateErr),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      await expect(store.push(makeState())).rejects.toThrow("rate limit");
      // Verify local cache write still happened (push writes cache before API call).
      expect(fs.existsSync(path.join(tempDir, "state-cache.json"))).toBe(true);
    });
  });

  describe("pull", () => {
    it("fetches state from gist and updates cache", async () => {
      const state = makeState({ preferences: { githubUsername: "pulled" } });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        get: vi.fn().mockResolvedValue(gistResponse(state, "gist-1")),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const pulled = await store.pull();

      expect(pulled).not.toBeNull();
      expect(pulled!.preferences.githubUsername).toBe("pulled");
    });

    it("returns null when no gist ID", async () => {
      const octokit = makeOctokit();
      const store = new GistStateStore(octokit);

      const result = await store.pull();

      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        get: vi.fn().mockRejectedValue(new Error("API error")),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      const result = await store.pull();

      expect(result).toBeNull();
    });

    it("propagates 401 instead of returning null", async () => {
      const authErr = Object.assign(new Error("Bad credentials"), {
        status: 401,
      });
      // Bootstrap creates a new gist (no get call needed); pull() then calls
      // get which fails with 401.
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        get: vi.fn().mockRejectedValue(authErr),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      await expect(store.pull()).rejects.toThrow("Bad credentials");
    });

    it("propagates rate-limit instead of returning null", async () => {
      const rateErr = Object.assign(new Error("API rate limit exceeded"), {
        status: 429,
      });
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "gist-1" } }),
        get: vi.fn().mockRejectedValue(rateErr),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      await expect(store.pull()).rejects.toThrow("rate limit");
    });
  });

  describe("getGistId", () => {
    it("returns null before bootstrap", () => {
      const octokit = makeOctokit();
      const store = new GistStateStore(octokit);

      expect(store.getGistId()).toBeNull();
    });

    it("returns gist ID after bootstrap", async () => {
      const octokit = makeOctokit({
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: { id: "test-id" } }),
      });

      const store = new GistStateStore(octokit);
      await store.bootstrap();

      expect(store.getGistId()).toBe("test-id");
    });
  });
});

describe("mergeStates", () => {
  it("uses remote preferences", () => {
    const local = makeState({ preferences: { githubUsername: "local" } });
    const remote = makeState({ preferences: { githubUsername: "remote" } });

    const merged = mergeStates(local, remote);

    expect(merged.preferences.githubUsername).toBe("remote");
  });

  it("unions mergedPRs by URL", () => {
    const local = makeState({
      mergedPRs: [
        {
          url: "https://github.com/a/b/pull/1",
          title: "PR1",
          mergedAt: "2026-01-01T00:00:00Z",
        },
        {
          url: "https://github.com/a/b/pull/2",
          title: "PR2",
          mergedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const remote = makeState({
      mergedPRs: [
        {
          url: "https://github.com/a/b/pull/2",
          title: "PR2-updated",
          mergedAt: "2026-01-02T00:00:00Z",
        },
        {
          url: "https://github.com/a/b/pull/3",
          title: "PR3",
          mergedAt: "2026-01-03T00:00:00Z",
        },
      ],
    });

    const merged = mergeStates(local, remote);

    expect(merged.mergedPRs).toHaveLength(3);
    const urls = merged.mergedPRs.map((p) => p.url);
    expect(urls).toContain("https://github.com/a/b/pull/1");
    expect(urls).toContain("https://github.com/a/b/pull/2");
    expect(urls).toContain("https://github.com/a/b/pull/3");
  });

  it("unions closedPRs by URL", () => {
    const local = makeState({
      closedPRs: [
        {
          url: "https://github.com/a/b/pull/1",
          title: "PR1",
          closedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const remote = makeState({
      closedPRs: [
        {
          url: "https://github.com/a/b/pull/2",
          title: "PR2",
          closedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });

    const merged = mergeStates(local, remote);

    expect(merged.closedPRs).toHaveLength(2);
  });

  it("unions openPRs by URL", () => {
    const local = makeState({
      openPRs: [
        {
          url: "https://github.com/a/b/pull/1",
          title: "PR1",
          openedAt: "2026-01-01T00:00:00Z",
        },
        {
          url: "https://github.com/a/b/pull/2",
          title: "PR2",
          openedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
    const remote = makeState({
      openPRs: [
        {
          url: "https://github.com/a/b/pull/2",
          title: "PR2",
          openedAt: "2026-01-02T00:00:00Z",
        },
        {
          url: "https://github.com/a/b/pull/3",
          title: "PR3",
          openedAt: "2026-01-03T00:00:00Z",
        },
      ],
    });

    const merged = mergeStates(local, remote);

    expect(merged.openPRs).toHaveLength(3);
    const urls = merged.openPRs.map((p) => p.url);
    expect(urls).toContain("https://github.com/a/b/pull/1");
    expect(urls).toContain("https://github.com/a/b/pull/2");
    expect(urls).toContain("https://github.com/a/b/pull/3");
  });

  it("tolerates legacy state missing openPRs field", () => {
    // Simulate a pre-feature state by stripping openPRs after parse.
    const local = makeState({
      openPRs: [
        {
          url: "https://github.com/a/b/pull/1",
          title: "PR1",
          openedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const remote = makeState();
    // Cast because the current schema requires openPRs; we're simulating
    // legacy persisted state that predates the field.
    delete (remote as { openPRs?: unknown }).openPRs;

    const merged = mergeStates(local, remote);

    expect(merged.openPRs).toHaveLength(1);
    expect(merged.openPRs[0].url).toBe("https://github.com/a/b/pull/1");
  });

  it("keeps repo score with higher activity", () => {
    const local = makeState({
      repoScores: {
        "org/repo": {
          repo: "org/repo",
          score: 7,
          mergedPRCount: 3,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-01-01T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });
    const remote = makeState({
      repoScores: {
        "org/repo": {
          repo: "org/repo",
          score: 5,
          mergedPRCount: 1,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-01-02T00:00:00Z",
          signals: {
            hasActiveMaintainers: false,
            isResponsive: false,
            hasHostileComments: false,
          },
        },
      },
    });

    const merged = mergeStates(local, remote);

    expect(merged.repoScores["org/repo"].mergedPRCount).toBe(3);
    expect(merged.repoScores["org/repo"].score).toBe(7);
  });

  it("keeps remote repo score when activity is equal", () => {
    const local = makeState({
      repoScores: {
        "org/repo": {
          repo: "org/repo",
          score: 6,
          mergedPRCount: 2,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-01-01T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });
    const remote = makeState({
      repoScores: {
        "org/repo": {
          repo: "org/repo",
          score: 5,
          mergedPRCount: 2,
          closedWithoutMergeCount: 0,
          avgResponseDays: 3,
          lastEvaluatedAt: "2026-01-02T00:00:00Z",
          signals: {
            hasActiveMaintainers: false,
            isResponsive: false,
            hasHostileComments: false,
          },
        },
      },
    });

    const merged = mergeStates(local, remote);

    expect(merged.repoScores["org/repo"].avgResponseDays).toBe(3);
  });

  it("merges repo scores from both sides", () => {
    const local = makeState({
      repoScores: {
        "org/local-only": {
          repo: "org/local-only",
          score: 5,
          mergedPRCount: 1,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-01-01T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });
    const remote = makeState({
      repoScores: {
        "org/remote-only": {
          repo: "org/remote-only",
          score: 6,
          mergedPRCount: 2,
          closedWithoutMergeCount: 0,
          avgResponseDays: null,
          lastEvaluatedAt: "2026-01-01T00:00:00Z",
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
    });

    const merged = mergeStates(local, remote);

    expect(merged.repoScores["org/local-only"]).toBeDefined();
    expect(merged.repoScores["org/remote-only"]).toBeDefined();
  });

  it("uses fresher starredRepos based on timestamp", () => {
    const local = makeState({
      starredRepos: ["org/old-star"],
      starredReposLastFetched: "2026-01-01T00:00:00Z",
    });
    const remote = makeState({
      starredRepos: ["org/new-star"],
      starredReposLastFetched: "2026-01-15T00:00:00Z",
    });

    const merged = mergeStates(local, remote);

    expect(merged.starredRepos).toEqual(["org/new-star"]);
  });

  it("uses local starredRepos when local timestamp is fresher", () => {
    const local = makeState({
      starredRepos: ["org/local-star"],
      starredReposLastFetched: "2026-01-20T00:00:00Z",
    });
    const remote = makeState({
      starredRepos: ["org/remote-star"],
      starredReposLastFetched: "2026-01-01T00:00:00Z",
    });

    const merged = mergeStates(local, remote);

    expect(merged.starredRepos).toEqual(["org/local-star"]);
  });

  it("merges savedResults by issueUrl, keeping newer lastSeenAt", () => {
    const local = makeState({
      savedResults: [
        {
          issueUrl: "https://github.com/a/b/issues/1",
          repo: "a/b",
          number: 1,
          title: "Old title",
          labels: ["bug"],
          recommendation: "approve" as const,
          viabilityScore: 70,
          searchPriority: "normal",
          firstSeenAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-10T00:00:00Z",
          lastScore: 70,
        },
      ],
    });
    const remote = makeState({
      savedResults: [
        {
          issueUrl: "https://github.com/a/b/issues/1",
          repo: "a/b",
          number: 1,
          title: "New title",
          labels: ["bug"],
          recommendation: "skip" as const,
          viabilityScore: 40,
          searchPriority: "normal",
          firstSeenAt: "2026-01-01T00:00:00Z",
          lastSeenAt: "2026-01-20T00:00:00Z",
          lastScore: 40,
        },
        {
          issueUrl: "https://github.com/c/d/issues/2",
          repo: "c/d",
          number: 2,
          title: "Remote only",
          labels: [],
          recommendation: "approve" as const,
          viabilityScore: 80,
          searchPriority: "normal",
          firstSeenAt: "2026-01-05T00:00:00Z",
          lastSeenAt: "2026-01-15T00:00:00Z",
          lastScore: 80,
        },
      ],
    });

    const merged = mergeStates(local, remote);

    expect(merged.savedResults).toHaveLength(2);
    const issue1 = merged.savedResults.find(
      (r) => r.issueUrl === "https://github.com/a/b/issues/1",
    );
    expect(issue1!.title).toBe("New title");
    expect(issue1!.recommendation).toBe("skip");
  });

  it("picks fresher timestamp for lastSearchAt", () => {
    const local = makeState({ lastSearchAt: "2026-01-15T00:00:00Z" });
    const remote = makeState({ lastSearchAt: "2026-01-01T00:00:00Z" });

    const merged = mergeStates(local, remote);

    expect(merged.lastSearchAt).toBe("2026-01-15T00:00:00Z");
  });

  it("uses remote gistId", () => {
    const local = makeState({ gistId: "local-gist" });
    const remote = makeState({ gistId: "remote-gist" });

    const merged = mergeStates(local, remote);

    expect(merged.gistId).toBe("remote-gist");
  });
});
