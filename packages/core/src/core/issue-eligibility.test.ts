import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./search-budget.js", () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    waitForBudget: vi.fn().mockResolvedValue(undefined),
    recordCall: vi.fn(),
  })),
}));

vi.mock("./http-cache.js", () => ({
  getHttpCache: vi.fn(() => ({
    getIfFresh: vi.fn(() => null),
    set: vi.fn(),
  })),
}));

vi.mock("./pagination.js", () => ({
  paginateAll: vi.fn(),
}));

import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from "./issue-eligibility.js";
import { paginateAll } from "./pagination.js";
import type { Octokit } from "@octokit/rest";

const mockPaginateAll = vi.mocked(paginateAll);

// ── Helpers ────────────────────────────────────────────────────────

function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function makeMockOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    issues: {
      listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      listComments: vi.fn(),
    },
    search: {
      issuesAndPullRequests: vi.fn().mockResolvedValue({
        data: { total_count: 0, items: [] },
      }),
    },
    paginate: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Octokit;
}

// ── checkNoExistingPR ─────────────────────────────────────────────

describe("checkNoExistingPR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passed:true and linkedPR:null when no PRs are linked", async () => {
    mockPaginateAll.mockResolvedValue([]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBeUndefined();
    expect(result.linkedPR).toBeNull();
  });

  it("returns passed:false and surfaces linkedPR metadata for an open linked PR", async () => {
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 99,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/99",
            user: { login: "alice" },
            pull_request: { url: "some-url", merged_at: null },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 42);
    expect(result.passed).toBe(false);
    expect(result.linkedPR).toEqual({
      number: 99,
      author: "alice",
      state: "open",
      merged: false,
      url: "https://github.com/owner/repo/pull/99",
    });
  });

  it("returns passed:false and marks linkedPR.merged when a merged PR is found", async () => {
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 12,
            state: "closed",
            html_url: "https://github.com/owner/repo/pull/12",
            user: { login: "bob" },
            pull_request: { url: "some-url", merged_at: "2026-01-01" },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 10);
    expect(result.passed).toBe(false);
    expect(result.linkedPR).toEqual({
      number: 12,
      author: "bob",
      state: "closed",
      merged: true,
      url: "https://github.com/owner/repo/pull/12",
    });
  });

  it("classifies a closed-but-unmerged linked PR as state:closed merged:false", async () => {
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 7,
            state: "closed",
            html_url: "https://github.com/owner/repo/pull/7",
            user: { login: "carol" },
            pull_request: { url: "some-url", merged_at: null },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 7);
    expect(result.passed).toBe(false);
    expect(result.linkedPR).toMatchObject({
      number: 7,
      author: "carol",
      state: "closed",
      merged: false,
    });
  });

  it("returns the first linked PR when multiple exist", async () => {
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 1,
            state: "closed",
            html_url: "https://github.com/owner/repo/pull/1",
            user: { login: "first" },
            pull_request: { url: "u1", merged_at: null },
          },
        },
      },
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 2,
            state: "open",
            html_url: "https://github.com/owner/repo/pull/2",
            user: { login: "second" },
            pull_request: { url: "u2", merged_at: null },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 5);
    expect(result.linkedPR).toMatchObject({ number: 1, author: "first" });
  });

  it("returns linkedPR:null when timeline event is missing user.login", async () => {
    // pull_request present (so the count still flips passed:false) but
    // user.login is missing — defensive fallback should yield null metadata.
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 99,
            html_url: "https://github.com/owner/repo/pull/99",
            pull_request: { url: "some-url" },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 8);
    expect(result.passed).toBe(false);
    expect(result.linkedPR).toBeNull();
  });

  it("returns linkedPR:null when timeline event is missing html_url", async () => {
    mockPaginateAll.mockResolvedValue([
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 99,
            user: { login: "alice" },
            pull_request: { url: "some-url" },
          },
        },
      },
    ]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 8);
    expect(result.passed).toBe(false);
    expect(result.linkedPR).toBeNull();
  });

  it("returns passed:true and inconclusive:true on API error", async () => {
    mockPaginateAll.mockRejectedValue(new Error("API timeout"));
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 5);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toContain("API timeout");
    expect(result.linkedPR).toBeNull();
  });

  it("propagates 401 auth errors instead of swallowing", async () => {
    mockPaginateAll.mockRejectedValue(httpError(401, "Unauthorized"));
    const octokit = makeMockOctokit();
    await expect(
      checkNoExistingPR(octokit, "owner", "repo", 1),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of swallowing", async () => {
    mockPaginateAll.mockRejectedValue(
      httpError(429, "API rate limit exceeded"),
    );
    const octokit = makeMockOctokit();
    await expect(
      checkNoExistingPR(octokit, "owner", "repo", 1),
    ).rejects.toThrow("rate limit");
  });

  it("returns passed:true when timeline is empty", async () => {
    mockPaginateAll.mockResolvedValue([]);
    const octokit = makeMockOctokit();
    const result = await checkNoExistingPR(octokit, "owner", "repo", 99);
    expect(result.passed).toBe(true);
    expect(result.linkedPR).toBeNull();
  });
});

// ── checkNotClaimed ───────────────────────────────────────────────

