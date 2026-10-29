/**
 * Shared GitHub API client with rate limiting and throttling.
 */

import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import * as fs from "fs";
import * as path from "path";
import { warn } from "./logger.js";
import { getDataDir } from "./utils.js";

const MODULE = "github";

/**
 * Per-process GitHub API usage, appended as one JSON line to
 * ~/.oss-scout/runs.jsonl on exit so rate-limit pain can be measured over time.
 * Buckets come from the x-ratelimit-resource header (core / search / graphql).
 * ponytail: written on process exit, so a long-lived MCP server logs one line
 * per server lifetime; add per-call flushes if that host matters.
 */
const usage = {
  start: Date.now(),
  calls: {} as Record<string, number>,
  minRemaining: {} as Record<string, number>,
  errorsByStatus: {} as Record<string, number>,
  rateLimited: 0,
  secondaryRateLimited: 0,
};

function recordResponse(headers: Record<string, unknown> | undefined): void {
  const resource = String(headers?.["x-ratelimit-resource"] ?? "unknown");
  usage.calls[resource] = (usage.calls[resource] ?? 0) + 1;
  const remaining = Number(headers?.["x-ratelimit-remaining"]);
  if (Number.isFinite(remaining)) {
    usage.minRemaining[resource] = Math.min(
      usage.minRemaining[resource] ?? Infinity,
      remaining,
    );
  }
}

export function getUsage() {
  const { start, ...rest } = usage;
  return { ...rest, durationMs: Date.now() - start };
}

function writeRunLog(): void {
  if (process.env.VITEST) return;
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      host: path.basename(process.argv[1] ?? ""),
      args: process.argv
        .slice(2)
        .map((a) => (/gh[pousr]_|github_pat_/.test(a) ? "[redacted]" : a)),
      exitCode: process.exitCode ?? 0,
      ...getUsage(),
    });
    fs.appendFileSync(path.join(getDataDir(), "runs.jsonl"), line + "\n");
  } catch {
    // Telemetry must never break the CLI.
  }
}

const ThrottledOctokit = Octokit.plugin(throttling, retry);

interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string;
}

let _octokit: Octokit | null = null;
let _currentToken: string | null = null;

function formatResetTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour12: false });
}

export function getRateLimitCallbacks() {
  return {
    onRateLimit: (
      retryAfter: number,
      options: unknown,
      _octokit: unknown,
      retryCount: number,
    ): boolean => {
      const opts = options as { method: string; url: string };
      const resetAt = new Date(Date.now() + retryAfter * 1000);
      usage.rateLimited++;
      if (retryCount < 2) {
        warn(
          MODULE,
          `Rate limit hit (retry ${retryCount + 1}/2, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`,
        );
        return true;
      }
      warn(
        MODULE,
        `Rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`,
      );
      return false;
    },
    onSecondaryRateLimit: (
      retryAfter: number,
      options: unknown,
      _octokit: unknown,
      retryCount: number,
    ): boolean => {
      const opts = options as { method: string; url: string };
      const resetAt = new Date(Date.now() + retryAfter * 1000);
      usage.secondaryRateLimited++;
      if (retryCount < 3) {
        warn(
          MODULE,
          `Secondary rate limit hit (retry ${retryCount + 1}/3, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`,
        );
        return true;
      }
      warn(
        MODULE,
        `Secondary rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`,
      );
      return false;
    },
  };
}

export function getOctokit(token: string): Octokit {
  if (_octokit && _currentToken === token) return _octokit;

  const callbacks = getRateLimitCallbacks();
  _octokit = new ThrottledOctokit({
    auth: token,
    throttle: callbacks,
  });
  // Wrapped after the plugins, so this counts logical requests, not retries.
  _octokit.hook?.wrap("request", async (request, options) => {
    try {
      const res = await request(options);
      recordResponse(res.headers);
      return res;
    } catch (err) {
      const e = err as {
        status?: number;
        response?: { headers?: Record<string, unknown> };
      };
      recordResponse(e.response?.headers);
      // 304 = ETag cache hit, 404 = file-probe miss; both expected.
      const status = String(e.status ?? "network");
      usage.errorsByStatus[status] = (usage.errorsByStatus[status] ?? 0) + 1;
      throw err;
    }
  });
  if (!_currentToken) process.once("exit", writeRunLog);

  _currentToken = token;
  return _octokit;
}

export async function checkRateLimit(token: string): Promise<RateLimitInfo> {
  const octokit = getOctokit(token);
  const { data } = await octokit.rateLimit.get();
  const search = data.resources.search;
  return {
    remaining: search.remaining,
    limit: search.limit,
    resetAt: new Date(search.reset * 1000).toISOString(),
  };
}
