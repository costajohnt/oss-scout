import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { HttpCache } from "./http-cache.js";

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
});
