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
import { fetchRoadmapIssueRefs } from "./roadmap.js";

const MODULE = "feature-discovery";

/** Delay between per-repo issue lists, mirroring search-phases.INTER_QUERY_DELAY_MS. */
const INTER_REPO_DELAY_MS = 2000;

/** Minimum viability score for a feature candidate to surface — same as scout search. */
const MIN_VIABILITY_SCORE = 40;

/** Default minimum merged-PR count for a repo to qualify as an anchor. */
export const ANCHOR_THRESHOLD = 3;

/** Default quick-wins / bigger-bets split ratio (60/40). */
export const DEFAULT_SPLIT_RATIO = 0.6;

/**
 * Resolve anchor repos: those with mergedPRCount >= threshold (default 3),
 * sorted by mergedPRCount descending. ScoutState stores repoScores as a
 * Record<string, RepoScore>, so we read its values.
 *
 * @param threshold Override minimum merged-PR count (#98).
 */
export function resolveAnchorRepos(
  repoScores: Record<string, RepoScore>,
  threshold: number = ANCHOR_THRESHOLD,
): string[] {
  return Object.values(repoScores)
    .filter((rs) => rs.mergedPRCount >= threshold)
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
 * maintainer-commitment signals (milestone presence, label set, ROADMAP.md
 * membership). Roadmap membership (#95) is treated as an explicit
 * maintainer commitment and forces the bigger-bet horizon.
 */
export function classifyHorizon(input: {
  hasMilestone: boolean;
  labels: string[];
  isOnRoadmap?: boolean;
}): Horizon {
  if (input.hasMilestone || input.isOnRoadmap) return "bigger-bet";
  for (const label of input.labels) {
    if (BIGGER_BET_LABELS.has(label.toLowerCase())) return "bigger-bet";
  }
  return "quick-win";
}

/** A vetted issue candidate stamped with its horizon classification. */
export type FeatureCandidate = IssueCandidate & { horizon: Horizon };

/**
 * Split feature candidates into two buckets respecting a configurable
 * quick-wins / bigger-bets ratio (default 60/40). If either bucket is
 * short, redirect the deficit to the other bucket. Each bucket is
 * sorted by viabilityScore descending.
 *
 * @param ratio Fraction (0..1) of `count` to allocate to quick wins (#99).
 */
export function splitByHorizon(
  candidates: FeatureCandidate[],
  count: number,
  ratio: number = DEFAULT_SPLIT_RATIO,
): { quickWins: FeatureCandidate[]; biggerBets: FeatureCandidate[] } {
  const allQuick = candidates
    .filter((c) => c.horizon === "quick-win")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);
  const allBigger = candidates
    .filter((c) => c.horizon === "bigger-bet")
    .sort((a, b) => b.viabilityScore - a.viabilityScore);

  const targetQuick = Math.round(count * ratio);
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

/**
 * Labels that signal "the maintainer wants outside contributions". When any
 * is present, combined with no linked PR and an issue age >= 60 days, the
 * issue is treated as wontfix-no-contributor (#96).
 */
export const WONTFIX_NO_CONTRIBUTOR_LABELS = new Set([
  "help wanted",
  "contributions welcome",
  "up-for-grabs",
  "bounty",
  "pinned",
  "unmaintained",
]);

/** Minimum days an issue must be open to qualify as wontfix-no-contributor. */
export const WONTFIX_MIN_AGE_DAYS = 60;

/**
 * Pure detector for the "wontfix because no contributor stepped up" pattern (#96).
 *
 * True when:
 *   - issue carries any of WONTFIX_NO_CONTRIBUTOR_LABELS, AND
 *   - issue has been open at least `minAgeDays` days (default 60)
 *
 * The orchestrator already filters out assigned issues before reaching the
 * vetter. Linked-PR cases are deliberately not gated here: the existing
 * -30 viability penalty for `hasExistingPR` already discounts those, and
 * checking `hasLinkedPR` would require deferring scoring until after vet,
 * doubling the work for a marginally cleaner signal.
 */
export function detectWontfixNoContributor(input: {
  labels: string[];
  createdAt: string;
  now?: Date;
  minAgeDays?: number;
}): boolean {
  const matched = input.labels.some((l) =>
    WONTFIX_NO_CONTRIBUTOR_LABELS.has(l.toLowerCase()),
  );
  if (!matched) return false;
  const created = new Date(input.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const now = input.now ?? new Date();
  const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays >= (input.minAgeDays ?? WONTFIX_MIN_AGE_DAYS);
}

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
  /** Override default anchor threshold (3 merged PRs). */
  anchorThreshold?: number;
  /** Override default split ratio (0.6 = 60% quick wins, 40% bigger bets). */
  splitRatio?: number;
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
  created_at?: string;
  number?: number;
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
  const anchorRepos = resolveAnchorRepos(opts.repoScores, opts.anchorThreshold);
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
    // Issues list and roadmap fetch run in parallel — roadmap scraping (#95)
    // adds at most one extra GET per anchor repo and the result is reused
    // across every issue in this loop iteration.
    let response;
    let roadmapRefs: Set<number>;
    try {
      const [listResp, refs] = await Promise.all([
        opts.octokit.issues.listForRepo({
          owner,
          repo,
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 20,
        }),
        fetchRoadmapIssueRefs(opts.octokit, owner, repo),
      ]);
      response = listResp;
      roadmapRefs = refs;
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
      const wontfixNoContributor = item.created_at
        ? detectWontfixNoContributor({ labels, createdAt: item.created_at })
        : false;
      const onRoadmap =
        typeof item.number === "number" && roadmapRefs.has(item.number);
      let candidate;
      try {
        candidate = await opts.vetter.vetIssue(item.html_url, {
          featureSignals: {
            reactions,
            comments,
            hasMilestone,
            wontfixNoContributor,
            onRoadmap,
          },
        });
      } catch (err: unknown) {
        if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
        warn(MODULE, `vet failed for ${item.html_url}: ${errorMessage(err)}`);
        continue;
      }
      const horizon = classifyHorizon({
        hasMilestone,
        labels,
        isOnRoadmap: onRoadmap,
      });
      candidates.push({ ...candidate, horizon });
    }
  }

  // Drop low-viability results — same threshold as scout search.
  const passing = candidates.filter(
    (c) => c.viabilityScore >= MIN_VIABILITY_SCORE,
  );

  const split = splitByHorizon(passing, opts.count, opts.splitRatio);
  const total = split.quickWins.length + split.biggerBets.length;
  return {
    ...split,
    anchorRepos,
    message: total === 0 ? NO_RESULTS_MESSAGE : null,
  };
}

// ── Broad / cross-repo mode (#100) ──────────────────────────────────────

export const NO_BROAD_RESULTS_MESSAGE =
  "No open feature opportunities matched your filters. Try widening your language preferences in `scout config`.";

export interface DiscoverFeaturesBroadOptions {
  octokit: Octokit;
  vetter: IssueVetter;
  count: number;
  /** Languages from user preferences ("any" disables the filter). */
  languages?: string[];
  excludeRepos?: string[];
  excludeOrgs?: string[];
  /** Override default split ratio. */
  splitRatio?: number;
  /** Maximum search results to vet (default 30). */
  maxToVet?: number;
}

const DEFAULT_BROAD_MAX_TO_VET = 30;

/**
 * Build a GitHub Search query for cross-repo feature discovery.
 *
 * Exported separately from `discoverFeaturesBroad` so the query construction
 * is independently testable without mocking the Search API.
 */
export function buildBroadFeatureSearchQuery(opts: {
  languages?: string[];
  excludeRepos?: string[];
  excludeOrgs?: string[];
}): string {
  const parts: string[] = ["is:issue", "is:open", "no:assignee"];

  // Feature labels — any-of via parenthesized OR.
  const labelClause = FEATURE_LABELS.map((l) => `label:"${l}"`).join(" OR ");
  parts.push(`(${labelClause})`);

  // Exclude labels that overlap with `scout` territory.
  for (const excl of FEATURE_EXCLUSION_LABELS) {
    parts.push(`-label:"${excl}"`);
  }

  // Languages — skip the filter when "any" is the only preference, since
  // GitHub Search has no `language:any` operator.
  const languages = (opts.languages ?? []).filter(
    (l) => l && l.toLowerCase() !== "any",
  );
  if (languages.length > 0) {
    const langClause = languages.map((l) => `language:${l}`).join(" OR ");
    parts.push(`(${langClause})`);
  }

  // User exclusions.
  for (const repo of opts.excludeRepos ?? []) {
    parts.push(`-repo:${repo}`);
  }
  for (const org of opts.excludeOrgs ?? []) {
    parts.push(`-user:${org}`);
  }

  return parts.join(" ");
}

/**
 * Orchestrate broad / cross-repo feature discovery (#100). Bypasses anchor
 * resolution; runs a single GitHub Search API query for feature-labeled
 * open issues across the entire ecosystem, filtered by the user's language
 * preferences and excluded repos/orgs.
 *
 * Designed for first-touch contributors who haven't yet built repo
 * relationships and so wouldn't qualify under the default `scout features`
 * anchor-based path.
 *
 * Auth (401) and rate-limit errors propagate; per-issue vet failures
 * degrade gracefully.
 */
export async function discoverFeaturesBroad(
  opts: DiscoverFeaturesBroadOptions,
): Promise<FeatureSearchResult> {
  const query = buildBroadFeatureSearchQuery({
    languages: opts.languages,
    excludeRepos: opts.excludeRepos,
    excludeOrgs: opts.excludeOrgs,
  });
  const maxToVet = opts.maxToVet ?? DEFAULT_BROAD_MAX_TO_VET;

  let items: RawIssueItem[];
  try {
    const response = await opts.octokit.search.issuesAndPullRequests({
      q: query,
      sort: "interactions",
      order: "desc",
      per_page: maxToVet,
    });
    items = (response.data.items as RawIssueItem[]).filter(
      (it) => !it.pull_request && !it.assignee && isFeatureIssue(it),
    );
  } catch (err: unknown) {
    if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
    warn(MODULE, `broad feature search failed: ${errorMessage(err)}`);
    return {
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: NO_BROAD_RESULTS_MESSAGE,
    };
  }

  const candidates: FeatureCandidate[] = [];
  for (const item of items) {
    const labels = extractLabels(item);
    const hasMilestone = !!item.milestone;
    const reactions = item.reactions?.total_count ?? 0;
    const comments = item.comments ?? 0;
    const wontfixNoContributor = item.created_at
      ? detectWontfixNoContributor({ labels, createdAt: item.created_at })
      : false;
    let candidate;
    try {
      candidate = await opts.vetter.vetIssue(item.html_url, {
        featureSignals: {
          reactions,
          comments,
          hasMilestone,
          wontfixNoContributor,
          // Roadmap scraping is per-repo and would require an extra fetch
          // per unique repo in the broad result set — deliberately skipped
          // here to keep the broad path cheap. Anchor mode keeps the bonus.
        },
      });
    } catch (err: unknown) {
      if (getHttpStatusCode(err) === 401 || isRateLimitError(err)) throw err;
      warn(MODULE, `vet failed for ${item.html_url}: ${errorMessage(err)}`);
      continue;
    }
    const horizon = classifyHorizon({ hasMilestone, labels });
    candidates.push({ ...candidate, horizon });
  }

  const passing = candidates.filter(
    (c) => c.viabilityScore >= MIN_VIABILITY_SCORE,
  );
  const split = splitByHorizon(passing, opts.count, opts.splitRatio);
  const total = split.quickWins.length + split.biggerBets.length;
  return {
    ...split,
    anchorRepos: [],
    message: total === 0 ? NO_BROAD_RESULTS_MESSAGE : null,
  };
}
