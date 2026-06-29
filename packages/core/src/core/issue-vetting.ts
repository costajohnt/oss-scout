/**
 * Issue Vetting — orchestrates individual issue checks and computes
 * recommendation + viability score.
 *
 * Delegates to focused modules:
 * - issue-eligibility.ts — PR existence, claim detection, requirements analysis
 * - repo-health.ts       — project health, contribution guidelines
 */

import { Octokit } from "@octokit/rest";
import { parseGitHubUrl } from "./utils.js";
import {
  type TrackedIssue,
  type IssueVettingResult,
  type SearchPriority,
  type IssueCandidate,
  type ProjectCategory,
  type ScoutPreferences,
  type ScoutState,
  type MergedPRRecord,
  type ClosedPRRecord,
  type OpenPRRecord,
} from "./types.js";
import {
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
} from "./errors.js";
import { debug, warn } from "./logger.js";
import {
  calculateRepoQualityBonus,
  calculateViabilityScore,
} from "./issue-scoring.js";
import { repoBelongsToCategory } from "./category-mapping.js";
import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from "./issue-eligibility.js";
import {
  checkProjectHealth,
  fetchContributionGuidelines,
} from "./repo-health.js";
import { fetchAndScanAntiLLMPolicy } from "./anti-llm-policy.js";
import {
  prefetchIssueCores,
  issueCoreKey,
  type PrefetchedIssueCore,
} from "./issue-graphql.js";
import { getHttpCache, versionedCacheKey } from "./http-cache.js";
import {
  getSearchBudgetTracker,
  type SearchBudgetTracker,
} from "./search-budget.js";
import {
  triageWithSLM,
  buildTriageInput,
  type SLMTriageOptions,
} from "./slm-triage.js";

const MODULE = "issue-vetting";

/** Vetting concurrency: kept low to reduce burst pressure on GitHub's secondary rate limit. */
const MAX_CONCURRENT_VETTING = 3;

/** TTL for cached vetting results (15 minutes). Kept short so config changes take effect quickly. */
const VETTING_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Feature-mode signals supplied by the caller (orchestrator) — the vetter
 * does NOT extract these from the GitHub issue itself. When passed, they
 * plumb through to `calculateViabilityScore` to apply reaction, comment-depth,
 * milestone, roadmap, and wontfix-no-contributor bonuses.
 */
export type FeatureSignals = {
  reactions: number;
  comments: number;
  hasMilestone: boolean;
  /**
   * Issue is referenced from the repo's ROADMAP.md. Strong maintainer-commitment
   * signal — they've publicly committed to the work in a roadmap doc (#95).
   */
  onRoadmap?: boolean;
  /**
   * Issue exhibits "wontfix-no-contributor" pattern — labeled help-wanted /
   * contributions-welcome / up-for-grabs / bounty, no linked PR, open >= 60
   * days. Maintainer wants it; nobody has stepped up (#96).
   */
  wontfixNoContributor?: boolean;
};

/**
 * SLM pre-triage configuration (oss-autopilot#1122). `host` is the Ollama
 * endpoint; an empty `host` means "use the triage default". A `null` config
 * (not this shape) means SLM triage is disabled (#158).
 */
export interface SLMConfig {
  model: string;
  host: string;
}

/**
 * Read-only interface for accessing scout state during issue vetting.
 * Implementations may be backed by gist persistence, in-memory state, etc.
 */
export interface ScoutStateReader {
  /** Repos where the user has at least one merged PR. */
  getReposWithMergedPRs(): string[];
  /** Repos where the user has at least one open PR. */
  getReposWithOpenPRs(): string[];
  /** User's starred repos (from GitHub). */
  getStarredRepos(): string[];
  /** Preferred project categories from user preferences. */
  getProjectCategories(): ProjectCategory[];
  /** Numeric quality score for a repo, or null if not evaluated. */
  getRepoScore(repo: string): number | null;
  /**
   * SLM pre-triage config (oss-autopilot#1122). Returns the configured model
   * id and Ollama host, or `null` when SLM triage is not configured — vetIssue
   * skips the SLM call on `null`. Required (#158): the old optional method with
   * an empty-string sentinel could not distinguish "not configured" from "host
   * defaulted"; `SLMConfig | null` makes the absence explicit.
   */
  getSLMTriageConfig(): SLMConfig | null;
  /**
   * Number of the user's PRs closed without merge in this repo (#125).
   * Optional so existing implementations keep compiling; absent reads as 0.
   */
  getClosedWithoutMergeCount?(repo: string): number;
  /**
   * The configured GitHub username, used to tell the user's own in-flight PR
   * apart from a competing one (#166). Optional; absent reads as "unknown".
   */
  getGitHubUsername?(): string;
}

