import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass-through http-cache: probeRepoFile now routes its getContent through
// cachedRequest. Exercise the real fetcher here without touching the on-disk
// ETag cache; ETag behavior is covered in probe-repo-file.etag tests.
vi.mock("./http-cache.js", () => ({
  getHttpCache: () => ({}),
  cachedRequest: async (
    _cache: unknown,
    _url: string,
    fetcher: (headers: Record<string, string>) => Promise<{ data: unknown }>,
  ) => (await fetcher({})).data,
}));

import {
  parseRoadmapIssueRefs,
  fetchRoadmapIssueRefs,
  _clearRoadmapCacheForTests,
} from "./roadmap.js";

beforeEach(() => {
  _clearRoadmapCacheForTests();
});

describe("parseRoadmapIssueRefs", () => {
  it("extracts bare #N references", () => {
    const md = "Plans:\n- support migration #42\n- ship transports #128\n";
    expect(parseRoadmapIssueRefs(md, "a", "b")).toEqual(new Set([42, 128]));
  });

  it("ignores markdown headings starting with #", () => {
    const md = "# Roadmap\n## Q1 priorities\n- review #99\n";
    expect(parseRoadmapIssueRefs(md, "a", "b")).toEqual(new Set([99]));
  });

  it("extracts in-repo GitHub issue URLs", () => {
    const md =
      "See https://github.com/foo/bar/issues/1 and https://github.com/Foo/BAR/issues/2 for context.";
    expect(parseRoadmapIssueRefs(md, "foo", "bar")).toEqual(new Set([1, 2]));
  });

  it("ignores URLs pointing to other repos", () => {
    const md =
      "Tracks https://github.com/other/repo/issues/77 (out of scope here).";
    expect(parseRoadmapIssueRefs(md, "foo", "bar")).toEqual(new Set());
  });

  it("handles parenthesized and bracketed refs", () => {
    const md = "(see #5) and [also #6]";
    expect(parseRoadmapIssueRefs(md, "a", "b")).toEqual(new Set([5, 6]));
  });

  it("does not match HTML entities like &#1234;", () => {
    const md = "Symbol &#9733; is a star, not issue #1234.";
    // Should still pick up #1234 (separate token), but NOT the &#9733;
    expect(parseRoadmapIssueRefs(md, "a", "b")).toEqual(new Set([1234]));
  });

  it("returns empty set for content without refs", () => {
    expect(parseRoadmapIssueRefs("Just prose, no refs.", "a", "b")).toEqual(
      new Set(),
    );
  });

  it("dedupes repeated references", () => {
    const md = "#7 #7 #7 https://github.com/a/b/issues/7";
    expect(parseRoadmapIssueRefs(md, "a", "b")).toEqual(new Set([7]));
  });

  it("extracts owner/repo#N cross-repo refs scoped to the current repo", () => {
    const md = "Track foo/bar#42 and FOO/BAR#43 alongside #44.";
    expect(parseRoadmapIssueRefs(md, "foo", "bar")).toEqual(
      new Set([42, 43, 44]),
    );
  });

  it("ignores owner/repo#N refs pointing to other repos", () => {
    const md = "See other/proj#99 for context (out of scope here).";
    expect(parseRoadmapIssueRefs(md, "foo", "bar")).toEqual(new Set());
  });

  it("dedupes when the same issue appears as #N, owner/repo#N, and URL", () => {
    const md = "Track #7, foo/bar#7, and https://github.com/foo/bar/issues/7.";
    expect(parseRoadmapIssueRefs(md, "foo", "bar")).toEqual(new Set([7]));
  });
});

describe("fetchRoadmapIssueRefs", () => {
  function makeOctokit(impl: (path: string) => Promise<unknown>) {
    return {
      repos: {
        getContent: vi.fn().mockImplementation(async ({ path }) => impl(path)),
      },
    } as never;
  }

  function notFound() {
    return Object.assign(new Error("not found"), { status: 404 });
  }

  it("fetches the first matching path and parses refs", async () => {
    const md = "- ship #11\n- watch #12\n";
    const octokit = makeOctokit(async (path: string) => {
      if (path === "ROADMAP.md") {
        return {
          data: { content: Buffer.from(md, "utf-8").toString("base64") },
        };
      }
      throw notFound();
    });
    const refs = await fetchRoadmapIssueRefs(octokit, "foo", "bar");
    expect(refs).toEqual(new Set([11, 12]));
  });

  it("falls through 404s to the next candidate path", async () => {
    const md = "- #99";
    const octokit = makeOctokit(async (path: string) => {
      if (path === "docs/ROADMAP.md") {
        return {
          data: { content: Buffer.from(md, "utf-8").toString("base64") },
        };
      }
      throw notFound();
    });
    const refs = await fetchRoadmapIssueRefs(octokit, "foo", "bar");
    expect(refs).toEqual(new Set([99]));
  });

  it("returns empty set when no roadmap exists", async () => {
    const octokit = makeOctokit(async () => {
      throw notFound();
    });
    const refs = await fetchRoadmapIssueRefs(octokit, "foo", "bar");
    expect(refs).toEqual(new Set());
  });

  it("caches results — second call hits no API", async () => {
    const md = "- #5";
    const calls: string[] = [];
    const octokit = makeOctokit(async (path: string) => {
      calls.push(path);
      if (path === "ROADMAP.md") {
        return {
          data: { content: Buffer.from(md, "utf-8").toString("base64") },
        };
      }
      throw notFound();
    });
    await fetchRoadmapIssueRefs(octokit, "foo", "bar");
    const beforeCount = calls.length;
    const second = await fetchRoadmapIssueRefs(octokit, "foo", "bar");
    expect(calls.length).toBe(beforeCount);
    expect(second).toEqual(new Set([5]));
  });

  it("propagates 401 errors", async () => {
    const octokit = makeOctokit(async () => {
      throw Object.assign(new Error("unauth"), { status: 401 });
    });
    await expect(
      fetchRoadmapIssueRefs(octokit, "foo", "bar"),
    ).rejects.toThrow();
  });

  it("propagates rate-limit errors", async () => {
    const octokit = makeOctokit(async () => {
      throw Object.assign(new Error("API rate limit exceeded"), {
        status: 403,
      });
    });
    await expect(
      fetchRoadmapIssueRefs(octokit, "foo", "bar"),
    ).rejects.toThrow();
  });
});
