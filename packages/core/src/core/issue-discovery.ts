/**
 * Issue Discovery — orchestrates multi-phase issue search across GitHub.
 *
 * Delegates filtering, scoring, vetting, and search infrastructure to focused modules:
 * - issue-filtering.ts  — spam detection, doc-only filtering, per-repo caps
 * - issue-scoring.ts   — viability scores, repo quality bonuses
 * - issue-vetting.ts   — vetting orchestration, recommendation + viability scoring
 * - issue-eligibility.ts — PR existence, claim detection, requirements analysis
 * - repo-health.ts     — project health checks, contribution guidelines
 * - search-phases.ts   — search helpers, caching, batched repo search
 *
 * All state is injected via constructor parameters (ScoutStateReader + ScoutPreferences).
 */

import { Octokit } from "@octokit/rest";
import { getOctokit, checkRateLimit } from "./github.js";
import { getSearchBudgetTracker } from "./search-budget.js";
import { daysBetween, extractRepoFromUrl, sleep } from "./utils.js";
import {
  type SearchPriority,
  type IssueCandidate,
  type ProjectCategory,
  SCOPE_LABELS,
} from "./types.js";
import { CONCRETE_STRATEGIES } from "./schemas.js";
import type {
  IssueScope,
  ScoutPreferences,
  SearchStrategy,
} from "./schemas.js";
import {
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
} from "./errors.js";
import { debug, info, warn } from "./logger.js";
import {
  type GitHubSearchItem,
  isDocOnlyIssue,
  applyPerRepoCap,
} from "./issue-filtering.js";
import { IssueVetter, type ScoutStateReader } from "./issue-vetting.js";
import { getTopicsForCategories } from "./category-mapping.js";
import {
  buildEffectiveLabels,
  interleaveArrays,
  cachedSearchIssues,
  fetchIssuesFromMaintainedRepos,
  filterVetAndScore,
  fetchIssuesFromKnownRepos,
  searchWithChunkedLabels,
} from "./search-phases.js";

const MODULE = "issue-discovery";

/** If remaining search quota is below this, skip heavy phases (2, 3). */
const LOW_BUDGET_THRESHOLD = 20;

/** If remaining search quota is below this, only run Phase 0. */
const CRITICAL_BUDGET_THRESHOLD = 10;

// ── Extracted types and standalone functions ──────────────────────────

/** Result from a single search phase. */
interface PhaseResult {
  candidates: IssueCandidate[];
  error: string | null;
  rateLimitHit: boolean;
}

/** Configuration for the issue filter function. */
interface IssueFilterConfig {
  excludedRepos: Set<string>;
  excludeOrgs: Set<string>;
  aiBlocklisted: Set<string>;
  lowScoringRepos: Set<string>;
  skippedUrls: Set<string>;
  maxAgeDays: number;
  now: Date;
  includeDocIssues: boolean;
}

/** Build a reusable filter function from config. */
function buildIssueFilter(
  config: IssueFilterConfig,
): (items: GitHubSearchItem[]) => GitHubSearchItem[] {
  return (items: GitHubSearchItem[]) => {
    return items.filter((item) => {
      const repoFullName = extractRepoFromUrl(item.repository_url);
      if (!repoFullName) return false;
      if (config.excludedRepos.has(repoFullName)) return false;
      if (config.excludeOrgs.size > 0) {
        const orgName = repoFullName.split("/")[0]?.toLowerCase();
        if (orgName && config.excludeOrgs.has(orgName)) return false;
      }
      if (config.aiBlocklisted.has(repoFullName)) return false;
      if (config.lowScoringRepos.has(repoFullName)) return false;
      if (config.skippedUrls.has(item.html_url)) return false;
      const updatedAt = new Date(item.updated_at);
      const ageDays = daysBetween(updatedAt, config.now);
      if (ageDays > config.maxAgeDays) return false;
      if (!config.includeDocIssues && isDocOnlyIssue(item)) return false;
      return true;
    });
  };
}

