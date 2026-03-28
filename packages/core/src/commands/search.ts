/**
 * Search command — finds contributable issues using multi-strategy search.
 */

import { createScout } from '../scout.js';
import { requireGitHubToken } from '../core/utils.js';
import { saveLocalState } from '../core/local-state.js';
import type { ScoutState, SearchStrategy } from '../core/schemas.js';

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
    recommendation: 'approve' | 'skip' | 'needs_review';
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
}

export async function runSearch(options: SearchCommandOptions): Promise<SearchOutput> {
  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({ githubToken: token, persistence: 'provided', initialState: options.state })
    : await createScout({ githubToken: token });
  const result = await scout.search({ maxResults: options.maxResults, strategies: options.strategies });

  // Persist results to local state
  scout.saveResults(result.candidates);
  saveLocalState(scout.getState() as ScoutState);

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
      };
    }),
    excludedRepos: result.excludedRepos,
    aiPolicyBlocklist: result.aiPolicyBlocklist,
    rateLimitWarning: result.rateLimitWarning,
    strategiesUsed: result.strategiesUsed,
  };
}
