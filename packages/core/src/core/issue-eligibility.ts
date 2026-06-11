/**
 * Issue Eligibility — checks whether an individual issue is claimable:
 * existing PR detection, claim-phrase scanning, user merge history,
 * and requirement clarity analysis.
 *
 * Extracted from issue-vetting.ts to isolate eligibility logic.
 */

import { Octokit } from "@octokit/rest";
import { paginateAll } from "./pagination.js";
import { errorMessage, rethrowIfFatal } from "./errors.js";
import { warn } from "./logger.js";
import {
  getHttpCache,
  withInflightDedup,
  versionedCacheKey,
} from "./http-cache.js";
import { getSearchBudgetTracker } from "./search-budget.js";
import type { CheckResult, LinkedPR } from "./types.js";

/**
 * Result of the existing-PR check, including metadata for the first linked PR
 * (if any). An intersection (not `extends`) because CheckResult is now a
 * discriminated union (#158); the `& { linkedPR }` distributes over both arms.
 */
export type ExistingPRCheckResult = CheckResult & {
  linkedPR: LinkedPR | null;
};

/** Shape of a cross-referenced PR event from the GitHub issue timeline API. */
type CrossRefEvent = {
  event?: string;
  source?: {
    issue?: {
      number?: number;
      state?: string;
      html_url?: string;
      updated_at?: string;
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
  // updatedAt is read directly from the timeline event's source.issue
  // (issue.updated_at is exposed on the cross-reference payload), so no
  // extra pulls.get round-trip is needed. Left undefined when absent —
  // isLinkedPRStalled treats missing data as not-stalled.
  return {
    number: issue.number,
    author,
    state: issue.state === "closed" ? "closed" : "open",
    merged: !!issue.pull_request?.merged_at,
    url,
    updatedAt: issue.updated_at,
  };
}

const MODULE = "issue-eligibility";

/**
 * Claim detection, applied per clause (sentence). Plain substring matching
 * flagged questions ("is anyone working on it?") and negations ("no one is
 * working on this") as claims. Rules:
 *
 * - A clause ending in "?" is never a claim, EXCEPT a permission request
 *   ("can I work on this?"), which is the author asking to take the issue.
 * - A declarative clause with an indefinite or negated subject (anyone,
 *   someone, nobody, not, ...) is never a claim.
 * - Otherwise declarative claim patterns match, including third-person
 *   ("Bob is working on it" means the issue is taken).
 */
/**
 * Object that refers to the issue at hand: this/it/that, "the <thing>",
 * "#123", "issue ...". Deliberately excludes "a <thing>" ("can I work on a
 * repro?" introduces new work, it does not claim the issue). The numeric
 * branch requires the # prefix: a bare number collides with quantity idioms
 * ("can I take 5 minutes"). Residual misses: gerund objects ("work on
 * fixing the bug") and bare numbers ("work on 126").
 */
const ISSUE_OBJECT = String.raw`(?:this\b|it\b|that\b|the\b|#\d+|issue\b)`;

/** Explicit first-person claims; not subject to the subject guard. */
const FIRST_PERSON_CLAIM_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bi\s*(?:'ll|will) take ${ISSUE_OBJECT}`),
  new RegExp(
    String.raw`\bi\s*(?:'d|would) (?:like|love) to work on ${ISSUE_OBJECT}`,
  ),
  /\bi\s*(?:'m|am) on it\b/,
  /\bi\s*(?:'ll|will) submit a pr\b/,
  /\bassigned to me\b/,
];

/**
 * Generic "working on ..." phrasings. These also match third-person claims
 * ("Bob is working on it"), so they need the subject guard below to avoid
 * flagging indefinite or negated subjects.
 */
const GENERIC_WORKING_PATTERNS: readonly RegExp[] = [
  /\bworking on (?:this|it)\b/,
  /\bworking on a (?:fix|pr)\b/,
];

/** Asking to take the issue counts as a claim even phrased as a question. */
const PERMISSION_CLAIM_PATTERN = new RegExp(
  String.raw`\b(?:can|may|could) i (?:work on|take) ${ISSUE_OBJECT}`,
);

/** Subjects/negations that make a "working on ..." clause a non-claim. */
const NON_CLAIM_SUBJECTS =
  /\b(?:anyone|anybody|someone|somebody|who|whoever|nobody|no[- ]?one|not)\b/;

/** True when a single comment body claims the issue. */
export function commentClaimsIssue(body: string): boolean {
  const clauses = body.toLowerCase().split(/(?<=[.!?])|\n+/);
  for (const clause of clauses) {
    if (PERMISSION_CLAIM_PATTERN.test(clause)) return true;
    if (clause.trimEnd().endsWith("?")) continue;
    if (FIRST_PERSON_CLAIM_PATTERNS.some((p) => p.test(clause))) return true;
    if (NON_CLAIM_SUBJECTS.test(clause)) continue;
    if (GENERIC_WORKING_PATTERNS.some((p) => p.test(clause))) return true;
  }
  return false;
}

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
    rethrowIfFatal(error);
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
): Promise<number | null> {
  const cache = getHttpCache();
  const cacheKey = versionedCacheKey(`merged-prs:${owner}/${repo}`);

  // In-flight dedup: parallel vetting frequently hits several issues from
  // one repo at once, and each used to pay a separate Search API call
  // before the first populated the cache (#124).
  return withInflightDedup(cache, cacheKey, async () => {
    // Manual cache check — do not use cachedTimeBased because we must NOT
    // cache error-path fallback values (a transient failure returning 0
    // would poison the cache for 15 minutes, hiding that the user has
    // merged PRs in the repo).
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
      rethrowIfFatal(error);
      const errMsg = errorMessage(error);
      warn(
        MODULE,
        `Could not check merged PRs in ${owner}/${repo}: ${errMsg}. Treating as unknown.`,
      );
      // null (not 0) so callers can tell a transient failure from a real zero
      // and avoid caching verdicts built on it. Not cached — next call retries.
      return null;
    }
  });
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
    // Fetch only the newest comments. Walking every page cost a
    // 2,000-comment issue 20 list calls per vet, then discarded all but the
    // tail anyway. Claims live in recent activity, so fetch the last page
    // (plus its predecessor so a short last page still yields ~100+
    // comments): at most 2 calls.
    const PER_PAGE = 100;
    const lastPage = Math.max(1, Math.ceil(commentCount / PER_PAGE));
    const pagesToFetch = lastPage > 1 ? [lastPage - 1, lastPage] : [1];

    const recentComments: Array<{ body?: string | null }> = [];
    for (const page of pagesToFetch) {
      const response = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: issueNumber,
        per_page: PER_PAGE,
        page,
      });
      recentComments.push(...response.data);
    }

    for (const comment of recentComments) {
      if (commentClaimsIssue(comment.body || "")) {
        return { passed: false };
      }
    }

    return { passed: true };
  } catch (error) {
    rethrowIfFatal(error);
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
