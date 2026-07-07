import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  prefetchIssueCores,
  graphqlSearchIssues,
  issueCoreKey,
  type IssueRef,
} from "./issue-graphql.js";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

function graphqlNode(over: Partial<Record<string, unknown>> = {}) {
  return {
    databaseId: 100,
    title: "A title",
    body: "A body",
    state: "OPEN",
    labels: { nodes: [{ name: "bug" }, { name: "help wanted" }] },
    comments: { totalCount: 4 },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    ...over,
  };
}

function makeOctokit(graphql: ReturnType<typeof vi.fn>): Octokit {
  return { graphql } as unknown as Octokit;
}

const ISSUES: IssueRef[] = [
  { owner: "owner", repo: "repo", number: 1 },
  { owner: "owner", repo: "repo", number: 2 },
];

describe("prefetchIssueCores", () => {
  it("returns an empty map without calling GraphQL for no issues", async () => {
    const graphql = vi.fn();
    const result = await prefetchIssueCores(makeOctokit(graphql), []);
    expect(result.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("normalizes GraphQL nodes into the REST-equivalent core shape", async () => {
    const graphql = vi.fn().mockResolvedValue({
      i0: { issue: graphqlNode({ databaseId: 11 }) },
      i1: {
        issue: graphqlNode({
          databaseId: 22,
          state: "CLOSED",
          body: null,
          labels: { nodes: [] },
          comments: { totalCount: 0 },
        }),
      },
    });
    const result = await prefetchIssueCores(makeOctokit(graphql), ISSUES);

    const c1 = result.get(issueCoreKey("owner", "repo", 1));
    expect(c1).toEqual({
      id: 11,
      title: "A title",
      body: "A body",
      state: "open",
      labels: ["bug", "help wanted"],
      commentCount: 4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
    });

    const c2 = result.get(issueCoreKey("owner", "repo", 2));
    // CLOSED → "closed", null body → "", empty labels → []
    expect(c2?.state).toBe("closed");
    expect(c2?.body).toBe("");
    expect(c2?.labels).toEqual([]);
    expect(c2?.commentCount).toBe(0);
  });

  it("passes owner/name/number as GraphQL variables, not interpolated text", async () => {
    const graphql = vi.fn().mockResolvedValue({
      i0: { issue: graphqlNode() },
      i1: { issue: graphqlNode() },
    });
    await prefetchIssueCores(makeOctokit(graphql), ISSUES);

    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, variables] = graphql.mock.calls[0];
    expect(query).toContain("repository(owner: $o0, name: $n0)");
    expect(query).toContain("issue(number: $num0)");
    expect(variables).toMatchObject({
      o0: "owner",
      n0: "repo",
      num0: 1,
      o1: "owner",
      n1: "repo",
      num1: 2,
    });
  });

  it("omits issues whose node is null (deleted/inaccessible)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      i0: { issue: graphqlNode({ databaseId: 11 }) },
      i1: { issue: null },
    });
    const result = await prefetchIssueCores(makeOctokit(graphql), ISSUES);
    expect(result.has(issueCoreKey("owner", "repo", 1))).toBe(true);
    expect(result.has(issueCoreKey("owner", "repo", 2))).toBe(false);
  });

  it("omits issues whose databaseId is null", async () => {
    const graphql = vi.fn().mockResolvedValue({
      i0: { issue: graphqlNode({ databaseId: null }) },
      i1: { issue: graphqlNode({ databaseId: 22 }) },
    });
    const result = await prefetchIssueCores(makeOctokit(graphql), ISSUES);
    expect(result.has(issueCoreKey("owner", "repo", 1))).toBe(false);
    expect(result.has(issueCoreKey("owner", "repo", 2))).toBe(true);
  });

  it("dedups repeated issues into a single alias", async () => {
    const graphql = vi.fn().mockResolvedValue({
      i0: { issue: graphqlNode({ databaseId: 11 }) },
    });
    const dupes: IssueRef[] = [
      { owner: "owner", repo: "repo", number: 1 },
      { owner: "owner", repo: "repo", number: 1 },
    ];
    const result = await prefetchIssueCores(makeOctokit(graphql), dupes);

    const [, variables] = graphql.mock.calls[0];
    // Only one alias worth of variables for the duplicated issue.
    expect(variables).not.toHaveProperty("num1");
    expect(result.size).toBe(1);
  });

  it("uses partial data attached to a GraphQL error (one bad issue in batch)", async () => {
    const err = Object.assign(new Error("Could not resolve to an Issue"), {
      data: { i0: { issue: graphqlNode({ databaseId: 11 }) }, i1: null },
    });
    const graphql = vi.fn().mockRejectedValue(err);
    const result = await prefetchIssueCores(makeOctokit(graphql), ISSUES);
    // The resolved alias survives; the errored one is absent (→ REST fallback).
    expect(result.has(issueCoreKey("owner", "repo", 1))).toBe(true);
    expect(result.has(issueCoreKey("owner", "repo", 2))).toBe(false);
  });

  it("returns an empty map on a non-fatal error with no partial data", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const result = await prefetchIssueCores(makeOctokit(graphql), ISSUES);
    expect(result.size).toBe(0);
  });

  it("propagates a 401 auth error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("Bad credentials"), { status: 401 });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      prefetchIssueCores(makeOctokit(graphql), ISSUES),
    ).rejects.toThrow("Bad credentials");
  });

  it("propagates a rate-limit error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
    });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      prefetchIssueCores(makeOctokit(graphql), ISSUES),
    ).rejects.toThrow("rate limit");
  });
});

