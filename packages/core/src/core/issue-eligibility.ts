/**
 * Issue Eligibility — checks whether an individual issue is claimable:
 * existing PR detection, claim-phrase scanning, user merge history,
 * and requirement clarity analysis.
 *
 * Extracted from issue-vetting.ts to isolate eligibility logic.
 */

import { Octokit } from "@octokit/rest";
import { paginateAll } from "./pagination.js";
import { errorMessage, getHttpStatusCode, isRateLimitError } from "./errors.js";
import { warn } from "./logger.js";
import { getHttpCache } from "./http-cache.js";
import { getSearchBudgetTracker } from "./search-budget.js";
import type { CheckResult, LinkedPR } from "./types.js";

/** Result of the existing-PR check, including metadata for the first linked PR (if any). */
export interface ExistingPRCheckResult extends CheckResult {
  linkedPR: LinkedPR | null;
}

/** Shape of a cross-referenced PR event from the GitHub issue timeline API. */
type CrossRefEvent = {
  event?: string;
  source?: {
    issue?: {
      number?: number;
      state?: string;
      html_url?: string;
      user?: { login?: string };
      pull_request?: { merged_at?: string | null };
    };
  };
};

function isLinkedPREvent(e: CrossRefEvent): boolean {
  return e.event === "cross-referenced" && !!e.source?.issue?.pull_request;
}

/**
 * Build a LinkedPR from a cross-referenced timeline event's source.issue.
 * Returns null if required fields are missing — and warns, because callers
 * only invoke this after asserting the event is a linked-PR event, so a
 * null return signals API shape drift, not absent data.
 */
function buildLinkedPRFromTimelineEvent(
  e: CrossRefEvent,
  context: { owner: string; repo: string; issueNumber: number },
): LinkedPR | null {
  const issue = e.source?.issue;
  const ctx = `${context.owner}/${context.repo}#${context.issueNumber}`;
  if (!issue || typeof issue.number !== "number") {
    warn(
      MODULE,
      `Cross-referenced timeline event for ${ctx} missing source.issue.number — possible API shape drift`,
    );
    return null;
  }
  const author = issue.user?.login;
  if (!author) {
    warn(
      MODULE,
      `Cross-referenced PR #${issue.number} for ${ctx} has no user.login (deleted user?) — skipping linkedPR metadata`,
    );
    return null;
  }
  const url = issue.html_url;
  if (!url) {
    warn(
      MODULE,
      `Cross-referenced PR #${issue.number} for ${ctx} missing html_url — skipping linkedPR metadata`,
    );
    return null;
  }
  return {
    number: issue.number,
    author,
    state: issue.state === "closed" ? "closed" : "open",
    merged: !!issue.pull_request?.merged_at,
    url,
  };
}

const MODULE = "issue-eligibility";

/** Phrases that indicate someone has already claimed an issue. */
const CLAIM_PHRASES = [
  "i'm working on this",
  "i am working on this",
  "i'll take this",
  "i will take this",
  "working on it",
  "i'd like to work on",
  "i would like to work on",
  "can i work on",
  "may i work on",
  "assigned to me",
  "i'm on it",
  "i'll submit a pr",
  "i will submit a pr",
  "working on a fix",
  "working on a pr",
] as const;

/**
 * Check whether an open PR already exists for the given issue.
 * Uses the timeline API (REST) to detect cross-referenced PRs, avoiding
 * the Search API's strict 30 req/min rate limit.
 */
export async function checkNoExistingPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<ExistingPRCheckResult> {
  try {
    // Use the timeline API (REST, not Search) to detect linked PRs.
    // This avoids consuming GitHub Search API quota (30 req/min limit).
    // Timeline captures formally linked PRs via cross-referenced events
    // but may miss PRs that only mention the issue number without a formal
    // link — an acceptable trade-off since most PRs use "Fixes #N" syntax.
    const timeline = await paginateAll((page) =>
      octokit.issues.listEventsForTimeline({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      }),
    );

    // Single pass: count linked-PR events and capture metadata for the
    // first valid one, so consumers can classify (own vs. competing,
    // open vs. closed-unmerged) without a separate fetch.
    let linkedPRCount = 0;
    let linkedPR: LinkedPR | null = null;
    for (const event of timeline) {
      const e = event as CrossRefEvent;
      if (!isLinkedPREvent(e)) continue;
      linkedPRCount++;
      linkedPR ??= buildLinkedPRFromTimelineEvent(e, {
        owner,
        repo,
        issueNumber,
      });
    }

    return { passed: linkedPRCount === 0, linkedPR };
  } catch (error) {
    if (getHttpStatusCode(error) === 401 || isRateLimitError(error)) {
      throw error;
    }
    const errMsg = errorMessage(error);
    warn(
      MODULE,
      `Failed to check for existing PRs on ${owner}/${repo}#${issueNumber}: ${errMsg}. Assuming no existing PR.`,
    );
    return { passed: true, inconclusive: true, reason: errMsg, linkedPR: null };
  }
}

