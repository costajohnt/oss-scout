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

  it("propagates 401 auth errors instead of swallowing", async () => {
    const authErr = Object.assign(new Error("Unauthorized"), { status: 401 });
    const octokit = {
      repos: {
        get: vi.fn().mockRejectedValue(authErr),
        listCommits: vi.fn().mockRejectedValue(authErr),
      },
    } as unknown as Octokit;

    await expect(
      checkProjectHealth(octokit, "auth-org", "auth-repo"),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of swallowing", async () => {
    const rateErr = Object.assign(new Error("API rate limit exceeded"), {
      status: 429,
    });
    const octokit = {
      repos: {
        get: vi.fn().mockRejectedValue(rateErr),
        listCommits: vi.fn().mockRejectedValue(rateErr),
      },
    } as unknown as Octokit;

    await expect(
      checkProjectHealth(octokit, "limited-org", "limited-repo"),
    ).rejects.toThrow("rate limit");
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
    const err = new Error("Not Found") as Error & { status: number };
    err.status = 404;
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(err),
      },
    } as unknown as Octokit;

    const guidelines = await fetchContributionGuidelines(
      octokit,
      "missing-org",
      "missing-repo",
    );
    expect(guidelines).toBeUndefined();
  });

  it("propagates 401 auth errors instead of swallowing", async () => {
    const err = new Error("Unauthorized") as Error & { status: number };
    err.status = 401;
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(err),
      },
    } as unknown as Octokit;

    await expect(
      fetchContributionGuidelines(octokit, "auth-org", "auth-repo"),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of swallowing", async () => {
    const err = new Error("API rate limit exceeded") as Error & {
      status: number;
    };
    err.status = 429;
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(err),
      },
    } as unknown as Octokit;

    await expect(
      fetchContributionGuidelines(octokit, "limited-org", "limited-repo"),
    ).rejects.toThrow("rate limit");
  });

  it("propagates 401 even when a different probe path succeeded first", async () => {
    // Path-restricted token: CONTRIBUTING.md returns content, but
    // .github/CONTRIBUTING.md 401s. Auth misconfig must surface, not be hidden.
    const authErr = new Error("Unauthorized") as Error & { status: number };
    authErr.status = 401;
    const content = "# Contributing\n\nUse conventional commits.";
    const octokit = {
      repos: {
        getContent: vi.fn(({ path }: { path: string }) => {
          if (path === "CONTRIBUTING.md") {
            return Promise.resolve({
              data: { content: Buffer.from(content).toString("base64") },
            });
          }
          if (path === ".github/CONTRIBUTING.md") {
            return Promise.reject(authErr);
          }
          const notFound = new Error("Not Found") as Error & {
            status: number;
          };
          notFound.status = 404;
          return Promise.reject(notFound);
        }),
      },
    } as unknown as Octokit;

    await expect(
      fetchContributionGuidelines(octokit, "mixed-org", "mixed-repo"),
    ).rejects.toThrow("Unauthorized");
  });
});
