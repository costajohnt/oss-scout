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

import type { Octokit } from "@octokit/rest";
import type { RepoScore, Horizon } from "./schemas.js";
import type { IssueCandidate } from "./types.js";
import type { IssueVetter } from "./issue-vetting.js";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";
import { sleep } from "./utils.js";

const MODULE = "feature-discovery";

/** Delay between per-repo issue lists, mirroring search-phases.INTER_QUERY_DELAY_MS. */
const INTER_REPO_DELAY_MS = 2000;

/** Minimum viability score for a feature candidate to surface — same as scout search. */
const MIN_VIABILITY_SCORE = 40;

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

/** A vetted issue candidate stamped with its horizon classification. */
export type FeatureCandidate = IssueCandidate & { horizon: Horizon };

/**
 * Split feature candidates into two buckets respecting a 60/40 target.
 * If either bucket is short, redirect the deficit to the other bucket.
 * Each bucket is sorted by viabilityScore descending.
 */
export function splitByHorizon(
  candidates: FeatureCandidate[],
  count: number,
): { quickWins: FeatureCandidate[]; biggerBets: FeatureCandidate[] } {
  const allQuick = candidates
    .filter((c) => c.horizon === "quick-win")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);
  const allBigger = candidates
    .filter((c) => c.horizon === "bigger-bet")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);

  const targetQuick = Math.round(count * 0.6);
  const targetBigger = count - targetQuick;

  const quickTaken = Math.min(allQuick.length, targetQuick);
  const biggerTaken = Math.min(allBigger.length, targetBigger);

  // Redirect deficits.
  let quickFinal = quickTaken;
  let biggerFinal = biggerTaken;
  const quickDeficit = targetQuick - quickTaken;
  const biggerDeficit = targetBigger - biggerTaken;
  if (quickDeficit > 0) {
    biggerFinal = Math.min(allBigger.length, biggerFinal + quickDeficit);
  }
  if (biggerDeficit > 0) {
    quickFinal = Math.min(allQuick.length, quickFinal + biggerDeficit);
  }

  return {
    quickWins: allQuick.slice(0, quickFinal),
    biggerBets: allBigger.slice(0, biggerFinal),
  };
}

/** Feature labels used to filter issues. Any-of match. */
export const FEATURE_LABELS = [
  "enhancement",
  "feature",
  "feature-request",
  "proposal",
  "roadmap",
  "accepted-rfc",
] as const;

/** Labels excluded from feature-mode results (overlap with `scout` territory). */
export const FEATURE_EXCLUSION_LABELS = new Set([
  "good first issue",
  "bug",
  "documentation",
]);

export const NO_ANCHORS_MESSAGE =
  "No anchor repos yet (need 3+ merged PRs in a repo). Try `scout search` to build relationships first.";

export const NO_RESULTS_MESSAGE =
  "No open feature opportunities in your anchor repos right now. Check back next week, or try `scout search` for fix-mode work.";

export interface FeatureSearchResult {
  quickWins: FeatureCandidate[];
  biggerBets: FeatureCandidate[];
  anchorRepos: string[];
  message: string | null;
}

export interface DiscoverFeaturesOptions {
  octokit: Octokit;
  vetter: IssueVetter;
  repoScores: Record<string, RepoScore>;
  count: number;
}

interface RawIssueItem {
  html_url: string;
  title?: string;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  reactions?: { total_count?: number } | null;
  milestone?: { number?: number } | null;
  pull_request?: unknown;
  assignee?: unknown;
}

function extractLabels(item: RawIssueItem): string[] {
  if (!Array.isArray(item.labels)) return [];
  return item.labels
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((s): s is string => typeof s === "string");
}

function isFeatureIssue(item: RawIssueItem): boolean {
  const labels = extractLabels(item).map((l) => l.toLowerCase());
  if (labels.length === 0) return false;
  if (labels.some((l) => FEATURE_EXCLUSION_LABELS.has(l))) return false;
  return labels.some((l) => (FEATURE_LABELS as readonly string[]).includes(l));
}

/**
 * Orchestrate `scout features`: anchor resolution → per-repo issue listing
 * → feature-signal extraction → vetting → horizon classification → bucket split.
 *
 * Returns separate "quick wins" and "bigger bets" buckets per the 60/40 target,
 * with a human-friendly message when no anchors qualify or no candidates pass
 * the viability threshold.
 *
 * Auth (401) and rate-limit errors propagate. Per-repo and per-issue failures
 * degrade gracefully via `warn`.
 */
export async function discoverFeatures(
  opts: DiscoverFeaturesOptions,
): Promise<FeatureSearchResult> {
  const anchorRepos = resolveAnchorRepos(opts.repoScores);
  if (anchorRepos.length === 0) {
    return {
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: NO_ANCHORS_MESSAGE,
    };
  }

  const candidates: FeatureCandidate[] = [];

  for (let i = 0; i < anchorRepos.length; i++) {
    if (i > 0) await sleep(INTER_REPO_DELAY_MS);
    const [owner, repo] = anchorRepos[i].split("/");
    let response;
    try {
      response = await opts.octokit.issues.listForRepo({
        owner,
        repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: 20,
      });
    } catch (err: unknown) {
      if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
      warn(
        MODULE,
        `failed to list issues for ${anchorRepos[i]}: ${errorMessage(err)}`,
      );
      continue;
    }

    const items = (response.data as RawIssueItem[]).filter(
      (it) => !it.pull_request && !it.assignee && isFeatureIssue(it),
    );

    for (const item of items) {
      const labels = extractLabels(item);
      const hasMilestone = !!item.milestone;
      const reactions = item.reactions?.total_count ?? 0;
      const comments = item.comments ?? 0;
      let candidate;
      try {
        candidate = await opts.vetter.vetIssue(item.html_url, {
          featureSignals: { reactions, comments, hasMilestone },
        });
      } catch (err: unknown) {
        if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
        warn(MODULE, `vet failed for ${item.html_url}: ${errorMessage(err)}`);
        continue;
      }
      const horizon = classifyHorizon({ hasMilestone, labels });
      candidates.push({ ...candidate, horizon });
    }
  }

  // Drop low-viability results — same threshold as scout search.
  const passing = candidates.filter(
    (c) => c.viabilityScore >= MIN_VIABILITY_SCORE,
  );

  const split = splitByHorizon(passing, opts.count);
  const total = split.quickWins.length + split.biggerBets.length;
  return {
    ...split,
    anchorRepos,
    message: total === 0 ? NO_RESULTS_MESSAGE : null,
  };
}
