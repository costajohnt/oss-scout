import { describe, it, expect, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  prefetchIssueCores,
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
