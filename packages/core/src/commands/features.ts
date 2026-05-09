/**
 * Features command — surfaces feature opportunities in anchor repos.
 */

import { createScout } from "../scout.js";
import { requireGitHubToken } from "../core/utils.js";
import { saveLocalState } from "../core/local-state.js";
import type { ScoutState } from "../core/schemas.js";
import type { FeatureCandidate } from "../core/feature-discovery.js";

export interface FeaturesOutput {
  quickWins: Array<{
    issue: {
      repo: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: "approve" | "skip" | "needs_review";
    viabilityScore: number;
    horizon: "quick-win";
  }>;
  biggerBets: Array<{
    issue: {
      repo: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: "approve" | "skip" | "needs_review";
    viabilityScore: number;
    horizon: "bigger-bet";
  }>;
  anchorRepos: string[];
  message: string | null;
}

interface FeaturesCommandOptions {
  maxResults: number;
  state?: ScoutState;
}

function mapQuickWin(c: FeatureCandidate): FeaturesOutput["quickWins"][number] {
  return {
    issue: {
      repo: c.issue.repo,
      number: c.issue.number,
      title: c.issue.title,
      url: c.issue.url,
      labels: c.issue.labels,
    },
    recommendation: c.recommendation,
    viabilityScore: c.viabilityScore,
    horizon: "quick-win",
  };
}

function mapBiggerBet(
  c: FeatureCandidate,
): FeaturesOutput["biggerBets"][number] {
  return {
    issue: {
      repo: c.issue.repo,
      number: c.issue.number,
      title: c.issue.title,
      url: c.issue.url,
      labels: c.issue.labels,
    },
    recommendation: c.recommendation,
    viabilityScore: c.viabilityScore,
    horizon: "bigger-bet",
  };
}

export async function runFeatures(
  options: FeaturesCommandOptions,
): Promise<FeaturesOutput> {
  const token = requireGitHubToken();
  const scout = options.state
    ? await createScout({
        githubToken: token,
        persistence: "provided",
        initialState: options.state,
      })
    : await createScout({ githubToken: token });

  const result = await scout.features({ count: options.maxResults });

  saveLocalState(scout.getState() as ScoutState);
  const persisted = await scout.checkpoint();
  if (!persisted) {
    console.error("Warning: changes saved locally but gist sync failed.");
  }

  return {
    quickWins: result.quickWins.map(mapQuickWin),
    biggerBets: result.biggerBets.map(mapBiggerBet),
    anchorRepos: result.anchorRepos,
    message: result.message,
  };
}