/**
 * Write side of the scout state, consumed by the bootstrap flow. Defined here
 * next to ScoutStateReader so core/bootstrap.ts can depend on this contract
 * instead of importing the OssScout facade from the package root (an upward
 * dependency). OssScout implements it (#156).
 */
export interface ScoutStateWriter {
  /** Read current preferences (bootstrap reads githubUsername). */
  getPreferences(): Readonly<ScoutPreferences>;
  /** Replace the cached starred-repo list. */
  setStarredRepos(repos: string[]): void;
  /** Record a merged PR (deduplicated by URL). */
  recordMergedPR(pr: MergedPRRecord): void;
  /** Record a PR closed without merge (deduplicated by URL). */
  recordClosedPR(pr: ClosedPRRecord): void;
  /** Record an open PR (deduplicated by URL). */
  recordOpenPR(pr: OpenPRRecord): void;
  /** Snapshot the current state (bootstrap reports counts from it). */
  getState(): Readonly<ScoutState>;
}

/**
 * Inputs to deriveRecommendation: the already-computed check results and
 * affinity signals. Kept as a flat record of primitives so the derivation is a
 * pure function, independently unit-testable (#157).
 */
export interface RecommendationInput {
  noExistingPR: boolean;
  /**
   * The linked PR is the user's own open PR (#166). When true, the existing-PR
   * block is reframed as "you're already on it" — a skip with a clear reason —
   * instead of a competing-PR penalty.
   */
  ownPR: boolean;
  /**
   * The linked PR was already merged (#249 part B). The issue is effectively
   * resolved, so it is a hard skip — surfacing it as a contribution
   * opportunity is noise. Distinct from an open competing PR (which may be
   * revivable). Defaults to false.
   */
  linkedPRMerged?: boolean;
  /**
   * The linked PR was closed without merging (#249 part B). The previous
   * attempt was abandoned or rejected, so default to skip rather than
   * re-surfacing it. Defaults to false.
   */
  linkedPRClosed?: boolean;
  notClaimed: boolean;
  clearRequirements: boolean;
  contributionGuidelinesFound: boolean;
  projectIsActive: boolean;
  projectCheckFailed: boolean;
  projectFailureReason?: string;
  existingPRInconclusive: boolean;
  existingPRReason?: string;
  claimInconclusive: boolean;
  claimReason?: string;
  mergedCountInconclusive: boolean;
  effectiveMergedCount: number;
  orgName: string;
  orgHasMergedPRs: boolean;
  matchesCategory: boolean;
  issueClosed: boolean;
  /** noExistingPR && notClaimed && projectActive && clearRequirements. */
  passedAllChecks: boolean;
}

export interface RecommendationOutput {
  notes: string[];
  reasonsToApprove: string[];
  reasonsToSkip: string[];
  recommendation: "approve" | "skip" | "needs_review";
}

/**
 * Derive the human-readable notes, approve/skip reasons, and the final
 * recommendation from a vet's check results. Pure: no I/O, no state reads — the
 * caller computes the inputs and threads them in. Extracted from vetIssue so
 * the recommendation logic is testable in isolation (#157).
 */
