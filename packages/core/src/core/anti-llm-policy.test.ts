import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./errors.js", () => ({
  errorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
  getHttpStatusCode: vi.fn((e: unknown) => {
    if (e && typeof e === "object" && "status" in e) {
      const s = (e as { status: unknown }).status;
      return typeof s === "number" ? s : undefined;
    }
    return undefined;
  }),
  isRateLimitError: vi.fn((e: unknown) => {
    if (e && typeof e === "object" && "status" in e) {
      const s = (e as { status: unknown }).status;
      if (s === 429) return true;
      if (
        s === 403 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("rate limit")
      ) {
        return true;
      }
    }
    return false;
  }),
}));

vi.mock("./http-cache.js", () => ({
  getHttpCache: vi.fn(() => ({
    getIfFresh: vi.fn(() => null),
    set: vi.fn(),
  })),
}));

import {
  scanForAntiLLMPolicy,
  fetchAndScanAntiLLMPolicy,
  ANTI_LLM_KEYWORDS,
} from "./anti-llm-policy.js";
import type { Octokit } from "@octokit/rest";

// ── Helpers ────────────────────────────────────────────────────────

/** Helper: an HTTP-shaped error with a numeric status (Octokit RequestError shape). */
function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Build an Octokit mock whose getContent returns base64-encoded text for
 * matching paths and 404s for everything else.
 */
function makeMockOctokit(filesByPath: Record<string, string>): Octokit {
  const getContent = vi.fn(({ path }: { path: string }) => {
    if (path in filesByPath) {
      return Promise.resolve({
        data: {
          content: Buffer.from(filesByPath[path] ?? "", "utf-8").toString(
            "base64",
          ),
        },
      });
    }
    return Promise.reject(httpError(404, "Not Found"));
  });
  return { repos: { getContent } } as unknown as Octokit;
}

// ── scanForAntiLLMPolicy (pure) ────────────────────────────────────

describe("scanForAntiLLMPolicy", () => {
  it("returns no match for empty input", () => {
    expect(scanForAntiLLMPolicy("")).toEqual({
      matched: false,
      matchedKeywords: [],
    });
  });

  it("returns no match for plain prose without anti-AI signals", () => {
    const text =
      "Please open an issue before sending a PR. We use ESLint and Prettier.";
    expect(scanForAntiLLMPolicy(text)).toEqual({
      matched: false,
      matchedKeywords: [],
    });
  });

  it("matches an obvious anti-LLM phrase (case-insensitive)", () => {
    const text = "We do not accept No AI-generated code in this project.";
    const result = scanForAntiLLMPolicy(text);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords).toContain("no ai-generated");
  });

  it("matches 'human-authored only'", () => {
    const text = "Submissions must be human-authored only. No exceptions.";
    expect(scanForAntiLLMPolicy(text).matched).toBe(true);
  });

  it("matches 'do not use copilot'", () => {
    const text =
      "Please do not use Copilot for any contributions to this repo.";
    expect(scanForAntiLLMPolicy(text).matched).toBe(true);
  });

  it("returns multiple matched keywords when several appear", () => {
    const text =
      "We require human-authored only contributions and ban on ai-generated code.";
    const result = scanForAntiLLMPolicy(text);
    expect(result.matched).toBe(true);
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT false-positive on 'we use Copilot' style mentions", () => {
    // Common pattern: a project that internally uses Copilot but has no policy
    const text =
      "Many of our maintainers use Copilot. Please run pnpm test before submitting.";
    expect(scanForAntiLLMPolicy(text)).toEqual({
      matched: false,
      matchedKeywords: [],
    });
  });

  it("does NOT false-positive on 'AI-generated documentation may be edited'", () => {
    // Permissive phrasing that mentions AI-generated but isn't a ban
    const text = "AI-generated documentation may be edited by maintainers.";
    expect(scanForAntiLLMPolicy(text).matched).toBe(false);
  });

  it("keeps the keyword table non-empty", () => {
    expect(ANTI_LLM_KEYWORDS.length).toBeGreaterThan(0);
  });
});

// ── fetchAndScanAntiLLMPolicy (integration with Octokit) ───────────

describe("fetchAndScanAntiLLMPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no-match when no policy files exist", async () => {
    const octokit = makeMockOctokit({});
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result).toEqual({
      matched: false,
      matchedKeywords: [],
      sourceFile: null,
    });
  });

  it("returns no-match when policy files exist but contain no keywords", async () => {
    const octokit = makeMockOctokit({
      "CONTRIBUTING.md": "Run tests before submitting. Use ESLint.",
      "README.md": "This is a friendly project.",
    });
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(false);
    expect(result.sourceFile).toBeNull();
  });

  it("matches a CONTRIBUTING.md anti-LLM policy and returns canonical sourceFile", async () => {
    const octokit = makeMockOctokit({
      "CONTRIBUTING.md":
        "We require human-authored only PRs. Please do not use ChatGPT.",
    });
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(true);
    expect(result.sourceFile).toBe("CONTRIBUTING.md");
    expect(result.matchedKeywords).toContain("human-authored only");
  });

  it("falls back to CODE_OF_CONDUCT when CONTRIBUTING is clean", async () => {
    const octokit = makeMockOctokit({
      "CONTRIBUTING.md": "Standard guidelines: open an issue first.",
      "CODE_OF_CONDUCT.md":
        "All contributions must be human-written only and respectful.",
    });
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(true);
    expect(result.sourceFile).toBe("CODE_OF_CONDUCT.md");
  });

  it("falls back to README when CONTRIBUTING and COC are clean", async () => {
    const octokit = makeMockOctokit({
      "README.md":
        "About this project. Please do not submit ai-generated changes.",
    });
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(true);
    expect(result.sourceFile).toBe("README.md");
  });

  it("checks the .github/ variant when root file is missing", async () => {
    const octokit = makeMockOctokit({
      ".github/CONTRIBUTING.md":
        "Submissions must be human-authored only. No exceptions.",
    });
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(true);
    expect(result.sourceFile).toBe("CONTRIBUTING.md");
  });

  it("returns no-match when getContent returns a non-content payload", async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as unknown as Octokit;
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result).toEqual({
      matched: false,
      matchedKeywords: [],
      sourceFile: null,
    });
  });

  it("propagates 401 auth errors instead of swallowing them", async () => {
    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(httpError(401, "Unauthorized")),
      },
    } as unknown as Octokit;
    await expect(
      fetchAndScanAntiLLMPolicy(octokit, "owner", "repo"),
    ).rejects.toThrow("Unauthorized");
  });

  it("propagates 429 rate-limit errors instead of swallowing them", async () => {
    const octokit = {
      repos: {
        getContent: vi
          .fn()
          .mockRejectedValue(httpError(429, "API rate limit exceeded")),
      },
    } as unknown as Octokit;
    await expect(
      fetchAndScanAntiLLMPolicy(octokit, "owner", "repo"),
    ).rejects.toThrow("rate limit");
  });

  it("does NOT cache a no-match result when probes had transient failures", async () => {
    // 5xx is "transient": the function returns NO_MATCH but skips the cache write.
    const cacheSet = vi.fn();
    const { getHttpCache } = await import("./http-cache.js");
    vi.mocked(getHttpCache).mockReturnValue({
      getIfFresh: vi.fn(() => null),
      set: cacheSet,
    } as unknown as ReturnType<typeof getHttpCache>);

    const octokit = {
      repos: {
        getContent: vi.fn().mockRejectedValue(httpError(503, "Server error")),
      },
    } as unknown as Octokit;

    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result).toEqual({
      matched: false,
      matchedKeywords: [],
      sourceFile: null,
    });
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("DOES cache a no-match result when all probes returned clean 404s", async () => {
    const cacheSet = vi.fn();
    const { getHttpCache } = await import("./http-cache.js");
    vi.mocked(getHttpCache).mockReturnValue({
      getIfFresh: vi.fn(() => null),
      set: cacheSet,
    } as unknown as ReturnType<typeof getHttpCache>);

    const octokit = makeMockOctokit({}); // all 404s
    await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(cacheSet).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value when it passes shape validation", async () => {
    const validCached = {
      matched: true,
      matchedKeywords: ["no ai-generated"],
      sourceFile: "CONTRIBUTING.md",
    };
    const { getHttpCache } = await import("./http-cache.js");
    vi.mocked(getHttpCache).mockReturnValue({
      getIfFresh: vi.fn(() => validCached),
      set: vi.fn(),
    } as unknown as ReturnType<typeof getHttpCache>);

    const octokit = makeMockOctokit({});
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result).toEqual(validCached);
  });

  it("ignores a malformed cache value and re-fetches", async () => {
    // Missing matchedKeywords array — should fail the shape guard.
    const malformed = { matched: true, sourceFile: "CONTRIBUTING.md" };
    const { getHttpCache } = await import("./http-cache.js");
    vi.mocked(getHttpCache).mockReturnValue({
      getIfFresh: vi.fn(() => malformed),
      set: vi.fn(),
    } as unknown as ReturnType<typeof getHttpCache>);

    const octokit = makeMockOctokit({}); // all 404s
    const result = await fetchAndScanAntiLLMPolicy(octokit, "owner", "repo");
    expect(result.matched).toBe(false);
    expect(result.sourceFile).toBeNull();
  });
});