/** Phase 0: Search repos where user has merged PRs (highest merge probability). */
async function runPhase0(
  octokit: Octokit,
  vetter: IssueVetter,
  repos: string[],
  maxResults: number,
  filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<PhaseResult> {
  info(
    MODULE,
    `Phase 0: Searching issues in ${repos.length} merged-PR repos (no label filter)...`,
  );

  const { candidates, allReposFailed, rateLimitHit } =
    await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      repos,
      [],
      maxResults,
      "merged_pr",
      filterIssues,
    );

  info(MODULE, `Found ${candidates.length} candidates from merged-PR repos`);

  return {
    candidates,
    error: allReposFailed ? "All merged-PR repo fetches failed" : null,
    rateLimitHit,
  };
}

/** Phase 1: Search starred repos. */
async function runPhase1(
  octokit: Octokit,
  vetter: IssueVetter,
  repos: string[],
  labels: string[],
  maxResults: number,
  filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<PhaseResult> {
  info(MODULE, `Phase 1: Searching issues in ${repos.length} starred repos...`);

  // Cap labels: starred repos already signal user interest, so fewer labels suffice.
  const phase1Labels = labels.slice(0, 3);
  const reposToSearch = repos.slice(0, 10);
  const { candidates, allReposFailed, rateLimitHit } =
    await fetchIssuesFromKnownRepos(
      octokit,
      vetter,
      reposToSearch,
      phase1Labels,
      maxResults,
      "starred",
      filterIssues,
    );

  info(MODULE, `Found ${candidates.length} candidates from starred repos`);

  return {
    candidates,
    error: allReposFailed ? "All starred repo fetches failed" : null,
    rateLimitHit,
  };
}

/** Phase 2: General label-filtered search with multi-tier interleaving. */
async function runPhase2(
  octokit: Octokit,
  vetter: IssueVetter,
  scopes: IssueScope[] | undefined,
  labels: string[],
  configLabels: string[],
  baseQualifiers: string,
  maxResults: number,
  minStars: number,
  phase0RepoSet: Set<string>,
  starredRepoSet: Set<string>,
  existingCandidates: IssueCandidate[],
  filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<PhaseResult> {
  info(MODULE, "Phase 2: General issue search...");
  const seenRepos = new Set(existingCandidates.map((c) => c.issue.repo));

  // Build per-tier label groups. Multi-tier when 2+ scopes; single-tier otherwise.
  const tierLabelGroups: { tier: string; tierLabels: string[] }[] = [];
  if (scopes && scopes.length > 1) {
    for (const scope of scopes) {
      const scopeLabels = SCOPE_LABELS[scope] ?? [];
      if (scopeLabels.length === 0) {
        warn(MODULE, `Scope "${scope}" has no labels, skipping tier`);
        continue;
      }
      tierLabelGroups.push({ tier: scope, tierLabels: scopeLabels });
    }
    const allScopeLabels = new Set(
      scopes.flatMap((s) => SCOPE_LABELS[s] ?? []),
    );
    const customOnly = configLabels.filter((l) => !allScopeLabels.has(l));
    if (customOnly.length > 0) {
      tierLabelGroups.push({ tier: "custom", tierLabels: customOnly });
    }
  } else {
    tierLabelGroups.push({ tier: "general", tierLabels: labels });
  }

  const budgetPerTier = Math.ceil(maxResults / tierLabelGroups.length);
  const tierResults: IssueCandidate[][] = [];
  let error: string | null = null;
  let rateLimitHit = false;

  for (const { tier, tierLabels } of tierLabelGroups) {
    try {
      const allItems = await searchWithChunkedLabels(
        octokit,
        tierLabels,
        0,
        (labelQ) => `${baseQualifiers} ${labelQ}`.replace(/  +/g, " ").trim(),
        budgetPerTier * 3,
      );

      info(MODULE, `Phase 2 [${tier}]: processing ${allItems.length} items...`);

      const {
        candidates: tierCandidates,
        allVetFailed,
        rateLimitHit: vetRateLimitHit,
      } = await filterVetAndScore(
        vetter,
        allItems,
        filterIssues,
        [phase0RepoSet, starredRepoSet, seenRepos],
        budgetPerTier,
        minStars,
        `Phase 2 [${tier}]`,
      );

      tierResults.push(tierCandidates);
      for (const c of tierCandidates) seenRepos.add(c.issue.repo);
      if (allVetFailed) {
        error = (error ? error + "; " : "") + `${tier}: all vetting failed`;
      }
      if (vetRateLimitHit) {
        rateLimitHit = true;
      }
      info(
        MODULE,
        `Found ${tierCandidates.length} candidates from ${tier} tier`,
      );
    } catch (err) {
      if (getHttpStatusCode(err) === 401) throw err;
      const errMsg = errorMessage(err);
      error = (error ? error + "; " : "") + `${tier}: ${errMsg}`;
      if (isRateLimitError(err)) {
        rateLimitHit = true;
      }
      warn(MODULE, `Error in ${tier} tier search: ${errMsg}`);
      tierResults.push([]);
    }
  }

  const interleaved = interleaveArrays(tierResults);
  if (interleaved.length === 0 && error) {
    warn(
      MODULE,
      `All ${tierLabelGroups.length} scope tiers failed in Phase 2: ${error}`,
    );
  }

  return {
    candidates: interleaved.slice(0, maxResults),
    error,
    rateLimitHit,
  };
}

/** Phase 3: Actively maintained repos (REST-first, Search API fallback). */
async function runPhase3(
  octokit: Octokit,
  vetter: IssueVetter,
  langQuery: string,
  minStars: number,
  projectCategories: ProjectCategory[],
  maxResults: number,
  phase0RepoSet: Set<string>,
  starredRepoSet: Set<string>,
  starredRepos: string[],
  existingCandidates: IssueCandidate[],
  filterIssues: (items: GitHubSearchItem[]) => GitHubSearchItem[],
): Promise<PhaseResult> {
  info(MODULE, "Phase 3: Searching actively maintained repos...");

  const seenRepos = new Set(existingCandidates.map((c) => c.issue.repo));

  // Step 1: Try REST API with starred repos first (no Search API quota used)
  const eligibleStarred = starredRepos.filter(
    (r) => !phase0RepoSet.has(r) && !seenRepos.has(r),
  );

  if (eligibleStarred.length > 0) {
    info(
      MODULE,
      `Phase 3: Checking ${eligibleStarred.length} starred repos via REST API...`,
    );
    const restItems = await fetchIssuesFromMaintainedRepos(
      octokit,
      eligibleStarred.slice(0, 15),
      minStars,
      maxResults,
    );

    if (restItems.length > 0) {
      const {
        candidates,
        allVetFailed,
        rateLimitHit: vetRateLimitHit,
      } = await filterVetAndScore(
        vetter,
        restItems,
        filterIssues,
        [phase0RepoSet, seenRepos],
        maxResults,
        minStars,
        "Phase 3 (REST)",
      );

      if (candidates.length > 0) {
        info(
          MODULE,
          `Found ${candidates.length} candidates from maintained-repo REST search`,
        );
        return {
          candidates,
          error: allVetFailed ? "all vetting failed" : null,
          rateLimitHit: vetRateLimitHit,
        };
      }
    }
  }

  // Step 2: Fall back to Search API if REST didn't yield results
  info(MODULE, "Phase 3: Falling back to Search API...");

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const pushedSince = thirtyDaysAgo.toISOString().split("T")[0];
  const categoryTopics = getTopicsForCategories(projectCategories);
  const topicQuery =
    categoryTopics.length > 0 ? `topic:${categoryTopics[0]}` : "";
  const phase3Query =
    `is:issue is:open no:assignee ${langQuery} ${topicQuery} stars:>=${minStars} pushed:>=${pushedSince} archived:false`
      .replace(/  +/g, " ")
      .trim();

  try {
    const data = await cachedSearchIssues(octokit, {
      q: phase3Query,
      sort: "updated",
      order: "desc",
      per_page: maxResults * 3,
    });

    info(
      MODULE,
      `Found ${data.total_count} issues in maintained-repo search, processing top ${data.items.length}...`,
    );

    const {
      candidates,
      allVetFailed,
      rateLimitHit: vetRateLimitHit,
    } = await filterVetAndScore(
      vetter,
      data.items,
      filterIssues,
      [phase0RepoSet, starredRepoSet, seenRepos],
      maxResults,
      minStars,
      "Phase 3",
    );

    info(
      MODULE,
      `Found ${candidates.length} candidates from maintained-repo search`,
    );

    return {
      candidates,
      error: allVetFailed ? "all vetting failed" : null,
      rateLimitHit: vetRateLimitHit,
    };
  } catch (error) {
    const errMsg = errorMessage(error);
    warn(MODULE, `Error in maintained-repo search: ${errMsg}`);
    return {
      candidates: [],
      error: errMsg,
      rateLimitHit: isRateLimitError(error),
    };
  }
}

// ── IssueDiscovery class ─────────────────────────────────────────────

/**
 * Multi-phase issue discovery engine that searches GitHub for contributable issues.
 *
 * Search phases (in priority order):
 * 0. Repos where user has merged PRs (highest merge probability)
 * 1. Starred repos
 * 2. General label-filtered search
 * 3. Actively maintained repos
 *
 * Each candidate is vetted for claimability and scored 0-100 for viability.
 */
export class IssueDiscovery {
  private octokit: Octokit;
  private githubToken: string;
  private vetter: IssueVetter;

  /** Set after searchIssues() runs if rate limits affected the search (low pre-flight quota or mid-search rate limit hits). */
  rateLimitWarning: string | null = null;

  /**
   * @param githubToken  - GitHub personal access token or token from `gh auth token`
   * @param preferences  - User's search preferences (languages, labels, scopes, etc.)
   * @param stateReader  - Read-only interface for accessing scout state (merged PRs, starred repos, etc.)
   */
  constructor(
    githubToken: string,
    private preferences: ScoutPreferences,
    private stateReader: ScoutStateReader,
  ) {
    this.githubToken = githubToken;
    this.octokit = getOctokit(githubToken);
    this.vetter = new IssueVetter(this.octokit, this.stateReader);
  }

  /**
   * Get starred repos from the state reader.
   * @returns Array of starred repo names in "owner/repo" format
   */
  getStarredRepos(): string[] {
    return this.stateReader.getStarredRepos();
  }

  /**
   * Search for issues matching our criteria.
   * Searches in priority order: merged-PR repos first (no label filter), then starred
   * repos, then general search, then actively maintained repos.
   * Filters out issues from low-scoring and excluded repos.
   *
   * @param options - Search configuration
   * @param options.languages - Programming languages to filter by
   * @param options.labels - Issue labels to search for
   * @param options.maxResults - Maximum candidates to return (default: 10)
   * @returns Scored and sorted issue candidates
   * @throws {ValidationError} If no candidates found and no rate limits prevented the search
   *
   * @example
   * ```typescript
   * import { IssueDiscovery } from '@oss-scout/core';
   *
   * const discovery = new IssueDiscovery(token, preferences, stateReader);
   * const candidates = await discovery.searchIssues({ maxResults: 5 });
   * for (const c of candidates) {
   *   console.log(`${c.issue.repo}#${c.issue.number}: ${c.viabilityScore}/100`);
   * }
   * ```
   */
  async searchIssues(
    options: {
      languages?: string[];
      labels?: string[];
      maxResults?: number;
      strategies?: SearchStrategy[];
      skippedUrls?: Set<string>;
    } = {},
  ): Promise<{
    candidates: IssueCandidate[];
    strategiesUsed: SearchStrategy[];
  }> {
    const config = this.preferences;
    const languages = options.languages || config.languages;
    const scopes = config.scope;
    const labels =
      options.labels ||
      (scopes ? buildEffectiveLabels(scopes, config.labels) : config.labels);
    const maxResults = options.maxResults || 10;
    const minStars = config.minStars ?? 50;
    const interPhaseDelay = config.interPhaseDelayMs ?? 30000;

    // Strategy selection
    const ALL_STRATEGIES: readonly SearchStrategy[] = CONCRETE_STRATEGIES;
    const rawStrategies = options.strategies ??
      config.defaultStrategy ?? ["all"];
    const enabledStrategies = new Set<SearchStrategy>(
      rawStrategies.includes("all") ? ALL_STRATEGIES : rawStrategies,
    );
    const strategiesUsed: SearchStrategy[] = [];

    const allCandidates: IssueCandidate[] = [];
    const phaseErrors: Record<string, string | null> = {};
    let rateLimitHitDuringSearch = false;

    // Pre-flight rate limit check
    this.rateLimitWarning = null;
    const tracker = getSearchBudgetTracker();
    let searchBudget = LOW_BUDGET_THRESHOLD - 1;
    try {
      const rateLimit = await checkRateLimit(this.githubToken);
      searchBudget = rateLimit.remaining;
      tracker.init(rateLimit.remaining, rateLimit.resetAt);
      if (rateLimit.remaining < 5) {
        const resetTime = new Date(rateLimit.resetAt).toLocaleTimeString(
          "en-US",
          { hour12: false },
        );
        this.rateLimitWarning = `GitHub search API quota low (${rateLimit.remaining}/${rateLimit.limit} remaining, resets at ${resetTime}). Search may be slow.`;
        warn(MODULE, this.rateLimitWarning);
      }
      if (searchBudget < CRITICAL_BUDGET_THRESHOLD) {
        info(
          MODULE,
          `Search budget critical (${searchBudget} remaining) — running only Phase 0`,
        );
      } else if (searchBudget < LOW_BUDGET_THRESHOLD) {
        info(
          MODULE,
          `Search budget low (${searchBudget} remaining) — skipping heavy phases (2, 3)`,
        );
      }
    } catch (error) {
      if (getHttpStatusCode(error) === 401) throw error;
      tracker.init(
        CRITICAL_BUDGET_THRESHOLD,
        new Date(Date.now() + 60000).toISOString(),
      );
      warn(
        MODULE,
        "Could not check rate limit — using conservative budget, skipping heavy phases:",
        errorMessage(error),
      );
    }

    if (searchBudget <= 0) {
      this.rateLimitWarning =
        "GitHub search API quota exhausted. Try again after the rate limit resets.";
      return { candidates: [], strategiesUsed: [] };
    }

    // Derive search context
    const mergedPRRepos = this.stateReader.getReposWithMergedPRs();
    const starredRepos = this.getStarredRepos();
    const starredRepoSet = new Set(starredRepos);
    const lowScoringRepos = new Set(
      this.deriveLowScoringRepos(config.minRepoScoreThreshold),
    );

    // Build query parts
    const isAnyLanguage = languages.some((l) => l.toLowerCase() === "any");
    const langQuery = isAnyLanguage
      ? ""
      : languages.map((l) => `language:${l}`).join(" ");
    const baseQualifiers = `is:issue is:open ${langQuery} no:assignee`
      .replace(/  +/g, " ")
      .trim();

    // Build reusable filter
    const aiBlocklisted = new Set(config.aiPolicyBlocklist);
    if (aiBlocklisted.size > 0) {
      debug(
        MODULE,
        `[AI_POLICY_FILTER] Filtering issues from ${aiBlocklisted.size} blocklisted repo(s): ${[...aiBlocklisted].join(", ")}`,
      );
    }
    const filterIssues = buildIssueFilter({
      excludedRepos: new Set(config.excludeRepos),
      excludeOrgs: new Set(
        (config.excludeOrgs ?? []).map((o) => o.toLowerCase()),
      ),
      aiBlocklisted,
      lowScoringRepos,
      skippedUrls: options.skippedUrls ?? new Set(),
      maxAgeDays: config.maxIssueAgeDays || 90,
      now: new Date(),
      includeDocIssues: config.includeDocIssues ?? true,
    });

    // Phase 0: Merged-PR repos
    const phase0Repos = mergedPRRepos.slice(0, 10);
    const phase0RepoSet = new Set(phase0Repos);

    if (phase0Repos.length > 0 && enabledStrategies.has("merged")) {
      const remaining = maxResults - allCandidates.length;
      if (remaining > 0) {
        const result = await runPhase0(
          this.octokit,
          this.vetter,
          phase0Repos,
          remaining,
          filterIssues,
        );
        allCandidates.push(...result.candidates);
        phaseErrors["0"] = result.error;
        if (result.rateLimitHit) rateLimitHitDuringSearch = true;
      }
      strategiesUsed.push("merged");
    }

    // Phase 1: Starred repos
    if (
      allCandidates.length < maxResults &&
      starredRepos.length > 0 &&
      searchBudget >= CRITICAL_BUDGET_THRESHOLD &&
      enabledStrategies.has("starred")
    ) {
      if (interPhaseDelay > 0) {
        info(
          MODULE,
          `Waiting ${(interPhaseDelay / 1000).toFixed(0)}s between phases for rate limit management...`,
        );
        await sleep(interPhaseDelay);
      }
      const reposToSearch = starredRepos.filter((r) => !phase0RepoSet.has(r));
      if (reposToSearch.length > 0) {
        const remaining = maxResults - allCandidates.length;
        if (remaining > 0) {
          const result = await runPhase1(
            this.octokit,
            this.vetter,
            reposToSearch,
            labels,
            remaining,
            filterIssues,
          );
          allCandidates.push(...result.candidates);
          phaseErrors["1"] = result.error;
          if (result.rateLimitHit) rateLimitHitDuringSearch = true;
        }
      }
      strategiesUsed.push("starred");
    }

    // Phase 2: General search
    if (
      allCandidates.length < maxResults &&
      searchBudget >= LOW_BUDGET_THRESHOLD &&
      enabledStrategies.has("broad")
    ) {
      if (interPhaseDelay > 0) {
        info(
          MODULE,
          `Waiting ${(interPhaseDelay / 1000).toFixed(0)}s between phases for rate limit management...`,
        );
        await sleep(interPhaseDelay);
      }
      const remaining = maxResults - allCandidates.length;
      const result = await runPhase2(
        this.octokit,
        this.vetter,
        scopes,
        labels,
        config.labels,
        baseQualifiers,
        remaining,
        minStars,
        phase0RepoSet,
        starredRepoSet,
        allCandidates,
        filterIssues,
      );
      allCandidates.push(...result.candidates);
      phaseErrors["2"] = result.error;
      if (result.rateLimitHit) rateLimitHitDuringSearch = true;
      strategiesUsed.push("broad");
    }

    // Phase 3: Actively maintained repos
    if (
      allCandidates.length < maxResults &&
      searchBudget >= LOW_BUDGET_THRESHOLD &&
      enabledStrategies.has("maintained")
    ) {
      if (interPhaseDelay > 0) {
        info(
          MODULE,
          `Waiting ${(interPhaseDelay / 1000).toFixed(0)}s between phases for rate limit management...`,
        );
        await sleep(interPhaseDelay);
      }
      const remaining = maxResults - allCandidates.length;
      const result = await runPhase3(
        this.octokit,
        this.vetter,
        langQuery,
        minStars,
        config.projectCategories ?? [],
        remaining,
        phase0RepoSet,
        starredRepoSet,
        starredRepos,
        allCandidates,
        filterIssues,
      );
      allCandidates.push(...result.candidates);
      phaseErrors["3"] = result.error;
      if (result.rateLimitHit) rateLimitHitDuringSearch = true;
      strategiesUsed.push("maintained");
    }

    // Build result / error summary
    const phasesSkippedForBudget = searchBudget < LOW_BUDGET_THRESHOLD;
    let budgetNote = "";
    if (searchBudget < CRITICAL_BUDGET_THRESHOLD) {
      budgetNote = ` Most search phases were skipped due to critically low API quota (${searchBudget} remaining).`;
    } else if (phasesSkippedForBudget) {
      budgetNote = ` Some search phases were skipped due to low API quota (${searchBudget} remaining).`;
    }

    if (allCandidates.length === 0) {
      const errorDetails = [
        phaseErrors["0"]
          ? `Phase 0 (merged-PR repos): ${phaseErrors["0"]}`
          : null,
        phaseErrors["1"]
          ? `Phase 1 (starred repos): ${phaseErrors["1"]}`
          : null,
        phaseErrors["2"] ? `Phase 2 (general): ${phaseErrors["2"]}` : null,
        phaseErrors["3"]
          ? `Phase 3 (maintained repos): ${phaseErrors["3"]}`
          : null,
      ].filter(Boolean);
      const details =
        errorDetails.length > 0 ? ` ${errorDetails.join(". ")}.` : "";

      if (rateLimitHitDuringSearch || phasesSkippedForBudget) {
        this.rateLimitWarning =
          `Search returned no results due to GitHub API rate limits.${details}${budgetNote} ` +
          `Try again after the rate limit resets.`;
        return { candidates: [], strategiesUsed };
      }

      throw new ValidationError(
        `No issue candidates found across all search phases.${details} ` +
          "Try adjusting your search criteria (languages, labels) or check your network connection.",
      );
    }

    if (rateLimitHitDuringSearch || phasesSkippedForBudget) {
      this.rateLimitWarning =
        `Search results may be incomplete: GitHub API rate limits were hit during search.${budgetNote} ` +
        `Found ${allCandidates.length} candidate${allCandidates.length === 1 ? "" : "s"} but some search phases were limited. ` +
        `Try again after the rate limit resets for complete results.`;
    }

    // Sort by priority, recommendation, then viability score
    allCandidates.sort((a, b) => {
      const priorityOrder: Record<SearchPriority, number> = {
        merged_pr: 0,
        starred: 1,
        normal: 2,
      };
      const priorityDiff =
        priorityOrder[a.searchPriority] - priorityOrder[b.searchPriority];
      if (priorityDiff !== 0) return priorityDiff;

      const recommendationOrder = { approve: 0, needs_review: 1, skip: 2 };
      const recDiff =
        recommendationOrder[a.recommendation] -
        recommendationOrder[b.recommendation];
      if (recDiff !== 0) return recDiff;

      return b.viabilityScore - a.viabilityScore;
    });

    const capped = applyPerRepoCap(allCandidates, 2);

    info(
      MODULE,
      `Search complete: ${tracker.getTotalCalls()} Search API calls used, ${capped.length} candidates returned`,
    );
    return { candidates: capped.slice(0, maxResults), strategiesUsed };
  }

  /**
   * Vet a specific issue for claimability and project health.
   * @param issueUrl - Full GitHub issue URL
   * @returns The vetted issue candidate with recommendation and scores
   * @throws {ValidationError} If the URL is invalid or the issue cannot be fetched
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    return this.vetter.vetIssue(issueUrl);
  }

  /**
   * Derive low-scoring repos from the state reader.
   * A repo is considered "low-scoring" if its score is at or below the threshold.
   */
  private deriveLowScoringRepos(threshold: number): string[] {
    const lowScoring: string[] = [];
    const knownRepos = new Set([
      ...this.stateReader.getReposWithMergedPRs(),
      ...this.stateReader.getStarredRepos(),
    ]);
    for (const repo of knownRepos) {
      const score = this.stateReader.getRepoScore(repo);
      if (score !== null && score <= threshold) {
        lowScoring.push(repo);
      }
    }
    return lowScoring;
  }
}
