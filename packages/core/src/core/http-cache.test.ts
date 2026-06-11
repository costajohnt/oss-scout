import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  HttpCache,
  cachedRequest,
  cachedTimeBased,
  withInflightDedup,
  getHttpCache,
} from "./http-cache.js";

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

let tmpDir: string;

describe("HttpCache", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-http-cache-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves a cache entry", () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/test/repo";

    cache.set(url, "etag-123", { stars: 100 });

    const entry = cache.get(url);
    expect(entry).not.toBeNull();
    expect(entry!.etag).toBe("etag-123");
    expect(entry!.body).toEqual({ stars: 100 });
    expect(entry!.url).toBe(url);
  });

  it("returns null for a missing key", () => {
    const cache = new HttpCache(tmpDir);
    expect(cache.get("https://api.github.com/repos/nonexistent")).toBeNull();
  });

  it("evicts stale entries", () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/stale/repo";

    cache.set(url, "old-etag", { old: true });

    // Backdate the cache entry to 2 days ago
    const hash = crypto.createHash("sha256").update(url).digest("hex");
    const filePath = path.join(tmpDir, `${hash}.json`);
    const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    entry.cachedAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(filePath, JSON.stringify(entry));

    const evicted = cache.evictStale(24 * 60 * 60 * 1000); // max age 1 day
    expect(evicted).toBe(1);
    expect(cache.get(url)).toBeNull();
  });

  it.each([[false], [0], [""], [null]])(
    "cachedTimeBased treats a cached falsy body (%j) as a hit",
    async (falsyBody) => {
      const cache = new HttpCache(tmpDir);
      const key = `falsy-key-${JSON.stringify(falsyBody)}`;
      const fetcher = vi.fn().mockResolvedValue(falsyBody);

      const first = await cachedTimeBased(cache, key, 60_000, fetcher);
      const second = await cachedTimeBased(cache, key, 60_000, fetcher);

      expect(first).toEqual(falsyBody);
      expect(second).toEqual(falsyBody);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("cachedTimeBased refetches once the entry is older than maxAgeMs", async () => {
    const cache = new HttpCache(tmpDir);
    const key = "expiring-key";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce({ v: 2 });

    await cachedTimeBased(cache, key, 60_000, fetcher);

    // Backdate the entry past the max age
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const filePath = path.join(tmpDir, `${hash}.json`);
    const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    entry.cachedAt = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify(entry));

    const result = await cachedTimeBased(cache, key, 60_000, fetcher);
    expect(result).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cachedRequest refetches unconditionally when a 304 arrives but the entry vanished", async () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/orphaned/304";
    cache.set(url, "stale-etag", { old: true });

    const notModified = new Error("Not Modified") as Error & {
      status: number;
    };
    notModified.status = 304;

    const fetcher = vi
      .fn()
      .mockImplementationOnce((headers: Record<string, string>) => {
        expect(headers["if-none-match"]).toBe("stale-etag");
        // Simulate a concurrent process wiping the entry mid-flight
        cache.clear();
        return Promise.reject(notModified);
      })
      .mockImplementationOnce((headers: Record<string, string>) => {
        expect(headers["if-none-match"]).toBeUndefined();
        return Promise.resolve({
          data: { fresh: true },
          headers: { etag: "new-etag" },
        });
      });

    const result = await cachedRequest(cache, url, fetcher);

    expect(result).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.get(url)!.etag).toBe("new-etag");
  });

  it("cachedRequest propagates a failure from the post-304 refetch", async () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/orphaned/304-then-403";
    cache.set(url, "stale-etag", { old: true });

    const notModified = new Error("Not Modified") as Error & {
      status: number;
    };
    notModified.status = 304;
    const rateLimited = new Error("API rate limit exceeded") as Error & {
      status: number;
    };
    rateLimited.status = 403;

    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => {
        cache.clear();
        return Promise.reject(notModified);
      })
      .mockRejectedValueOnce(rateLimited);

    await expect(cachedRequest(cache, url, fetcher)).rejects.toThrow(
      "API rate limit exceeded",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cachedRequest returns the cached body on 304 when the entry is present", async () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/present/304";
    cache.set(url, "etag-live", { cached: true });

    const notModified = new Error("Not Modified") as Error & {
      status: number;
    };
    notModified.status = 304;
    const fetcher = vi.fn().mockRejectedValue(notModified);

    const result = await cachedRequest(cache, url, fetcher);
    expect(result).toEqual({ cached: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deletes corrupt entries on read", () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/corrupt-entry";
    const hash = crypto.createHash("sha256").update(url).digest("hex");
    const filePath = path.join(tmpDir, `${hash}.json`);

    // Write invalid JSON
    fs.writeFileSync(filePath, "not valid json");

    const result = cache.get(url);
    expect(result).toBeNull();

    // The corrupt file should have been deleted
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("ignores an entry whose stored url differs from the requested one (hash collision guard)", () => {
    const cache = new HttpCache(tmpDir);
    const requested = "https://api.github.com/repos/wanted/repo";
    const hash = crypto.createHash("sha256").update(requested).digest("hex");
    const filePath = path.join(tmpDir, `${hash}.json`);

    // Plant an entry at the requested key whose body belongs to another URL.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        etag: "x",
        url: "https://api.github.com/repos/other/repo",
        body: { wrong: true },
        cachedAt: new Date().toISOString(),
      }),
    );

    expect(cache.get(requested)).toBeNull();
  });

  describe("getIfFresh / getEntryIfFresh", () => {
    it("returns the body for a fresh entry and null once it ages out", () => {
      const cache = new HttpCache(tmpDir);
      const key = "fresh-key";
      cache.set(key, "", { v: 1 });

      expect(cache.getIfFresh(key, 60_000)).toEqual({ v: 1 });

      // Backdate past the window.
      const hash = crypto.createHash("sha256").update(key).digest("hex");
      const filePath = path.join(tmpDir, `${hash}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.cachedAt = new Date(Date.now() - 120_000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(entry));

      expect(cache.getIfFresh(key, 60_000)).toBeNull();
      expect(cache.getEntryIfFresh(key, 60_000)).toBeNull();
    });

    it("returns null when cachedAt is unparseable (NaN-age guard)", () => {
      const cache = new HttpCache(tmpDir);
      const key = "bad-date-key";
      cache.set(key, "", { v: 1 });

      const hash = crypto.createHash("sha256").update(key).digest("hex");
      const filePath = path.join(tmpDir, `${hash}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.cachedAt = "not-a-date";
      fs.writeFileSync(filePath, JSON.stringify(entry));

      // age = Date.now() - NaN = NaN, which the !Number.isFinite guard rejects.
      expect(cache.getEntryIfFresh(key, 60_000)).toBeNull();
      expect(cache.getIfFresh(key, 60_000)).toBeNull();
    });

    it("returns null for an entry timestamped in the future (negative age)", () => {
      const cache = new HttpCache(tmpDir);
      const key = "future-key";
      cache.set(key, "", { v: 1 });

      const hash = crypto.createHash("sha256").update(key).digest("hex");
      const filePath = path.join(tmpDir, `${hash}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.cachedAt = new Date(Date.now() + 120_000).toISOString();
      fs.writeFileSync(filePath, JSON.stringify(entry));

      expect(cache.getEntryIfFresh(key, 60_000)).toBeNull();
    });
  });

  it("cachedRequest caches a fresh 200 and sends If-None-Match on the next call", async () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/fresh/cycle";

    const fetcher = vi
      .fn()
      .mockImplementationOnce((headers: Record<string, string>) => {
        // First call: no cache yet, so no conditional header.
        expect(headers["if-none-match"]).toBeUndefined();
        return Promise.resolve({
          data: { stars: 7 },
          headers: { etag: "etag-fresh" },
        });
      })
      .mockImplementationOnce((headers: Record<string, string>) => {
        // Second call: the stored etag is replayed as If-None-Match.
        expect(headers["if-none-match"]).toBe("etag-fresh");
        return Promise.resolve({
          data: { stars: 9 },
          headers: { etag: "etag-fresh-2" },
        });
      });

    const first = await cachedRequest(cache, url, fetcher);
    expect(first).toEqual({ stars: 7 });
    expect(cache.get(url)!.etag).toBe("etag-fresh");

    const second = await cachedRequest(cache, url, fetcher);
    expect(second).toEqual({ stars: 9 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("cachedRequest rethrows a non-304 error from the initial fetch", async () => {
    const cache = new HttpCache(tmpDir);
    const url = "https://api.github.com/repos/boom/repo";
    const serverError = new Error("Internal Server Error") as Error & {
      status: number;
    };
    serverError.status = 500;
    const fetcher = vi.fn().mockRejectedValue(serverError);

    await expect(cachedRequest(cache, url, fetcher)).rejects.toThrow(
      "Internal Server Error",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("getHttpCache singleton", () => {
  it("returns the same instance across calls", () => {
    expect(getHttpCache()).toBe(getHttpCache());
  });
});

describe("withInflightDedup (#124)", () => {
  it("shares one computation between concurrent same-key callers", async () => {
    const cache = new HttpCache(tmpDir);
    let resolveFn: (v: string) => void;
    const fn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const a = withInflightDedup(cache, "stampede-key", fn);
    const b = withInflightDedup(cache, "stampede-key", fn);
    resolveFn!("shared");

    expect(await a).toBe("shared");
    expect(await b).toBe("shared");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejection to every waiter and clears the slot", async () => {
    const cache = new HttpCache(tmpDir);
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    const a = withInflightDedup(cache, "reject-key", fn);
    const b = withInflightDedup(cache, "reject-key", fn);
    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);

    // Slot cleared: the next call retries
    const ok = vi.fn().mockResolvedValue(42);
    await expect(withInflightDedup(cache, "reject-key", ok)).resolves.toBe(42);
  });

  it("cachedTimeBased dedups a concurrent same-key stampede", async () => {
    const cache = new HttpCache(tmpDir);
    let resolveFn: (v: { ok: boolean }) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveFn = resolve;
        }),
    );

    const a = cachedTimeBased(cache, "tb-stampede", 60_000, fetcher);
    const b = cachedTimeBased(cache, "tb-stampede", 60_000, fetcher);
    resolveFn!({ ok: true });

    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
