/**
 * Skip command — manage the skip list for excluding issues from future searches.
 */

import { loadLocalState } from "../core/local-state.js";
import type { SkippedIssue, ScoutState } from "../core/schemas.js";
import { withScout, persistScout } from "./with-scout.js";
import {
  ISSUE_URL_PATTERN,
  validateGitHubUrl,
  validateUrl,
} from "./validation.js";

// Skip operations are local-only, so they don't require a GitHub token.
const SKIP_SCOUT_OPTIONS = { requireToken: false } as const;

/**
 * Skip an issue by URL — adds it to the skip list and removes it from saved results.
 * Tries to enrich metadata from saved results if available.
 */
export async function runSkip(options: {
  issueUrl: string;
  state?: ScoutState;
}): Promise<{
  skipped: boolean;
  alreadySkipped: boolean;
}> {
  // Validate up front: skip matching is exact-URL, so a junk or near-miss
  // URL (trailing slash, query string) would be stored but never exclude
  // anything — a silent no-op. Reject it with the expected format instead.
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, "issue");

  return withScout(
    options.state,
    async (scout) => {
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
      // Persist only on an actual change so an already-skipped no-op doesn't
      // trigger a needless gist push.
      await persistScout(scout);
      return { skipped: true, alreadySkipped: false };
    },
    SKIP_SCOUT_OPTIONS,
  );
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
export async function runSkipClear(): Promise<void> {
  await withScout(
    undefined,
    (scout) => {
      scout.clearSkippedIssues();
    },
    { ...SKIP_SCOUT_OPTIONS, persist: true },
  );
}

/**
 * Remove a specific issue from the skip list (unskip).
 *
 * Deliberately does NOT validate the URL: entries stored before skip-add
 * validation existed may be junk, and exact-match removal is the only way
 * to clean them up short of `skip clear`.
 */
export async function runSkipRemove(options: { issueUrl: string }): Promise<{
  removed: boolean;
}> {
  return withScout(
    undefined,
    async (scout) => {
      const before = scout.getSkippedIssues().length;
      scout.unskipIssue(options.issueUrl);
      const removed = before !== scout.getSkippedIssues().length;
      await persistScout(scout);
      return { removed };
    },
    SKIP_SCOUT_OPTIONS,
  );
}

/**
 * Parse a GitHub issue URL to extract repo and number.
 */
function parseIssueUrl(
  url: string,
): { repo: string; number: number; title: string } | undefined {
  const match = url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/,
  );
  if (!match) return undefined;
  return { repo: match[1], number: parseInt(match[2], 10), title: "" };
}
