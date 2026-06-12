import { describe, it, expect, vi, beforeEach } from "vitest";
import { warn } from "./logger.js";
import { probeRepoFile } from "./probe-repo-file.js";
import type { Octokit } from "@octokit/rest";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

/** An HTTP-shaped error with a numeric status (Octokit RequestError shape). */
function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** Build an Octokit mock whose getContent runs the supplied implementation. */
function makeOctokit(impl: (path: string) => Promise<unknown>): Octokit {
  return {
    repos: {
      getContent: vi.fn(({ path }: { path: string }) => impl(path)),
    },
  } as unknown as Octokit;
}

describe("probeRepoFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns decoded content on a 200 file payload", async () => {
    const octokit = makeOctokit(async () => ({
      data: { content: Buffer.from("hello world", "utf-8").toString("base64") },
    }));
    const result = await probeRepoFile(octokit, "o", "r", "README.md");
    expect(result).toEqual({ text: "hello world", transient: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a clean null on 404 (file absent)", async () => {
    const octokit = makeOctokit(async () => {
      throw httpError(404, "Not Found");
    });
    const result = await probeRepoFile(octokit, "o", "r", "ROADMAP.md");
    expect(result).toEqual({ text: null, transient: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a clean null on a non-content payload (e.g. directory listing)", async () => {
    const octokit = makeOctokit(async () => ({ data: [] }));
    const result = await probeRepoFile(octokit, "o", "r", "docs");
    expect(result).toEqual({ text: null, transient: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns a clean null when content is present but not a string", async () => {
    const octokit = makeOctokit(async () => ({ data: { content: 123 } }));
    const result = await probeRepoFile(octokit, "o", "r", "weird");
    expect(result).toEqual({ text: null, transient: false });
  });

  it("rethrows 401 auth errors as fatal", async () => {
    const octokit = makeOctokit(async () => {
      throw httpError(401, "Unauthorized");
    });
    await expect(
      probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md"),
    ).rejects.toThrow("Unauthorized");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows rate-limit errors as fatal", async () => {
    const octokit = makeOctokit(async () => {
      throw httpError(429, "API rate limit exceeded");
    });
    await expect(
      probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md"),
    ).rejects.toThrow("rate limit");
  });

  it("returns a transient null and warns on a 5xx server error", async () => {
    const octokit = makeOctokit(async () => {
      throw httpError(503, "Service Unavailable");
    });
    const result = await probeRepoFile(octokit, "o", "r", "README.md");
    expect(result).toEqual({ text: null, transient: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns a transient null and warns on a network error (no status)", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("ENOTFOUND api.github.com");
    });
    const result = await probeRepoFile(octokit, "o", "r", "README.md");
    expect(result).toEqual({ text: null, transient: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
