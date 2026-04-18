import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "./schemas.js";
import type { ScoutState } from "./schemas.js";
import { OssScout } from "../scout.js";

let mockOctokitInstance: any;

vi.mock("@octokit/rest", () => ({
  Octokit: {
    plugin: () =>
      class MockOctokit {
        constructor() {
          return mockOctokitInstance;
        }
      },
  },
}));

vi.mock("@octokit/plugin-throttling", () => ({
  throttling: {},
}));

vi.mock("./logger.js", () => ({
  debug: () => {},
  warn: () => {},
}));

const { bootstrapScout } = await import("./bootstrap.js");

let tokenCounter = 0;
function uniqueToken(): string {
  return `test-token-bootstrap-${++tokenCounter}`;
}

function makeState(overrides: Partial<ScoutState> = {}): ScoutState {
  return ScoutStateSchema.parse({
    version: 1,
    preferences: { githubUsername: "testuser" },
    ...overrides,
  });
}

function mockRateLimit(remaining: number) {
  mockOctokitInstance.rateLimit = {
    get: vi.fn().mockResolvedValue({
      data: {
        resources: {
          search: {
            remaining,
            limit: 30,
            reset: Math.floor(Date.now() / 1000) + 3600,
          },
        },
      },
    }),
  };
}

function makePRItem(n: number, repo: string) {
  return {
    html_url: `https://github.com/${repo}/pull/${n}`,
    title: `PR #${n}`,
    closed_at: "2026-01-15T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("bootstrapScout", () => {
  beforeEach(() => {
    mockOctokitInstance = {
      rateLimit: { get: vi.fn() },
      activity: { listReposStarredByAuthenticatedUser: vi.fn() },
      search: { issuesAndPullRequests: vi.fn() },
      paginate: { iterator: vi.fn() },
    };
  });

  it("skips when rate limit is too low", async () => {
    mockRateLimit(5);
    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);
    expect(result.skippedDueToRateLimit).toBe(true);
    expect(result.starredRepoCount).toBe(0);
    expect(result.mergedPRCount).toBe(0);
    expect(result.closedPRCount).toBe(0);
    expect(result.openPRCount).toBe(0);
  });

  it("fetches starred repos and PRs", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield {
          data: [{ full_name: "org/repo-a" }, { full_name: "org/repo-b" }],
        };
      })(),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [makePRItem(1, "org/repo-a"), makePRItem(2, "org/repo-b")],
        },
      })
      .mockResolvedValueOnce({
        data: { items: [makePRItem(3, "org/repo-c")] },
      })
      .mockResolvedValueOnce({
        data: { items: [makePRItem(4, "org/repo-d")] },
      });

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);

    expect(result.skippedDueToRateLimit).toBe(false);
    expect(result.starredRepoCount).toBe(2);
    expect(result.mergedPRCount).toBe(2);
    expect(result.closedPRCount).toBe(1);
    expect(result.openPRCount).toBe(1);
    expect(result.reposScoredCount).toBeGreaterThanOrEqual(2);
    const state = scout.getState();
    expect(state.starredRepos).toEqual(["org/repo-a", "org/repo-b"]);
    expect(state.mergedPRs).toHaveLength(2);
    expect(state.closedPRs).toHaveLength(1);
    expect(state.openPRs).toHaveLength(1);
    expect(state.openPRs[0].url).toBe("https://github.com/org/repo-d/pull/4");
  });

  it("handles empty results", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } });

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);
    expect(result.starredRepoCount).toBe(0);
    expect(result.mergedPRCount).toBe(0);
    expect(result.closedPRCount).toBe(0);
    expect(result.openPRCount).toBe(0);
    expect(result.reposScoredCount).toBe(0);
  });

  it("throws when githubUsername is not set", async () => {
    const state = ScoutStateSchema.parse({
      version: 1,
      preferences: { githubUsername: "" },
    });
    const token = uniqueToken();
    const scout = new OssScout(token, state);
    await expect(bootstrapScout(scout, token)).rejects.toThrow(
      "GitHub username not configured",
    );
  });

  it("deduplicates PRs already in state", async () => {
    mockRateLimit(30);
    const existingState = makeState();
    existingState.mergedPRs = [
      {
        url: "https://github.com/org/repo-a/pull/1",
        title: "PR #1",
        mergedAt: "2026-01-15T00:00:00Z",
      },
    ];
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [makePRItem(1, "org/repo-a"), makePRItem(2, "org/repo-a")],
        },
      })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } });

    const token = uniqueToken();
    const scout = new OssScout(token, existingState);
    const result = await bootstrapScout(scout, token);
    expect(result.mergedPRCount).toBe(2);
    expect(scout.getState().mergedPRs).toHaveLength(2);
  });

  it("paginates search results across multiple pages", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makePRItem(i + 1, "org/repo-a"),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: fullPage } })
      .mockResolvedValueOnce({
        data: { items: [makePRItem(101, "org/repo-a")] },
      })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } });

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);
    expect(result.mergedPRCount).toBe(101);
    expect(
      mockOctokitInstance.search.issuesAndPullRequests,
    ).toHaveBeenCalledTimes(4);
  });

  it("reports open-PR fetch failures non-fatally and preserves prior counts", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield {
          data: [{ full_name: "org/repo-a" }],
        };
      })(),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({
        data: { items: [makePRItem(1, "org/repo-a")] },
      })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockRejectedValueOnce(new Error("transient network error"));

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);

    expect(result.openPRCount).toBe(0);
    expect(result.mergedPRCount).toBe(1);
    expect(result.starredRepoCount).toBe(1);
    expect(result.errors).toContain("open PR fetch failed");
  });

  it("propagates auth errors from open-PR fetch (does not silently degrade)", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    const authError = Object.assign(new Error("Bad credentials"), {
      status: 401,
    });
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockRejectedValueOnce(authError);

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    await expect(bootstrapScout(scout, token)).rejects.toThrow(
      "Bad credentials",
    );
  });

  it("propagates rate-limit errors from open-PR fetch (does not silently degrade)", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    const rateLimitError = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
    });
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockRejectedValueOnce(rateLimitError);

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    await expect(bootstrapScout(scout, token)).rejects.toThrow(
      "API rate limit exceeded",
    );
  });

  it("queries open PRs with correct search qualifiers", async () => {
    mockRateLimit(30);
    mockOctokitInstance.paginate.iterator = vi.fn().mockReturnValue(
      (async function* () {
        yield { data: [] };
      })(),
    );
    mockOctokitInstance.search.issuesAndPullRequests = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({
        data: {
          items: [
            makePRItem(1, "org/open-repo"),
            makePRItem(2, "org/open-repo"),
          ],
        },
      });

    const token = uniqueToken();
    const scout = new OssScout(token, makeState());
    const result = await bootstrapScout(scout, token);
    expect(result.openPRCount).toBe(2);
    const state = scout.getState();
    expect(state.openPRs).toHaveLength(2);
    expect(scout.getReposWithOpenPRs()).toEqual(["org/open-repo"]);

    const calls = mockOctokitInstance.search.issuesAndPullRequests.mock.calls;
    expect(calls[2][0].q).toBe("is:pr is:open author:testuser");
  });
});
