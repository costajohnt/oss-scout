/**
 * Search command — finds contributable issues using multi-strategy search.
 */

import { createScout } from "../scout.js";
import { requireGitHubToken } from "../core/utils.js";
import { saveLocalState } from "../core/local-state.js";
import { isLinkedPRStalled } from "../core/linked-pr.js";
import type { ScoutState, SearchStrategy } from "../core/schemas.js";

export interface SearchOutput {
  candidates: Array<{
    issue: {
      repo: string;
      repoUrl: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: "approve" | "skip" | "needs_review";
    reasonsToApprove: string[];
    reasonsToSkip: string[];
    searchPriority: string;
    viabilityScore: number;
    repoScore?: {
      score: number;
      mergedPRCount: number;
      closedWithoutMergeCount: number;
      isResponsive: boolean;
      lastMergedAt?: string;
    };
    /**
     * Metadata for the first cross-referenced PR linked to this issue, when
     * one exists. `isStalled` flags open PRs that haven't been updated for
     * 30+ days — surfaced as revive opportunities (#97). Scoring is
     * unchanged: the existing -30 viability penalty still applies.
     */
    linkedPR?: {
      number: number;
      state: "open" | "closed";
      url: string;
      updatedAt?: string;
      isStalled: boolean;
    };
    /**
     * Personalization sort-tier signal (#1244). Present only when the
     * caller passed `preferLanguages` / `preferRepos` *and* this
     * candidate matched at least one of them. `boostReasons` is the
     * human-readable explanation (e.g. `"repo affinity: vercel/next.js"`).
     */
    boostScore?: number;
    boostReasons?: string[];
  }>;
  excludedRepos: string[];
  aiPolicyBlocklist: string[];
  rateLimitWarning?: string;
  strategiesUsed: SearchStrategy[];
}

interface SearchCommandOptions {
  maxResults: number;
  state?: ScoutState;
  strategies?: SearchStrategy[];
  /** Soft sort boost for candidates whose repo language matches (#1244). */
  preferLanguages?: string[];
  /** Soft sort boost for candidates in these `owner/repo` slugs (#1244). */
  preferRepos?: string[];
}

export async function runSearch(
  options: SearchCommandOptions,
): Promise<SearchOutput> {
  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({
        githubToken: token,
        persistence: "provided",
        initialState: options.state,
      })
    : await createScout({ githubToken: token });
  const result = await scout.search({
    maxResults: options.maxResults,
    strategies: options.strategies,
    preferLanguages: options.preferLanguages,
    preferRepos: options.preferRepos,
  });

  // Persist results to local state and gist
  scout.saveResults(result.candidates);
  saveLocalState(scout.getState() as ScoutState);
  const persisted = await scout.checkpoint();
  if (!persisted) {
    console.error("Warning: changes saved locally but gist sync failed.");
  }

  return {
    candidates: result.candidates.map((c) => {
      const repoScoreRecord = scout.getRepoScoreRecord(c.issue.repo);
      return {
        issue: {
          repo: c.issue.repo,
          repoUrl: `https://github.com/${c.issue.repo}`,
          number: c.issue.number,
          title: c.issue.title,
          url: c.issue.url,
          labels: c.issue.labels,
        },
        recommendation: c.recommendation,
        reasonsToApprove: c.reasonsToApprove,
        reasonsToSkip: c.reasonsToSkip,
        searchPriority: c.searchPriority,
        viabilityScore: c.viabilityScore,
        repoScore: repoScoreRecord
          ? {
              score: repoScoreRecord.score,
              mergedPRCount: repoScoreRecord.mergedPRCount,
              closedWithoutMergeCount: repoScoreRecord.closedWithoutMergeCount,
              isResponsive: repoScoreRecord.signals?.isResponsive ?? false,
              lastMergedAt: repoScoreRecord.lastMergedAt,
            }
          : undefined,
        linkedPR: c.vettingResult.linkedPR
          ? {
              number: c.vettingResult.linkedPR.number,
              state: c.vettingResult.linkedPR.state,
              url: c.vettingResult.linkedPR.url,
              updatedAt: c.vettingResult.linkedPR.updatedAt,
              isStalled: isLinkedPRStalled(c.vettingResult.linkedPR),
            }
          : undefined,
        boostScore: c.boostScore,
        boostReasons: c.boostReasons,
      };
    }),
    excludedRepos: result.excludedRepos,
    aiPolicyBlocklist: result.aiPolicyBlocklist,
    rateLimitWarning: result.rateLimitWarning,
    strategiesUsed: result.strategiesUsed,
  };
}