/** TTL for cached merged-PR counts per repo (15 minutes). */
const MERGED_PR_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Check how many merged PRs the authenticated user has in a repo.
 * Uses GitHub Search API. Returns 0 on error (non-fatal).
 * Results are cached per-repo for 15 minutes to avoid redundant Search API
 * calls when multiple issues from the same repo are vetted.
 */
export async function checkUserMergedPRsInRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<number> {
  const cache = getHttpCache();
  const cacheKey = `merged-prs:${owner}/${repo}`;

  // Manual cache check — do not use cachedTimeBased because we must NOT cache
  // error-path fallback values (a transient failure returning 0 would poison the
  // cache for 15 minutes, hiding that the user has merged PRs in the repo).
  const cached = cache.getIfFresh(cacheKey, MERGED_PR_CACHE_TTL_MS);
  if (cached != null && typeof cached === "number") {
    return cached;
  }

  try {
    const tracker = getSearchBudgetTracker();
    await tracker.waitForBudget();
    try {
      // Use @me to search as the authenticated user
      const { data } = await octokit.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:merged author:@me`,
        per_page: 1, // We only need total_count
      });
      // Only cache successful results
      cache.set(cacheKey, "", data.total_count);
      return data.total_count;
    } finally {
      // Always record the call — failed requests still consume GitHub rate limit points
      tracker.recordCall();
    }
  } catch (error) {
    if (getHttpStatusCode(error) === 401 || isRateLimitError(error)) {
      throw error;
    }
    const errMsg = errorMessage(error);
    warn(
      MODULE,
      `Could not check merged PRs in ${owner}/${repo}: ${errMsg}. Defaulting to 0.`,
    );
    return 0; // Not cached — next call will retry
  }
}

/**
 * Check whether an issue has been claimed by another contributor
 * by scanning recent comments for claim phrases.
 */
export async function checkNotClaimed(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentCount: number,
): Promise<CheckResult> {
  if (commentCount === 0) return { passed: true };

  try {
    // Paginate through all comments
    const comments = await octokit.paginate(
      octokit.issues.listComments,
      {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      },
      (response) => response.data,
    );

    // Limit to last 100 comments to avoid excessive processing
    const recentComments = comments.slice(-100);

    for (const comment of recentComments) {
      const body = (comment.body || "").toLowerCase();
      if (CLAIM_PHRASES.some((phrase) => body.includes(phrase))) {
        return { passed: false };
      }
    }

    return { passed: true };
  } catch (error) {
    if (getHttpStatusCode(error) === 401 || isRateLimitError(error)) {
      throw error;
    }
    const errMsg = errorMessage(error);
    warn(
      MODULE,
      `Failed to check claim status on ${owner}/${repo}#${issueNumber}: ${errMsg}. Assuming not claimed.`,
    );
    return { passed: true, inconclusive: true, reason: errMsg };
  }
}

/**
 * Analyze whether an issue body has clear, actionable requirements.
 * Returns true when at least two "clarity indicators" are present:
 * numbered/bulleted steps, code blocks, expected-behavior keywords, length > 200.
 */
export function analyzeRequirements(body: string): boolean {
  if (!body || body.length < 50) return false;

  // Check for clear structure
  const hasSteps = /\d\.|[-*]\s/.test(body);
  const hasCodeBlock = /```/.test(body);
  const hasExpectedBehavior = /expect|should|must|want/i.test(body);

  // Must have at least two indicators of clarity
  const indicators = [
    hasSteps,
    hasCodeBlock,
    hasExpectedBehavior,
    body.length > 200,
  ];
  return indicators.filter(Boolean).length >= 2;
}