export function deriveRecommendation(
  input: RecommendationInput,
): RecommendationOutput {
  const notes: string[] = [];
  const reasonsToApprove: string[] = [];
  const reasonsToSkip: string[] = [];

  // Notes (order preserved from the original vetIssue body).
  if (!input.noExistingPR)
    notes.push(
      input.ownPR
        ? "Your PR is already in flight for this issue"
        : input.linkedPRMerged
          ? "A PR for this issue was already merged"
          : input.linkedPRClosed
            ? "A PR for this issue was closed without merging"
            : "Existing PR found for this issue",
    );
  if (!input.notClaimed) notes.push("Issue appears to be claimed by someone");
  if (input.existingPRInconclusive) {
    notes.push(
      `Could not verify absence of existing PRs: ${input.existingPRReason || "API error"}`,
    );
  }
  if (input.claimInconclusive) {
    notes.push(
      `Could not verify claim status: ${input.claimReason || "API error"}`,
    );
  }
  if (input.projectCheckFailed) {
    notes.push(
      `Could not verify project activity: ${input.projectFailureReason || "API error"}`,
    );
  } else if (!input.projectIsActive) {
    notes.push("Project may be inactive");
  }
  if (!input.clearRequirements) notes.push("Issue requirements are unclear");
  if (!input.contributionGuidelinesFound)
    notes.push("No CONTRIBUTING.md found");

  // Reasons to skip / approve.
  if (!input.noExistingPR) {
    if (input.ownPR) reasonsToSkip.push("You already have a PR in flight");
    else if (input.linkedPRMerged)
      reasonsToSkip.push("Linked PR already merged");
    else if (input.linkedPRClosed)
      reasonsToSkip.push("Linked PR closed without merge");
    else reasonsToSkip.push("Has existing PR");
  }
  if (!input.notClaimed) reasonsToSkip.push("Already claimed");
  if (!input.projectIsActive && !input.projectCheckFailed)
    reasonsToSkip.push("Inactive project");
  if (!input.clearRequirements) reasonsToSkip.push("Unclear requirements");

  if (input.noExistingPR) reasonsToApprove.push("No existing PR");
  if (input.notClaimed) reasonsToApprove.push("Not claimed");
  if (input.projectIsActive && !input.projectCheckFailed)
    reasonsToApprove.push("Active project");
  if (input.clearRequirements) reasonsToApprove.push("Clear requirements");
  if (input.contributionGuidelinesFound)
    reasonsToApprove.push("Has contribution guidelines");
  if (input.effectiveMergedCount > 0) {
    reasonsToApprove.push(
      `Trusted project (${input.effectiveMergedCount} PR${input.effectiveMergedCount > 1 ? "s" : ""} merged)`,
    );
  }
  if (input.orgHasMergedPRs) {
    reasonsToApprove.push(
      `Org affinity (merged PRs in other ${input.orgName} repos)`,
    );
  }
  if (input.matchesCategory) {
    reasonsToApprove.push("Matches preferred project category");
  }
  if (input.issueClosed) {
    reasonsToSkip.push("Issue is closed");
  }

  // Recommendation.
  let recommendation: "approve" | "skip" | "needs_review";
  if (input.issueClosed) {
    recommendation = "skip";
  } else if (input.linkedPRMerged || input.linkedPRClosed) {
    // The issue is resolved (merged) or its attempt was abandoned/rejected
    // (closed) — a hard skip, not a revive opportunity (#249 part B). An OPEN
    // competing PR is deliberately NOT caught here; it falls through to the
    // existing competing-PR handling below.
    recommendation = "skip";
  } else if (input.ownPR) {
    // You're already working on this; don't re-surface it as competition.
    recommendation = "skip";
  } else if (input.passedAllChecks) {
    recommendation = "approve";
  } else if (reasonsToSkip.length > 2) {
    recommendation = "skip";
  } else {
    recommendation = "needs_review";
  }

  // Downgrade an "approve" when any check was inconclusive — "approve" should
  // only be given when checks actually passed, not when they were skipped.
  const hasInconclusiveChecks =
    input.projectCheckFailed ||
    input.existingPRInconclusive ||
    input.claimInconclusive ||
    input.mergedCountInconclusive;
  if (recommendation === "approve" && hasInconclusiveChecks) {
    recommendation = "needs_review";
    notes.push(
      "Recommendation downgraded: one or more checks were inconclusive",
    );
  }

  return { notes, reasonsToApprove, reasonsToSkip, recommendation };
}

export class IssueVetter {
  private octokit: Octokit;
  private stateReader: ScoutStateReader;
  private budgetTracker: SearchBudgetTracker;