describe("graphqlSearchIssues", () => {
  function searchNode(over: Partial<Record<string, unknown>> = {}) {
    return {
      url: "https://github.com/owner/repo/issues/7",
      title: "Add dark mode",
      updatedAt: "2026-03-01T00:00:00Z",
      labels: {
        nodes: [{ name: "good first issue" }, { name: "enhancement" }],
      },
      repository: { nameWithOwner: "owner/repo" },
      ...over,
    };
  }

  it("maps GraphQL nodes into GitHubSearchItem shape incl. total_count", async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: { issueCount: 42, nodes: [searchNode()] },
    });
    const result = await graphqlSearchIssues(
      makeOctokit(graphql),
      "is:issue is:open",
      10,
    );

    expect(result).not.toBeNull();
    expect(result!.total_count).toBe(42);
    expect(result!.items).toEqual([
      {
        html_url: "https://github.com/owner/repo/issues/7",
        repository_url: "https://api.github.com/repos/owner/repo",
        updated_at: "2026-03-01T00:00:00Z",
        title: "Add dark mode",
        labels: [{ name: "good first issue" }, { name: "enhancement" }],
      },
    ]);
  });

  it("filters out empty / non-Issue nodes (no url) and repository-less nodes", async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: {
        issueCount: 3,
        nodes: [
          searchNode({ url: "https://github.com/a/b/issues/1" }),
          {}, // non-Issue node the fragment skipped → no url
          null, // partial-error null
          searchNode({ repository: null }), // has url but no repo
        ],
      },
    });
    const result = await graphqlSearchIssues(
      makeOctokit(graphql),
      "is:issue",
      10,
    );

    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].html_url).toBe("https://github.com/a/b/issues/1");
  });

  it("defaults missing labels/updatedAt without throwing", async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: {
        issueCount: 1,
        nodes: [
          {
            url: "https://github.com/a/b/issues/1",
            title: "No labels",
            repository: { nameWithOwner: "a/b" },
          },
        ],
      },
    });
    const result = await graphqlSearchIssues(
      makeOctokit(graphql),
      "is:issue",
      10,
    );
    expect(result!.items[0].labels).toEqual([]);
    expect(result!.items[0].updated_at).toBe("");
  });

  it("clamps first into GitHub's [1, 100] range", async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: { issueCount: 0, nodes: [] },
    });

    await graphqlSearchIssues(makeOctokit(graphql), "q", 250);
    expect(graphql.mock.calls[0][1]).toMatchObject({ first: 100 });

    graphql.mockClear();
    await graphqlSearchIssues(makeOctokit(graphql), "q", 0);
    expect(graphql.mock.calls[0][1]).toMatchObject({ first: 1 });
  });

  it("passes the query through as a variable (sort qualifier included)", async () => {
    const graphql = vi.fn().mockResolvedValue({
      search: { issueCount: 0, nodes: [] },
    });
    await graphqlSearchIssues(
      makeOctokit(graphql),
      "is:issue is:open sort:created-desc",
      30,
    );

    const [document, variables] = graphql.mock.calls[0];
    // Query text is a variable, never interpolated into the document.
    expect(document).toContain("search(query: $q, type: ISSUE, first: $first)");
    expect(variables).toMatchObject({
      q: "is:issue is:open sort:created-desc",
      first: 30,
    });
  });

  it("keeps partial data attached to a GraphQL error", async () => {
    const err = Object.assign(new Error("Something failed on one node"), {
      data: {
        search: {
          issueCount: 5,
          nodes: [searchNode({ url: "https://github.com/a/b/issues/1" }), null],
        },
      },
    });
    const graphql = vi.fn().mockRejectedValue(err);
    const result = await graphqlSearchIssues(makeOctokit(graphql), "q", 10);

    expect(result!.total_count).toBe(5);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].html_url).toBe("https://github.com/a/b/issues/1");
  });

  it("returns null on a non-fatal error with no partial data", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const result = await graphqlSearchIssues(makeOctokit(graphql), "q", 10);
    expect(result).toBeNull();
  });

  it("returns null when the response has no search connection", async () => {
    const graphql = vi.fn().mockResolvedValue({});
    const result = await graphqlSearchIssues(makeOctokit(graphql), "q", 10);
    expect(result).toBeNull();
  });

  it("propagates a 401 auth error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("Bad credentials"), { status: 401 });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      graphqlSearchIssues(makeOctokit(graphql), "q", 10),
    ).rejects.toThrow("Bad credentials");
  });

  it("propagates a rate-limit error (rethrowIfFatal)", async () => {
    const err = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
    });
    const graphql = vi.fn().mockRejectedValue(err);
    await expect(
      graphqlSearchIssues(makeOctokit(graphql), "q", 10),
    ).rejects.toThrow("rate limit");
  });
});
