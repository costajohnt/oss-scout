/**
 * Helpers for reasoning about linked PRs surfaced via the issue timeline.
 *
 * Currently scoped to detecting "stalled" PRs — open PRs that have not been
 * updated in the last `STALLED_PR_THRESHOLD_DAYS` days. Stalled linked PRs
 * are surfaced as revive opportunities (#97). Note: this module does NOT
 * change scoring; the existing -30 penalty on issues with linked PRs is
 * preserved. This is annotation-only.
 */

import type { LinkedPR } from "./schemas.js";

/** Days of inactivity that classify a linked PR as "stalled". */
export const STALLED_PR_THRESHOLD_DAYS = 30;

/**
 * Determine whether a linked PR is stalled (open + not updated in the
 * last STALLED_PR_THRESHOLD_DAYS days). Returns false when the PR is
 * closed/merged, when updatedAt is missing, or when the threshold isn't met.
 */
export function isLinkedPRStalled(
  linkedPR: LinkedPR | null | undefined,
  now: Date = new Date(),
  thresholdDays: number = STALLED_PR_THRESHOLD_DAYS,
): boolean {
  if (!linkedPR || linkedPR.state !== "open" || !linkedPR.updatedAt)
    return false;
  const updated = new Date(linkedPR.updatedAt);
  if (Number.isNaN(updated.getTime())) return false;
  const ageDays = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= thresholdDays;
}