  /**
   * @param octokit      - Authenticated Octokit instance
   * @param stateReader  - Read-only scout state interface
   * @param budgetTracker - Search budget tracker. Defaults to the shared
   *   singleton so existing callers behave identically; inject a per-search
   *   instance to isolate budget accounting in a long-lived concurrent host.
   */
  constructor(
    octokit: Octokit,
    stateReader: ScoutStateReader,
    budgetTracker: SearchBudgetTracker = getSearchBudgetTracker(),
  ) {
    this.octokit = octokit;
    this.stateReader = stateReader;
    this.budgetTracker = budgetTracker;
  }

  /**
   * Vet a specific issue — runs all checks and computes recommendation + viability score.
   * Results are cached for 15 minutes to avoid redundant API calls on repeated searches.
   *
   * `opts.featureSignals` are forwarded directly to scoring; the vetter does
   * not derive them from the fetched issue. Cache key includes a digest of
   * the signals so the same URL with different signals doesn't return a
   * stale score.
   */
  async vetIssue(
    issueUrl: string,
    opts?: {
      featureSignals?: FeatureSignals;
      /**
       * Issue core data already fetched in a batch GraphQL query (#169). When
       * present it replaces the per-issue REST `issues.get`; otherwise the
       * core is fetched via REST. The two paths are normalized to the same
       * shape so behaviour is identical either way.
       */
      prefetched?: PrefetchedIssueCore;
    },
  ): Promise<IssueCandidate> {
    // Check vetting cache first — avoids ~6+ API calls per issue
    const cache = getHttpCache();
    const sigKey = opts?.featureSignals
      ? `:r${opts.featureSignals.reactions}c${opts.featureSignals.comments}m${opts.featureSignals.hasMilestone ? 1 : 0}o${opts.featureSignals.onRoadmap ? 1 : 0}w${opts.featureSignals.wontfixNoContributor ? 1 : 0}`
      : "";
    const cacheKey = versionedCacheKey(`vet:${issueUrl}${sigKey}`);
    const cached = cache.getIfFresh(cacheKey, VETTING_CACHE_TTL_MS);
    if (
      cached &&
      typeof cached === "object" &&
      "issue" in cached &&
      "viabilityScore" in cached
    ) {
      debug(MODULE, `Vetting cache hit for ${issueUrl}`);
      return cached as IssueCandidate;
    }

    // Parse URL
    const parsed = parseGitHubUrl(issueUrl);
    if (!parsed || parsed.type !== "issues") {
      throw new ValidationError(`Invalid issue URL: ${issueUrl}`);
    }

    const { owner, repo, number } = parsed;
    const repoFullName = `${owner}/${repo}`;

    // Issue core data: use the batch-prefetched GraphQL result when the caller
    // supplied one (#169), otherwise fetch it per-issue via REST. Both paths
    // normalize to the same shape (fetchIssueCore), so downstream logic is
    // identical regardless of source.
    const core =
      opts?.prefetched ?? (await this.fetchIssueCore(owner, repo, number));

    // Check if the user already has merged PRs in this repo (skip the Search API call)
    const reposWithMergedPRs = this.stateReader.getReposWithMergedPRs();
    const hasMergedPRsInRepo = reposWithMergedPRs.includes(repoFullName);

    // Run all vetting checks in parallel — delegates to standalone functions
    const [
      existingPRCheck,
      claimCheck,
      projectHealth,
      contributionGuidelines,
      userMergedPRCount,
    ] = await Promise.all([
      checkNoExistingPR(this.octokit, owner, repo, number),
      checkNotClaimed(this.octokit, owner, repo, number, core.commentCount),
      checkProjectHealth(this.octokit, owner, repo),
      fetchContributionGuidelines(this.octokit, owner, repo),
      hasMergedPRsInRepo
        ? Promise.resolve(0)
        : checkUserMergedPRsInRepo(
            this.octokit,
            owner,
            repo,
            this.budgetTracker,
          ),
    ]);

    // Anti-LLM scan reuses the CONTRIBUTING text just fetched above —
    // dedup'd to avoid 4 redundant getContent calls on cold-cache repos.
    // We deliberately pass undefined (not null) when guidelines is missing,
    // because fetchContributionGuidelines returns undefined for BOTH a 404
    // and a transient 5xx — collapsing them to null would bypass the
    // anti-llm-policy transient-failure cache safeguard.
    const antiLLMPolicy = await fetchAndScanAntiLLMPolicy(
      this.octokit,
      owner,
      repo,
      { contributingText: contributionGuidelines?.rawContent },
    );

    const noExistingPR = existingPRCheck.passed;
    const notClaimed = claimCheck.passed;

    // Is the linked PR the user's own open PR (#166)? If so the issue is
    // "you're already on it", not competition.
    const username = this.stateReader.getGitHubUsername?.() ?? "";
    const linkedPR = existingPRCheck.linkedPR;
    const ownPR =
      !noExistingPR &&
      !!linkedPR &&
      linkedPR.state === "open" &&
      !linkedPR.merged &&
      username !== "" &&
      linkedPR.author.toLowerCase() === username.toLowerCase();
    // Linked-PR lifecycle gate (#249 part B): a merged linked PR means the
    // issue is resolved; a closed-unmerged one means the attempt was
    // abandoned/rejected. Both are hard skips. (state === "closed" && merged
    // is how buildLinkedPRFromTimelineEvent encodes a merged PR.)
    const linkedPRMerged = !!linkedPR && linkedPR.merged;
    const linkedPRClosed =
      !!linkedPR && linkedPR.state === "closed" && !linkedPR.merged;

    // Analyze issue quality
    const clearRequirements = analyzeRequirements(core.body);

    // When the health check itself failed (API error), use a neutral default:
    // don't penalize the repo as inactive, but don't credit it as active either.
    const projectActive = projectHealth.checkFailed
      ? true
      : projectHealth.isActive;

    const vettingResult: IssueVettingResult = {
      passedAllChecks:
        noExistingPR && notClaimed && projectActive && clearRequirements,
      checks: {
        noExistingPR,
        notClaimed,
        projectActive,
        clearRequirements,
        contributionGuidelinesFound: !!contributionGuidelines,
      },
      contributionGuidelines,
      linkedPR: existingPRCheck.linkedPR,
      notes: [],
    };

    // Create tracked issue. It holds a reference to vettingResult, whose
    // notes are filled in by deriveRecommendation below.
    const trackedIssue: TrackedIssue = {
      id: core.id,
      url: issueUrl,
      repo: repoFullName,
      number,
      title: core.title,
      status: "candidate",
      labels: core.labels,
      createdAt: core.createdAt,
      updatedAt: core.updatedAt,
      vetted: true,
      vettingResult,
    };

    // Effective merged PR count: prefer local state (authoritative if present),
    // fall back to live GitHub API count to detect contributions made before
    // using oss-scout. null means the live check transiently failed: score as
    // 0 but treat the result as inconclusive so it is not cached.
    const mergedCountInconclusive =
      !hasMergedPRsInRepo && userMergedPRCount === null;
    const effectiveMergedCount = hasMergedPRsInRepo
      ? 1
      : (userMergedPRCount ?? 0);

    // Org-level affinity (user has merged PRs in another repo under same org).
    const orgName = repoFullName.split("/")[0];
    let orgHasMergedPRs = false;
    if (orgName && repoFullName.includes("/")) {
      orgHasMergedPRs = reposWithMergedPRs.some(
        (r) => r.startsWith(orgName + "/") && r !== repoFullName,
      );
    }

    const matchesCategory = repoBelongsToCategory(
      repoFullName,
      this.stateReader.getProjectCategories(),
    );

    // GitHub answers 200 for closed issues, so without an explicit state
    // check a closed issue would vet as still available (#120).
    const issueClosed = core.state === "closed";

    // Never cache a verdict built on inconclusive/failed checks (e.g. a
    // transient 5xx): that would pin a degraded result for the whole TTL.
    const hasInconclusiveChecks =
      projectHealth.checkFailed ||
      !!existingPRCheck.inconclusive ||
      !!claimCheck.inconclusive ||
      mergedCountInconclusive;

    const { notes, reasonsToApprove, reasonsToSkip, recommendation } =
      deriveRecommendation({
        noExistingPR,
        ownPR,
        linkedPRMerged,
        linkedPRClosed,
        notClaimed,
        clearRequirements,
        contributionGuidelinesFound: !!contributionGuidelines,
        projectIsActive: projectHealth.checkFailed
          ? false
          : projectHealth.isActive,
        projectCheckFailed: !!projectHealth.checkFailed,
        projectFailureReason: projectHealth.failureReason,
        existingPRInconclusive: !!existingPRCheck.inconclusive,
        existingPRReason: existingPRCheck.inconclusive
          ? existingPRCheck.reason
          : undefined,
        claimInconclusive: !!claimCheck.inconclusive,
        claimReason: claimCheck.inconclusive ? claimCheck.reason : undefined,
        mergedCountInconclusive,
        effectiveMergedCount,
        orgName,
        orgHasMergedPRs,
        matchesCategory,
        issueClosed,
        passedAllChecks: vettingResult.passedAllChecks,
      });
    vettingResult.notes = notes;

    // Calculate repo quality bonus from star/fork counts. A failed health
    // check carries no counts (#158), so the bonus is 0 in that case.
    const repoQualityBonus = projectHealth.checkFailed
      ? 0
      : calculateRepoQualityBonus(
          projectHealth.stargazersCount ?? 0,
          projectHealth.forksCount ?? 0,
        );
    if (projectHealth.checkFailed && repoQualityBonus === 0) {
      vettingResult.notes.push(
        "Repo quality bonus unavailable: could not fetch star/fork counts due to API error",
      );
    }

    const repoScore = this.stateReader.getRepoScore(repoFullName);
    const viabilityScore = calculateViabilityScore({
      repoScore,
      hasExistingPR: !noExistingPR,
      isClaimed: !notClaimed,
      clearRequirements,
      hasContributionGuidelines: !!contributionGuidelines,
      issueUpdatedAt: core.updatedAt,
      closedWithoutMergeCount:
        this.stateReader.getClosedWithoutMergeCount?.(repoFullName) ?? 0,
      mergedPRCount: effectiveMergedCount,
      orgHasMergedPRs,
      repoQualityBonus,
      matchesPreferredCategory: matchesCategory,
      featureSignals: opts?.featureSignals,
    });

    const starredRepos = this.stateReader.getStarredRepos();
    let searchPriority: SearchPriority = "normal";
    if (effectiveMergedCount > 0) {
      searchPriority = "merged_pr";
    } else if (starredRepos.includes(repoFullName)) {
      searchPriority = "starred";
    }

    // Optional SLM pre-triage (oss-autopilot#1122). Fail-open: any error
    // path returns null and the rest of the pipeline is unaffected. A null
    // config means SLM triage is disabled (#158).
    const slmConfig = this.stateReader.getSLMTriageConfig();
    let slmTriage: IssueCandidate["slmTriage"] = null;
    if (slmConfig) {
      const slmOpts: SLMTriageOptions = { model: slmConfig.model };
      if (slmConfig.host) slmOpts.host = slmConfig.host;
      slmTriage = await triageWithSLM(
        buildTriageInput({
          issue: { ...trackedIssue, body: core.body },
          linkedPR: existingPRCheck.linkedPR ?? null,
        }),
        slmOpts,
      );
    }

    const result: IssueCandidate = {
      issue: trackedIssue,
      issueState: issueClosed ? "closed" : "open",
      vettingResult,
      projectHealth,
      antiLLMPolicy,
      slmTriage,
      recommendation,
      reasonsToSkip,
      reasonsToApprove,
      viabilityScore,
      searchPriority,
    };

    // Cache the vetting result to avoid redundant API calls on repeated
    // searches — but never cache results built on inconclusive/failed checks
    // (e.g. a transient 5xx): that would pin a degraded verdict for the whole
    // TTL. Next vet retries instead. Mirrors the error-path rule in
    // issue-eligibility's checkUserMergedPRsInRepo.
    if (!hasInconclusiveChecks) {
      cache.set(cacheKey, "", result);
    }

    return result;
  }

