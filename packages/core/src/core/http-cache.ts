/**
 * HTTP caching with ETags for GitHub API responses.
 *
 * Stores ETags and response bodies for cacheable GET endpoints in
 * `~/.oss-scout/cache/`. On subsequent requests, sends `If-None-Match`
 * headers — 304 responses don't count against GitHub rate limits.
 *
 * Also provides in-flight request deduplication so that concurrent calls
 * for the same endpoint (e.g., star counts for two PRs in the same repo)
 * share a single HTTP round-trip.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getCacheDir } from "./utils.js";
import { debug, warn } from "./logger.js";
import { errorMessage, getHttpStatusCode } from "./errors.js";

const MODULE = "http-cache";

/**
 * Schema version for cache entries whose body is an oss-scout-defined shape
 * (vetting results, search payloads, policy scans, merged-PR counts) rather
 * than a raw GitHub API response. These are deserialized with an unchecked
 * cast, so a shape change between releases would otherwise let a new build read
 * a stale-shaped entry. Bump this whenever one of those cached shapes changes:
 * old entries then miss the version-prefixed key and are refetched instead of
 * misread (#158). Raw ETag-keyed GitHub responses are not versioned — their
 * shape is owned by GitHub, not us.
 */
export const CACHE_SCHEMA_VERSION = "v1";

/**
 * Prefix a synthetic (non-URL) cache key with the schema version so a shape
 * change invalidates old entries. Use for every key whose body is read back
 * with an unchecked cast.
 */
export function versionedCacheKey(key: string): string {
  return `${CACHE_SCHEMA_VERSION}:${key}`;
}

/** Shape of a single cache entry on disk. */
export interface CacheEntry {
  etag: string;
  url: string;
  body: unknown;
  cachedAt: string;
}

/**
 * Maximum age (in ms) before a cache entry is considered stale and eligible for
 * eviction during cleanup. Defaults to 24 hours. Entries older than this are
 * still *usable* for conditional requests (the ETag may still be valid), but
 * `evictStale()` will remove them.
 */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * File-based HTTP cache backed by `~/.oss-scout/cache/`.
 *
 * Each cache entry is stored as a separate JSON file keyed by the SHA-256
 * hash of the request URL. This avoids filesystem issues with URL-based
 * filenames and keeps lookup O(1).
 */
export class HttpCache {
  private readonly cacheDir: string;

