import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HttpCache } from "./http-cache.js";
import { probeRepoFile } from "./probe-repo-file.js";
import type { Octokit } from "@octokit/rest";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

// Real cachedRequest/HttpCache, but point getHttpCache at a per-test temp dir so
// the ETag path is exercised end-to-end without touching ~/.oss-scout/cache.
let cache: HttpCache;
vi.mock("./http-cache.js", async () => {
  const actual =
    await vi.importActual<typeof import("./http-cache.js")>("./http-cache.js");
  return { ...actual, getHttpCache: () => cache };
});

/** An HTTP-shaped error with a numeric status (Octokit RequestError shape). */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function base64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

/** Octokit mock whose getContent runs the supplied per-call implementation. */
function makeOctokit(
  impl: (args: { path: string; headers?: Record<string, string> }) => Promise<unknown>,
): { octokit: Octokit; getContent: ReturnType<typeof vi.fn> } {
  const getContent = vi.fn(impl);
  const octokit = { repos: { getContent } } as unknown as Octokit;
  return { octokit, getContent };
}

let tmpDir: string;

describe("probeRepoFile ETag caching", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-probe-etag-"));
    cache = new HttpCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches a 200 body and returns identical content on a subsequent 304", async () => {
    const { octokit, getContent } = makeOctokit(async ({ headers }) => {
      // First call: no conditional header, serve the file + ETag.
      if (!headers?.["if-none-match"]) {
        return {
          data: { content: base64("hello world") },
          headers: { etag: "etag-1" },
        };
      }
      // Second call: the stored ETag is replayed — respond 304.
      expect(headers["if-none-match"]).toBe("etag-1");
      throw httpError(304, "Not Modified");
    });

    const first = await probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md");
    const second = await probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md");

    expect(first).toEqual({ text: "hello world", transient: false });
    expect(second).toEqual(first);
    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it("does not cache a 404: a known-absent path stays a miss (no phantom file)", async () => {
    const { octokit, getContent } = makeOctokit(async () => {
      throw httpError(404, "Not Found");
    });

    const first = await probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md");
    const second = await probeRepoFile(octokit, "o", "r", "CONTRIBUTING.md");

    expect(first).toEqual({ text: null, transient: false });
    expect(second).toEqual({ text: null, transient: false });
    // Both probes hit the network (no phantom cache entry masking the absence),
    // and nothing was written to the ETag cache for this path.
    expect(getContent).toHaveBeenCalledTimes(2);
    expect(cache.get("/repos/o/r/contents/CONTRIBUTING.md")).toBeNull();
  });

  it("still surfaces the decoded content when the 304 body was cached earlier", async () => {
    // A repo whose doc later 304s must not degrade to a null text — the cached
    // body has to flow back through the base64 decode path.
    const { octokit } = makeOctokit(async ({ headers }) => {
      if (!headers?.["if-none-match"]) {
        return {
          data: { content: base64("# Roadmap\n#42") },
          headers: { etag: "rm-1" },
        };
      }
      throw httpError(304, "Not Modified");
    });

    await probeRepoFile(octokit, "o", "r", "ROADMAP.md");
    const revalidated = await probeRepoFile(octokit, "o", "r", "ROADMAP.md");
    expect(revalidated).toEqual({ text: "# Roadmap\n#42", transient: false });
  });
});
