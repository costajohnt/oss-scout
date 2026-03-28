import { describe, it, expect, vi } from "vitest";
import {
  checkProjectHealth,
  fetchContributionGuidelines,
} from "./repo-health.js";
import type { Octokit } from "@octokit/rest";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

// Mock http-cache to pass through to the real fetcher (no caching in tests)
vi.mock("./http-cache.js", () => ({
  getHttpCache: () => ({}),
  cachedRequest: async (
    _cache: unknown,
    _url: string,
    fetcher: (headers: Record<string, string>) => Promise<{ data: unknown }>,
  ) => {
    const response = await fetcher({});
    return response.data;
  },
  cachedTimeBased: async (
    _cache: unknown,
    _key: string,
    _ttl: number,
    fetcher: () => Promise<unknown>,
  ) => {
    return fetcher();
  },
}));

// ── checkProjectHealth ──

describe("checkProjectHealth", () => {
  it("returns active health for a recently updated repo", async () => {
    const recentDate = new Date().toISOString();
    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: {
            open_issues_count: 15,
            pushed_at: recentDate,
            stargazers_count: 500,
            forks_count: 50,
            language: "TypeScript",
          },
          headers: {},
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { author: { date: recentDate } } }],
        }),
      },
    } as unknown as Octokit;

    const health = await checkProjectHealth(
      octokit,
      "active-org",
      "active-repo",
    );
    expect(health.isActive).toBe(true);
    expect(health.daysSinceLastCommit).toBeLessThan(30);
    expect(health.stargazersCount).toBe(500);
    expect(health.forksCount).toBe(50);
    expect(health.language).toBe("TypeScript");
    expect(health.checkFailed).toBeUndefined();
  });

  it("returns inactive health for an old repo", async () => {
    const oldDate = new Date("2023-01-01").toISOString();
    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: {
            open_issues_count: 5,
            pushed_at: oldDate,
            stargazers_count: 10,
            forks_count: 2,
            language: "JavaScript",
          },
          headers: {},
        }),
        listCommits: vi.fn().mockResolvedValue({
          data: [{ commit: { author: { date: oldDate } } }],
        }),
      },
    } as unknown as Octokit;

    const health = await checkProjectHealth(
      octokit,
      "inactive-org",
      "inactive-repo",
    );
    expect(health.isActive).toBe(false);
    expect(health.daysSinceLastCommit).toBeGreaterThan(30);
  });

  it("returns checkFailed: true on API error", async () => {
    const octokit = {
      repos: {
        get: vi.fn().mockRejectedValue(new Error("API error")),
        listCommits: vi.fn().mockRejectedValue(new Error("API error")),
      },
    } as unknown as Octokit;

    const health = await checkProjectHealth(octokit, "error-org", "error-repo");
    expect(health.checkFailed).toBe(true);
    expect(health.failureReason).toBeDefined();
    expect(health.isActive).toBe(false);
  });
});

// ── fetchContributionGuidelines ──

describe("fetchContributionGuidelines", () => {
  it("returns guidelines when CONTRIBUTING.md is found", async () => {
    const content =
      "# Contributing\n\nPlease use conventional commits and eslint.";
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { content: Buffer.from(content).toString("base64") },
        }),
      },
    } as unknown as Octokit;

    const guidelines = await fetchContributionGuidelines(
      octokit,
      "found-org",
      "found-repo",
    );
    expect(guidelines).toBeDefined();
    expect(guidelines!.rawContent).toContain("Contributing");
    expect(guidelines!.commitMessageFormat).toBe("conventional commits");
    expect(guidelines!.linter).toBe("ESLint");
  });

  it("returns undefined when no CONTRIBUTING.md found (404)", async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error("Not Found")),
      },
    } as unknown as Octokit;

    const guidelines = await fetchContributionGuidelines(
      octokit,
      "missing-org",
      "missing-repo",
    );
    expect(guidelines).toBeUndefined();
  });
});
