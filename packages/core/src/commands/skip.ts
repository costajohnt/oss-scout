/**
 * Skip command — manage the skip list for excluding issues from future searches.
 */

import { loadLocalState, saveLocalState } from "../core/local-state.js";
import type { SkippedIssue, ScoutState } from "../core/schemas.js";
import { OssScout } from "../scout.js";

/**
 * Skip an issue by URL — adds it to the skip list and removes it from saved results.
 * Tries to enrich metadata from saved results if available.
 */
export function runSkip(options: { issueUrl: string; state?: ScoutState }): {
  skipped: boolean;
  alreadySkipped: boolean;
} {
  const state = options.state ?? loadLocalState();
  const scout = new OssScout("", state);

  const alreadySkipped = scout
    .getSkippedIssues()
    .some((s) => s.url === options.issueUrl);
  if (alreadySkipped) {
    return { skipped: false, alreadySkipped: true };
  }

  // Try to enrich metadata from saved results
  const saved = scout
    .getSavedResults()
    .find((r) => r.issueUrl === options.issueUrl);
  const metadata = saved
    ? { repo: saved.repo, number: saved.number, title: saved.title }
    : parseIssueUrl(options.issueUrl);

  scout.skipIssue(options.issueUrl, metadata);
  saveLocalState(scout.getState() as ScoutState);
  return { skipped: true, alreadySkipped: false };
}

/**
 * List all skipped issues.
 */
export function runSkipList(options?: { state?: ScoutState }): SkippedIssue[] {
  const state = options?.state ?? loadLocalState();
  return state.skippedIssues ?? [];
}

/**
 * Clear all skipped issues.
 */
export function runSkipClear(): void {
  const state = loadLocalState();
  state.skippedIssues = [];
  saveLocalState(state);
}

/**
 * Remove a specific issue from the skip list (unskip).
 */
export function runSkipRemove(options: { issueUrl: string }): {
  removed: boolean;
} {
  const state = loadLocalState();
  const before = (state.skippedIssues ?? []).length;
  state.skippedIssues = (state.skippedIssues ?? []).filter(
    (s) => s.url !== options.issueUrl,
  );
  const removed = before !== state.skippedIssues.length;
  saveLocalState(state);
  return { removed };
}

/**
 * Parse a GitHub issue URL to extract repo and number.
 */
function parseIssueUrl(
  url: string,
): { repo: string; number: number; title: string } | undefined {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (!match) return undefined;
  return { repo: match[1], number: parseInt(match[2], 10), title: "" };
}
