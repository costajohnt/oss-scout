/**
 * Skip command — manage the skip list for excluding issues from future searches.
 */

import { loadLocalState, saveLocalState } from "../core/local-state.js";
import type { SkippedIssue, ScoutState } from "../core/schemas.js";
import { getGitHubToken } from "../core/utils.js";
import { buildCommandScout } from "./command-scout.js";
import {
  ISSUE_URL_PATTERN,
  validateGitHubUrl,
  validateUrl,
} from "./validation.js";

/**
 * Build a scout for skip operations, honoring the persistence preference.
 * The old helper had two identical branches and hardcoded provided mode.
 */
function createSkipScout(state: ScoutState) {
  return buildCommandScout(state, getGitHubToken() ?? "");
}

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

  const state = options.state ?? loadLocalState();
  const scout = await createSkipScout(state);

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
  await scout.checkpoint();
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
export async function runSkipClear(): Promise<void> {
  const state = loadLocalState();
  const scout = await createSkipScout(state);
  scout.clearSkippedIssues();
  saveLocalState(scout.getState() as ScoutState);
  await scout.checkpoint();
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
  const state = loadLocalState();
  const scout = await createSkipScout(state);
  const before = scout.getSkippedIssues().length;
  scout.unskipIssue(options.issueUrl);
  const removed = before !== scout.getSkippedIssues().length;
  saveLocalState(scout.getState() as ScoutState);
  await scout.checkpoint();
  return { removed };
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
