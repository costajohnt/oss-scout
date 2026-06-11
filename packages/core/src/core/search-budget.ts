/**
 * Search Budget Tracker — centralized rate limit management for GitHub Search API.
 *
 * The GitHub Search API enforces a strict 30 requests/minute limit for
 * authenticated users. This module tracks actual consumption via a sliding
 * window and provides adaptive delays to stay within budget.
 *
 * Usage:
 * - Initialize once per search run with pre-flight rate limit data
 * - Call recordCall() after every Search API call
 * - Call waitForBudget() before making a Search API call to pace requests
 * - Call canAfford(n) to check if n more calls fit in the remaining budget
 */

import { debug } from "./logger.js";
import { sleep } from "./utils.js";

const MODULE = "search-budget";

/** GitHub Search API rate limit: 30 requests per 60-second rolling window. */
const SEARCH_RATE_LIMIT = 30;
const SEARCH_WINDOW_MS = 60 * 1000;

/** Safety margin: reserve a few calls for retries and cross-process usage. */
const SAFETY_MARGIN = 4;

/** Effective budget per window after safety margin. */
const EFFECTIVE_BUDGET = SEARCH_RATE_LIMIT - SAFETY_MARGIN;

export class SearchBudgetTracker {
  /** Timestamps of recent Search API calls within the sliding window. */
  private callTimestamps: number[] = [];

  /** Last known remaining quota from GitHub's rate limit endpoint. */
  private knownRemaining: number = SEARCH_RATE_LIMIT;

  /** Epoch ms when the rate limit window resets (from GitHub API). */
  private resetAt: number = 0;

  /** Total calls recorded since init (for diagnostics). */
  private totalCalls: number = 0;

  /** Calls made since the last known quota reset (external accounting). */
  private callsSinceReset: number = 0;

  /**
   * Initialize with pre-flight rate limit data from GitHub.
   */
  init(remaining: number, resetAt: string): void {
    this.knownRemaining = remaining;
    this.resetAt = new Date(resetAt).getTime();
    this.callTimestamps = [];
    this.totalCalls = 0;
    this.callsSinceReset = 0;
    debug(
      MODULE,
      `Initialized: ${remaining} remaining, resets at ${new Date(this.resetAt).toLocaleTimeString()}`,
    );
  }

  /**
   * Record that a Search API call was just made.
   */
  recordCall(): void {
    this.callTimestamps.push(Date.now());
    this.totalCalls++;
    this.callsSinceReset++;
    this.pruneOldTimestamps();
  }

  /**
   * Replenish the external budget once GitHub's quota window has reset.
   * Without this, the pre-flight remaining acted as a never-replenishing
   * run-lifetime total, throttling long multi-phase runs to ~1 call/min
   * even though GitHub fully resets every 60 seconds (#119).
   */
  private refreshExternalBudget(): void {
    if (this.resetAt <= 0) return;
    const now = Date.now();
    if (now < this.resetAt) return;
    this.knownRemaining = SEARCH_RATE_LIMIT;
    this.callsSinceReset = 0;
    while (this.resetAt <= now) {
      this.resetAt += SEARCH_WINDOW_MS;
    }
    debug(MODULE, "Quota window reset; external search budget replenished");
  }

  /**
   * Remove timestamps older than the sliding window.
   */
  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - SEARCH_WINDOW_MS;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0] < cutoff) {
      this.callTimestamps.shift();
    }
  }

  /**
   * Get the number of calls made in the current sliding window.
   */
  getCallsInWindow(): number {
    this.pruneOldTimestamps();
    return this.callTimestamps.length;
  }

  /**
   * Get the effective budget, accounting for both the sliding window limit
   * and the pre-flight remaining quota from GitHub.
   */
  private getEffectiveBudget(): number {
    this.refreshExternalBudget();
    // Use the stricter of: local window limit vs. known remaining quota
    // minus calls made since the last reset
    const localBudget = EFFECTIVE_BUDGET - this.callTimestamps.length;
    const externalBudget = this.knownRemaining - this.callsSinceReset;
    return Math.max(0, Math.min(localBudget, externalBudget));
  }

  /**
   * Check if we can afford N more Search API calls without exceeding the budget.
   */
  canAfford(n: number): boolean {
    this.pruneOldTimestamps();
    return this.getEffectiveBudget() >= n;
  }

  /**
   * Wait if necessary to stay within the Search API rate limit.
   * If the sliding window is at capacity, sleeps until the oldest
   * call ages out of the window.
   */
  async waitForBudget(): Promise<void> {
    // Loop to handle edge cases where a single sleep isn't enough
    // (e.g., concurrent callers, clock skew, or external budget depletion)
    while (true) {
      this.pruneOldTimestamps();

      if (this.getEffectiveBudget() > 0) {
        return; // Budget available, no wait needed
      }

      // Wait until the oldest call in the window ages out
      const oldestInWindow = this.callTimestamps[0];
      if (!oldestInWindow) {
        // No calls in window — the external quota is exhausted. Wait for
        // GitHub's reset when we know it, otherwise proceed (#119).
        const untilReset = this.resetAt - Date.now();
        if (this.resetAt > 0 && untilReset > 0) {
          debug(
            MODULE,
            `External quota exhausted, waiting ${untilReset}ms for reset`,
          );
          await sleep(untilReset + 100);
          continue;
        }
        return;
      }
      const waitUntil = oldestInWindow + SEARCH_WINDOW_MS;
      const waitMs = waitUntil - Date.now();

      if (waitMs > 0) {
        debug(
          MODULE,
          `Budget full (${this.callTimestamps.length}/${EFFECTIVE_BUDGET} in window), waiting ${waitMs}ms`,
        );
        await sleep(waitMs + 100); // +100ms safety buffer
      }
    }
  }

  /**
   * Get total calls recorded since init (for diagnostics).
   */
  getTotalCalls(): number {
    return this.totalCalls;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _tracker: SearchBudgetTracker | null = null;

/**
 * Get (or create) the shared SearchBudgetTracker singleton.
 */
export function getSearchBudgetTracker(): SearchBudgetTracker {
  if (!_tracker) {
    _tracker = new SearchBudgetTracker();
  }
  return _tracker;
}