  /** In-flight request deduplication map: URL -> Promise<response>. */
  private readonly inflightRequests = new Map<string, Promise<unknown>>();

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? getCacheDir();
  }

  /** Derive a filesystem-safe cache key from a URL. */
  private keyFor(url: string): string {
    return crypto.createHash("sha256").update(url).digest("hex");
  }

  /** Full path to the cache file for a given URL. */
  private pathFor(url: string): string {
    return path.join(this.cacheDir, `${this.keyFor(url)}.json`);
  }

  /**
   * Return the cached body if the entry exists and is younger than `maxAgeMs`.
   * Useful for time-based caching where ETag validation isn't applicable
   * (e.g., caching aggregated results from paginated API calls).
   */
  getIfFresh(key: string, maxAgeMs: number): unknown | null {
    return this.getEntryIfFresh(key, maxAgeMs)?.body ?? null;
  }

  /**
   * Like {@link getIfFresh}, but returns the whole entry so callers can
   * distinguish "no fresh entry" (null) from a legitimately cached falsy
   * body (`0`, `""`, `false`, `null`).
   */
  getEntryIfFresh(key: string, maxAgeMs: number): CacheEntry | null {
    const entry = this.get(key);
    if (!entry) return null;
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return entry;
  }

  /**
   * Look up a cached response. Returns `null` if no cache entry exists.
   */
  get(url: string): CacheEntry | null {
    const filePath = this.pathFor(url);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(raw) as CacheEntry;
      // Sanity-check: the file should contain the URL we asked for
      if (entry.url !== url) {
        debug(MODULE, `Cache collision detected for ${url}, ignoring`);
        return null;
      }
      return entry;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return null;
      if (err instanceof SyntaxError) {
        debug(MODULE, `Corrupt cache entry, deleting: ${url}`);
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          debug(
            MODULE,
            `Failed to delete corrupt cache entry: ${errorMessage(unlinkErr)}`,
          );
        }
        return null;
      }
      warn(MODULE, `Cache read failed for ${url}: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Store a response with its ETag.
   */
  set(url: string, etag: string, body: unknown): void {
    const entry: CacheEntry = {
      etag,
      url,
      body,
      cachedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(this.pathFor(url), JSON.stringify(entry), {
        encoding: "utf-8",
        mode: 0o600,
      });
      debug(MODULE, `Cached response for ${url}`);
    } catch (err) {
      // Non-fatal: cache write failure should not break the request
      warn(MODULE, `Failed to write cache for ${url}: ${errorMessage(err)}`);
    }
  }

  /**
   * Get the in-flight promise for a URL (for deduplication).
   */
  getInflight(url: string): Promise<unknown> | undefined {
    return this.inflightRequests.get(url);
  }

  /**
   * Register an in-flight request for deduplication.
   * Returns a cleanup function to call when the request completes.
   */
  setInflight(url: string, promise: Promise<unknown>): () => void {
    this.inflightRequests.set(url, promise);
    return () => {
      this.inflightRequests.delete(url);
    };
  }

  /**
   * Remove stale entries older than `maxAgeMs` from the cache directory.
   * Intended to be called periodically (e.g., once per search invocation).
   */
  evictStale(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
    let evicted = 0;
    try {
      const files = fs.readdirSync(this.cacheDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(this.cacheDir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const entry = JSON.parse(raw) as CacheEntry;
          const age = now - new Date(entry.cachedAt).getTime();
          if (age > maxAgeMs) {
            fs.unlinkSync(filePath);
            evicted++;
          }
        } catch {
          debug(MODULE, `Removing unreadable cache entry ${file}`);
          try {
            fs.unlinkSync(filePath);
            evicted++;
          } catch (unlinkErr) {
            debug(
              MODULE,
              `Failed to remove stale cache entry ${file}: ${errorMessage(unlinkErr)}`,
            );
          }
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        warn(
          MODULE,
          `Failed to evict stale cache entries: ${errorMessage(err)}`,
        );
      }
    }
    if (evicted > 0) {
      debug(MODULE, `Evicted ${evicted} stale cache entries`);
    }
    return evicted;
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        fs.unlinkSync(path.join(this.cacheDir, file));
      }
      debug(MODULE, "Cache cleared");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        warn(MODULE, `Failed to clear cache: ${errorMessage(err)}`);
      }
    }
  }

  /**
   * Return the number of entries currently in the cache.
   */
  size(): number {
    try {
      return fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"))
        .length;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        debug(MODULE, `Failed to read cache size: ${errorMessage(err)}`);
      }
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _httpCache: HttpCache | null = null;

/**
 * Get (or create) the shared HttpCache singleton.
 * The singleton is lazily initialized on first access.
 */
export function getHttpCache(): HttpCache {
  if (!_httpCache) {
    _httpCache = new HttpCache();
  }
  return _httpCache;
}

// ---------------------------------------------------------------------------
// Octokit integration helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an Octokit `repos.get`-style call with ETag caching and request
 * deduplication.
 *
 * Usage:
 * ```ts
 * const data = await cachedRequest(cache, octokit, '/repos/owner/repo', () =>
 *   octokit.repos.get({ owner, repo: name }),
 * );
 * ```
 *
 * 1. If an identical request is already in-flight, returns the existing promise
 *    (request deduplication).
 * 2. If a cached ETag exists, sends `If-None-Match`. On 304, returns the
 *    cached body without consuming a rate-limit point.
 * 3. On a fresh 200, caches the ETag + body for next time.
 */
/**
 * Share one in-flight computation per key: concurrent callers for the same
 * key await the same promise instead of paying duplicate API calls (#124).
 * The check-then-register pair runs without an intervening await, so two
 * concurrent callers cannot both miss. Rejections propagate to every waiter
 * and are never cached.
 */
export async function withInflightDedup<T>(
  cache: HttpCache,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = cache.getInflight(key);
  if (existing) {
    debug(MODULE, `Dedup hit for ${key}`);
    return (await existing) as T;
  }
  const promise = fn();
  const cleanup = cache.setInflight(key, promise);
  try {
    return await promise;
  } finally {
    cleanup();
  }
}

export async function cachedRequest<T>(
  cache: HttpCache,
  url: string,
  fetcher: (
    headers: Record<string, string>,
  ) => Promise<{ data: T; headers?: Record<string, string> }>,
): Promise<T> {
  const doFetch = async (): Promise<T> => {
    const extraHeaders: Record<string, string> = {};
    const cached = cache.get(url);
    if (cached) {
      extraHeaders["if-none-match"] = cached.etag;
    }

    try {
      const response = await fetcher(extraHeaders);
      // Store ETag if present (headers may be absent in test mocks)
      const etag = response.headers?.["etag"];
      if (etag) {
        cache.set(url, etag, response.data);
      }
      return response.data;
    } catch (err: unknown) {
      // Check for 304 Not Modified — re-read cache to avoid stale closure snapshot
      if (isNotModifiedError(err)) {
        const freshCached = cache.get(url);
        if (freshCached) {
          debug(MODULE, `304 cache hit for ${url}`);
          return freshCached.body as T;
        }
        // The entry that supplied If-None-Match vanished mid-flight (e.g. a
        // concurrent process deleted it). Refetch unconditionally; without
        // the conditional header the server cannot answer 304 again.
        debug(MODULE, `304 but cache entry vanished for ${url}, refetching`);
        const response = await fetcher({});
        const etag = response.headers?.["etag"];
        if (etag) {
          cache.set(url, etag, response.data);
        }
        return response.data;
      }
      throw err;
    }
  };

  return withInflightDedup(cache, url, doFetch);
}

/**
 * Time-based cache wrapper (no ETag / conditional requests).
 *
 * If a cached result exists and is younger than `maxAgeMs`, returns it.
 * Otherwise calls `fetcher`, caches the result, and returns it.
 *
 * Use this for expensive operations whose results change slowly
 * (e.g. search queries, project health checks).
 */
export async function cachedTimeBased<T>(
  cache: HttpCache,
  key: string,
  maxAgeMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = cache.getEntryIfFresh(key, maxAgeMs);
  if (cached) {
    debug(MODULE, `Time-based cache hit for ${key}`);
    return cached.body as T;
  }

  // Concurrent same-key callers (parallel vetting hitting one repo) share
  // a single fetch instead of stampeding the API (#124)
  return withInflightDedup(cache, key, async () => {
    // Re-check inside the dedup window: a caller that finished while we
    // queued may have populated the cache
    const fresh = cache.getEntryIfFresh(key, maxAgeMs);
    if (fresh) {
      return fresh.body as T;
    }
    const result = await fetcher();
    cache.set(key, "", result);
    return result;
  });
}

/**
 * Detect whether an error is a 304 Not Modified response.
 * Octokit throws a RequestError with status 304 for conditional requests.
 */
function isNotModifiedError(err: unknown): boolean {
  return getHttpStatusCode(err) === 304;
}
