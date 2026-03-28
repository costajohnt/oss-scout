/**
 * Search command — finds contributable issues using multi-strategy search.
 */

import { createScout } from '../scout.js';
import { requireGitHubToken } from '../core/utils.js';

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
}

interface SearchCommandOptions {
  maxResults: number;
}

export async function runSearch(options: SearchCommandOptions): Promise<SearchOutput> {
  const token = requireGitHubToken();
  const scout = await createScout({ githubToken: token });
  const result = await scout.search({ maxResults: options.maxResults });

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
  };
}
