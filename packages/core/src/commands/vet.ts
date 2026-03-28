/**
 * Vet command — vets a specific issue for claimability.
 */

import { createScout } from '../scout.js';
import { requireGitHubToken } from '../core/utils.js';
import type { ProjectHealth } from '../core/types.js';
import type { IssueVettingResult, ScoutState } from '../core/schemas.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface VetOutput {
  issue: {
    repo: string;
    number: number;
    title: string;
    url: string;
    labels: string[];
  };
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToApprove: string[];
  reasonsToSkip: string[];
  projectHealth: ProjectHealth;
  vettingResult: IssueVettingResult;
}

interface VetCommandOptions {
  issueUrl: string;
  state?: ScoutState;
}

export async function runVet(options: VetCommandOptions): Promise<VetOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({ githubToken: token, persistence: 'provided', initialState: options.state })
    : await createScout({ githubToken: token });
  const candidate = await scout.vetIssue(options.issueUrl);

  return {
    issue: {
      repo: candidate.issue.repo,
      number: candidate.issue.number,
      title: candidate.issue.title,
      url: candidate.issue.url,
      labels: candidate.issue.labels,
    },
    recommendation: candidate.recommendation,
    reasonsToApprove: candidate.reasonsToApprove,
    reasonsToSkip: candidate.reasonsToSkip,
    projectHealth: candidate.projectHealth,
    vettingResult: candidate.vettingResult,
  };
}