describe("checkNotClaimed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns passed:true when there are no comments", async () => {
    const octokit = makeMockOctokit();
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 0);
    expect(result.passed).toBe(true);
  });

  it('returns passed:false when a comment says "i\'m working on this"', async () => {
    const octokit = makeMockOctokit({
      paginate: vi
        .fn()
        .mockResolvedValue([{ body: "I'm working on this already" }]),
    });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 3);
    expect(result.passed).toBe(false);
  });

  it('returns passed:false when a comment says "i\'ll take this"', async () => {
    const octokit = makeMockOctokit({
      paginate: vi.fn().mockResolvedValue([{ body: "I'll take this issue" }]),
    });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 2);
    expect(result.passed).toBe(false);
  });

  it("returns passed:true when comments are normal discussion", async () => {
    const octokit = makeMockOctokit({
      paginate: vi
        .fn()
        .mockResolvedValue([
          { body: "This would be a nice feature." },
          { body: "I agree, we should add this." },
        ]),
    });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 2);
    expect(result.passed).toBe(true);
  });

  it("returns passed:true and inconclusive:true on API error", async () => {
    const octokit = makeMockOctokit({
      paginate: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 5);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toContain("Network error");
  });

  it("propagates 401 auth errors instead of swallowing", async () => {
    const octokit = makeMockOctokit({
      paginate: vi.fn().mockRejectedValue(httpError(401, "Unauthorized")),
    });
    await expect(
      checkNotClaimed(octokit, "owner", "repo", 1, 3),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of swallowing", async () => {
    const octokit = makeMockOctokit({
      paginate: vi
        .fn()
        .mockRejectedValue(httpError(429, "API rate limit exceeded")),
    });
    await expect(
      checkNotClaimed(octokit, "owner", "repo", 1, 3),
    ).rejects.toThrow("rate limit");
  });

  it("returns passed:true when commentCount is zero (skips API)", async () => {
    const paginateFn = vi.fn();
    const octokit = makeMockOctokit({ paginate: paginateFn });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 0);
    expect(result.passed).toBe(true);
    expect(paginateFn).not.toHaveBeenCalled();
  });

  it("performs case insensitive matching on claim phrases", async () => {
    const octokit = makeMockOctokit({
      paginate: vi
        .fn()
        .mockResolvedValue([{ body: "WORKING ON IT right now" }]),
    });
    const result = await checkNotClaimed(octokit, "owner", "repo", 1, 1);
    expect(result.passed).toBe(false);
  });
});

// ── checkUserMergedPRsInRepo ──────────────────────────────────────

describe("checkUserMergedPRsInRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the count when merged PRs are found", async () => {
    const octokit = makeMockOctokit({
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { total_count: 3, items: [{}, {}, {}] },
        }),
      },
    });
    const result = await checkUserMergedPRsInRepo(octokit, "owner", "repo");
    expect(result).toBe(3);
  });

  it("returns 0 when no merged PRs are found", async () => {
    const octokit = makeMockOctokit({
      search: {
        issuesAndPullRequests: vi.fn().mockResolvedValue({
          data: { total_count: 0, items: [] },
        }),
      },
    });
    const result = await checkUserMergedPRsInRepo(octokit, "owner", "repo");
    expect(result).toBe(0);
  });

  it("returns 0 on API error (non-fatal, not cached)", async () => {
    const octokit = makeMockOctokit({
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockRejectedValue(new Error("Search failed")),
      },
    });
    const result = await checkUserMergedPRsInRepo(octokit, "owner", "repo");
    expect(result).toBe(0);
  });

  it("propagates 401 auth errors instead of returning 0", async () => {
    const octokit = makeMockOctokit({
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockRejectedValue(httpError(401, "Unauthorized")),
      },
    });
    await expect(
      checkUserMergedPRsInRepo(octokit, "owner", "repo"),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of returning 0", async () => {
    const octokit = makeMockOctokit({
      search: {
        issuesAndPullRequests: vi
          .fn()
          .mockRejectedValue(httpError(429, "API rate limit exceeded")),
      },
    });
    await expect(
      checkUserMergedPRsInRepo(octokit, "owner", "repo"),
    ).rejects.toThrow("rate limit");
  });
});

// ── analyzeRequirements ───────────────────────────────────────────

describe("analyzeRequirements", () => {
  it("returns true for numbered steps + code blocks", () => {
    const body =
      "1. First step\n2. Second step\n```js\nconsole.log('hello');\n```\nPlease implement this.";
    expect(analyzeRequirements(body)).toBe(true);
  });

  it("returns true for keywords (should, expect) + sufficient length", () => {
    const body =
      "This feature should allow users to configure the output format. " +
      "We expect the CLI to accept a --format flag with values json, table, csv. " +
      "The default should be table. Users should be able to pipe output to other tools.";
    expect(analyzeRequirements(body)).toBe(true);
  });

  it("returns true for >200 chars + 2+ indicators", () => {
    const body =
      "We need a new feature that should handle edge cases properly. " +
      "- Step 1: Parse the input\n- Step 2: Validate the data\n" +
      "This must be backward compatible with the existing API. " +
      "Additional context: the system currently processes about 1000 requests per second.";
    expect(analyzeRequirements(body)).toBe(true);
  });

  it("returns false for short vague body", () => {
    const body = "This is broken. Please fix it.";
    expect(analyzeRequirements(body)).toBe(false);
  });

  it("returns false for empty/null body", () => {
    expect(analyzeRequirements("")).toBe(false);
    expect(analyzeRequirements(null as unknown as string)).toBe(false);
  });

  it("returns false for only 1 indicator", () => {
    // Only has length > 200, no steps/code/keywords
    const body =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
      "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
      "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris " +
      "nisi ut aliquip ex ea commodo consequat.";
    expect(analyzeRequirements(body)).toBe(false);
  });
});
