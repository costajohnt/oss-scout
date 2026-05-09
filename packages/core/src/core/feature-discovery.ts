/**
 * Feature Discovery — orchestrates `scout features` mode: surfaces
 * feature-scoped contribution opportunities in repos where the user has
 * 3+ merged PRs, ranked into separate "quick wins" and "bigger bets" buckets.
 *
 * Reuses existing infrastructure:
 * - issue-vetting.ts    — per-issue vetting + scoring (with featureSignals)
 * - issue-scoring.ts    — viability score (existing weights + feature bonuses)
 * - http-cache.ts       — response cache
 * - errors.ts           — auth/rate-limit propagation
 *
 * No state singletons — anchor repos are resolved from RepoScore[] passed in.
 */

import type { RepoScore, Horizon } from "./schemas.js";

/** Minimum merged-PR count for a repo to qualify as an anchor. */
export const ANCHOR_THRESHOLD = 3;

/**
 * Resolve anchor repos: those with mergedPRCount >= ANCHOR_THRESHOLD,
 * sorted by mergedPRCount descending. ScoutState stores repoScores as a
 * Record<string, RepoScore>, so we read its values.
 */
export function resolveAnchorRepos(
  repoScores: Record<string, RepoScore>,
): string[] {
  return Object.values(repoScores)
    .filter((rs) => rs.mergedPRCount >= ANCHOR_THRESHOLD)
    .sort((a, b) => b.mergedPRCount - a.mergedPRCount)
    .map((rs) => rs.repo);
}

/** Labels that promote an issue to the "bigger-bet" bucket. */
export const BIGGER_BET_LABELS = new Set([
  "roadmap",
  "accepted-rfc",
  "proposal",
]);

/**
 * Classify an issue into "quick-win" or "bigger-bet" based on
 * maintainer-commitment signals (milestone presence + label set).
 */
export function classifyHorizon(input: {
  hasMilestone: boolean;
  labels: string[];
}): Horizon {
  if (input.hasMilestone) return "bigger-bet";
  for (const label of input.labels) {
    if (BIGGER_BET_LABELS.has(label.toLowerCase())) return "bigger-bet";
  }
  return "quick-win";
}
