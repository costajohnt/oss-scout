import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractRepoFromUrl,
  parseGitHubUrl,
  daysBetween,
} from "./utils.js";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

// ── extractRepoFromUrl ──

describe("extractRepoFromUrl", () => {
  it("extracts from PR URL", () => {
    expect(extractRepoFromUrl("https://github.com/owner/repo/pull/123")).toBe(
      "owner/repo",
    );
  });

  it("extracts from issue URL", () => {
    expect(
      extractRepoFromUrl("https://github.com/owner/repo/issues/456"),
    ).toBe("owner/repo");
  });

  it("extracts from API URL", () => {
    expect(extractRepoFromUrl("https://api.github.com/repos/owner/repo")).toBe(
      "owner/repo",
    );
  });

  it("extracts from API URL with subpath", () => {
    expect(
      extractRepoFromUrl("https://api.github.com/repos/owner/repo/issues/1"),
    ).toBe("owner/repo");
  });

  it("extracts from plain repo URL", () => {
    expect(extractRepoFromUrl("https://github.com/owner/repo")).toBe(
      "owner/repo",
    );
  });

  it("extracts from repo URL with trailing slash", () => {
    expect(extractRepoFromUrl("https://github.com/owner/repo/")).toBe(
      "owner/repo",
    );
  });

  it("returns null for non-GitHub URL", () => {
    expect(extractRepoFromUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRepoFromUrl("")).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(extractRepoFromUrl("not-a-url")).toBeNull();
  });
});

// ── parseGitHubUrl ──

describe("parseGitHubUrl", () => {
  it("parses a valid PR URL", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/pull/42");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      number: 42,
      type: "pull",
    });
  });

  it("parses a valid issue URL", () => {
    const result = parseGitHubUrl("https://github.com/owner/repo/issues/99");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      number: 99,
      type: "issues",
    });
  });

  it("returns null for a plain repo URL (no issue/PR)", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo")).toBeNull();
  });

  it("returns null for non-GitHub URL", () => {
    expect(
      parseGitHubUrl("https://gitlab.com/owner/repo/issues/1"),
    ).toBeNull();
  });

  it("returns null for invalid owner characters", () => {
    expect(
      parseGitHubUrl("https://github.com/bad owner/repo/issues/1"),
    ).toBeNull();
  });
});

// ── daysBetween ──

describe("daysBetween", () => {
  it("returns 0 for the same date", () => {
    const now = new Date();
    expect(daysBetween(now, now)).toBe(0);
  });

  it("returns correct days for past date", () => {
    const from = new Date("2025-01-01");
    const to = new Date("2025-01-11");
    expect(daysBetween(from, to)).toBe(10);
  });

  it("clamps to 0 when from > to", () => {
    const from = new Date("2025-06-01");
    const to = new Date("2025-01-01");
    expect(daysBetween(from, to)).toBe(0);
  });
});

// ── getCLIVersion ──

describe("getCLIVersion", () => {
  it("returns 'unknown' when package.json cannot be read", async () => {
    vi.resetModules();
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return { ...actual, readFileSync: () => { throw new Error("ENOENT"); } };
    });
    const { getCLIVersion: freshGetCLIVersion } = await import("./utils.js");
    expect(freshGetCLIVersion()).toBe("unknown");
  });
});

// ── getGitHubToken ──

describe("getGitHubToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns token from GITHUB_TOKEN env var", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      execFileSync: vi.fn().mockReturnValue(""),
    }));

    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_test_token_from_env";
    try {
      const { getGitHubToken } = await import("./utils.js");
      expect(getGitHubToken()).toBe("ghp_test_token_from_env");
    } finally {
      if (originalToken !== undefined) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it("returns null when no token is available", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        throw new Error("gh not found");
      }),
    }));

    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const { getGitHubToken } = await import("./utils.js");
      expect(getGitHubToken()).toBeNull();
    } finally {
      if (originalToken !== undefined) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });
});

// ── requireGitHubToken ──

describe("requireGitHubToken", () => {
  it("throws ConfigurationError when no token is available", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        throw new Error("gh not found");
      }),
    }));

    const originalToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const { requireGitHubToken } = await import("./utils.js");
      expect(() => requireGitHubToken()).toThrow("GitHub authentication");
    } finally {
      if (originalToken !== undefined) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });
});