  /**
   * Fetch a single issue's core fields via REST and normalize them to the same
   * shape as a GraphQL prefetch (#169). The REST fallback path when no
   * prefetched core was supplied.
   */
  private async fetchIssueCore(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PrefetchedIssueCore> {
    const { data: ghIssue } = await this.octokit.issues.get({
      owner,
      repo,
      issue_number: number,
    });
    return {
      id: ghIssue.id,
      title: ghIssue.title,
      body: ghIssue.body || "",
      state: ghIssue.state === "closed" ? "closed" : "open",
      labels: ghIssue.labels.map((l) =>
        typeof l === "string" ? l : l.name || "",
      ),
      commentCount: ghIssue.comments,
      createdAt: ghIssue.created_at,
      updatedAt: ghIssue.updated_at,
    };
  }

  /**
   * Vet multiple issues in parallel with concurrency limit
   */
  async vetIssuesParallel(
    urls: string[],
    maxResults: number,
    priority?: SearchPriority,
  ): Promise<{
    candidates: IssueCandidate[];
    allFailed: boolean;
    rateLimitHit: boolean;
  }> {
    const candidates: IssueCandidate[] = [];
    const pending = new Map<string, Promise<void>>();
    let failedVettingCount = 0;
    let rateLimitFailures = 0;
    let attemptedCount = 0;
    // Capture the first 401 so we can re-throw after in-flight tasks settle.
    // Per-item tolerance is right for transient failures, but a 401 means
    // the token is invalid and no other issue will succeed either —
    // continuing to log per-issue warnings buries the actual problem.
    let firstAuthError: unknown = null;

    // Dedup defensively: the pending map is keyed by URL, so a duplicate
    // input would overwrite the in-flight entry and its finally-cleanup
    // would deregister the second task, letting allSettled return while a
    // vet still runs (#129). Callers dedup today, but nothing enforced it.
    const uniqueUrls = [...new Set(urls)];

    // Batch-prefetch issue core data in one GraphQL query (#169), replacing N
    // per-issue REST `issues.get` calls. Any URL the prefetch can't resolve
    // (parse failure, deleted issue, non-fatal GraphQL error) is simply absent
    // from the map and vetIssue falls back to REST for it. A fatal error (401 /
    // rate limit) propagates out of prefetchIssueCores and aborts the batch,
    // matching the per-issue auth-error handling below.
    const prefetched = await prefetchIssueCores(
      this.octokit,
      uniqueUrls.flatMap((url) => {
        const p = parseGitHubUrl(url);
        return p && p.type === "issues"
          ? [{ owner: p.owner, repo: p.repo, number: p.number }]
          : [];
      }),
    );
    const prefetchFor = (url: string): PrefetchedIssueCore | undefined => {
      const p = parseGitHubUrl(url);
      return p && p.type === "issues"
        ? prefetched.get(issueCoreKey(p.owner, p.repo, p.number))
        : undefined;
    };

    for (const url of uniqueUrls) {
      if (candidates.length >= maxResults) break;
      if (firstAuthError) break; // stop scheduling once auth has failed
      attemptedCount++;

      const core = prefetchFor(url);
      const task = this.vetIssue(url, core ? { prefetched: core } : undefined)
        .then((candidate) => {
          if (candidates.length < maxResults) {
            // Override the priority if provided
            if (priority) {
              candidate.searchPriority = priority;
            }
            candidates.push(candidate);
          }
        })
        .catch((error) => {
          if (getHttpStatusCode(error) === 401) {
            firstAuthError ??= error;
            return;
          }
          failedVettingCount++;
          if (isRateLimitError(error)) {
            rateLimitFailures++;
          }
          warn(MODULE, `Error vetting issue ${url}:`, errorMessage(error));
        })
        .finally(() => pending.delete(url));

      pending.set(url, task);

      // Limit concurrency — wait for at least one to complete before launching more
      if (pending.size >= MAX_CONCURRENT_VETTING) {
        await Promise.race(pending.values());
      }
    }

    // Wait for remaining
    await Promise.allSettled(pending.values());

    if (firstAuthError) {
      if (candidates.length > 0) {
        warn(
          MODULE,
          `Auth failed mid-batch after ${candidates.length} successful vet(s) — discarding partial results`,
        );
      }
      throw firstAuthError;
    }

    const allFailed =
      failedVettingCount === attemptedCount && attemptedCount > 0;
    if (allFailed) {
      warn(
        MODULE,
        `All ${attemptedCount} issue(s) failed vetting. ` +
          `This may indicate a systemic issue (rate limit, auth, network).`,
      );
    }

    return {
      candidates: candidates.slice(0, maxResults),
      allFailed,
      rateLimitHit: rateLimitFailures > 0,
    };
  }
}
