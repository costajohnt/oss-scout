/**
 * Shared GitHub API client with rate limiting and throttling.
 */

import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { warn } from './logger.js';

const MODULE = 'github';

const ThrottledOctokit = Octokit.plugin(throttling);

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetAt: string;
}

let _octokit: Octokit | null = null;
let _currentToken: string | null = null;

function formatResetTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour12: false });
}

export function getRateLimitCallbacks() {
  return {
    onRateLimit: (retryAfter: number, options: unknown, _octokit: unknown, retryCount: number): boolean => {
      const opts = options as { method: string; url: string };
      const resetAt = new Date(Date.now() + retryAfter * 1000);
      if (retryCount < 2) {
        warn(MODULE, `Rate limit hit (retry ${retryCount + 1}/2, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`);
        return true;
      }
      warn(MODULE, `Rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`);
      return false;
    },
    onSecondaryRateLimit: (retryAfter: number, options: unknown, _octokit: unknown, retryCount: number): boolean => {
      const opts = options as { method: string; url: string };
      const resetAt = new Date(Date.now() + retryAfter * 1000);
      if (retryCount < 3) {
        warn(MODULE, `Secondary rate limit hit (retry ${retryCount + 1}/3, waiting ${retryAfter}s, resets at ${formatResetTime(resetAt)}) — ${opts.method} ${opts.url}`);
        return true;
      }
      warn(MODULE, `Secondary rate limit exceeded, not retrying — ${opts.method} ${opts.url} (resets at ${formatResetTime(resetAt)})`);
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
