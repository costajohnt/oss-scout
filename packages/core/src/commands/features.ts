/**
 * Features command — surfaces feature opportunities in anchor repos.
 */

import { createScout } from "../scout.js";
import { requireGitHubToken } from "../core/utils.js";
import { saveLocalState } from "../core/local-state.js";
import { isLinkedPRStalled } from "../core/linked-pr.js";
import type { ScoutState } from "../core/schemas.js";
import type { FeatureCandidate } from "../core/feature-discovery.js";

/**
 * Linked-PR metadata surfaced on feature candidates. `isStalled` flags open
 * PRs that haven't been updated for 30+ days — surfaced as revive
 * opportunities (#97). Scoring is unchanged: the existing -30 viability
 * penalty still applies.
 */
interface OutputLinkedPR {
  number: number;
  state: "open" | "closed";
  url: string;
  updatedAt?: string;
  isStalled: boolean;
}

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
    linkedPR?: OutputLinkedPR;
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
    linkedPR?: OutputLinkedPR;
  }>;
  anchorRepos: string[];
  message: string | null;
}

interface FeaturesCommandOptions {
  maxResults: number;
  state?: ScoutState;
  anchorThreshold?: number;
  splitRatio?: number;
}

function mapLinkedPR(c: FeatureCandidate): OutputLinkedPR | undefined {
  const linkedPR = c.vettingResult.linkedPR;
  if (!linkedPR) return undefined;
  return {
    number: linkedPR.number,
    state: linkedPR.state,
    url: linkedPR.url,
    updatedAt: linkedPR.updatedAt,
    isStalled: isLinkedPRStalled(linkedPR),
  };
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
    linkedPR: mapLinkedPR(c),
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
    linkedPR: mapLinkedPR(c),
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

  const result = await scout.features({
    count: options.maxResults,
    anchorThreshold: options.anchorThreshold,
    splitRatio: options.splitRatio,
  });

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
