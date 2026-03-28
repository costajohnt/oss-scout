/**
 * OssScout — the public API for oss-scout.
 *
 * Provides personalized issue discovery, vetting, and scoring.
 * Implements ScoutStateReader to bridge state with the search engine.
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './core/github.js';
import { IssueDiscovery } from './core/issue-discovery.js';
import type { ScoutStateReader } from './core/issue-vetting.js';
import { ScoutStateSchema } from './core/schemas.js';
import type {
  ScoutState,
  ScoutPreferences,
  RepoScore,
  StoredMergedPR,
  StoredClosedPR,
} from './core/schemas.js';
import type {
  ScoutConfig,
  SearchOptions,
  SearchResult,
  VetListOptions,
  IssueCandidate,
  MergedPRRecord,
  ClosedPRRecord,
  RepoScoreUpdate,
  ProjectCategory,
} from './core/types.js';
import { splitRepo } from './core/utils.js';

/**
 * Create an OssScout instance.
 *
 * @param config - Configuration including GitHub token and persistence mode
 * @returns A ready-to-use OssScout instance
 *
 * @example
 * ```typescript
 * import { createScout } from '@oss-scout/core';
 *
 * // Standalone with gist persistence (default)
 * const scout = await createScout({ githubToken: 'ghp_...' });
 *
 * // As a library (OSS Autopilot provides state)
 * const scout = await createScout({
 *   githubToken: 'ghp_...',
 *   persistence: 'provided',
 *   initialState: myState,
 * });
 * ```
 */
export async function createScout(config: ScoutConfig): Promise<OssScout> {
  let state: ScoutState;

  if (config.persistence === 'provided') {
    if (!config.initialState) {
      throw new Error('initialState is required when persistence is "provided"');
    }
    state = config.initialState;
  } else {
    // Default: use local state for now (gist persistence added in Phase 3)
    state = ScoutStateSchema.parse({ version: 1 });
  }

  return new OssScout(config.githubToken, state);
}

/**
 * Main oss-scout class. Provides search, vetting, and state management.
 *
 * Implements ScoutStateReader so the search engine can read state
 * without knowing about the persistence layer.
 */
export class OssScout implements ScoutStateReader {
  private octokit: Octokit;
  private state: ScoutState;
  private dirty = false;

  constructor(
    private githubToken: string,
    initialState: ScoutState,
  ) {
    this.octokit = getOctokit(githubToken);
    this.state = initialState;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Multi-strategy issue search. Returns scored, sorted candidates.
   */
  async search(options?: SearchOptions): Promise<SearchResult> {
    const discovery = new IssueDiscovery(this.githubToken, this.state.preferences, this);
    const candidates = await discovery.searchIssues({
      maxResults: options?.maxResults,
    });

    this.state.lastSearchAt = new Date().toISOString();
    this.dirty = true;

    return {
      candidates,
      excludedRepos: this.state.preferences.excludeRepos,
      aiPolicyBlocklist: this.state.preferences.aiPolicyBlocklist,
      rateLimitWarning: discovery.rateLimitWarning ?? undefined,
    };
  }

  /**
   * Vet a single issue URL for claimability.
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    const discovery = new IssueDiscovery(this.githubToken, this.state.preferences, this);
    return discovery.vetIssue(issueUrl);
  }

  // ── State Reads (ScoutStateReader implementation) ───────────────────

  getReposWithMergedPRs(): string[] {
    const repoCounts = new Map<string, number>();
    for (const pr of this.state.mergedPRs ?? []) {
      const repo = this.extractRepoFromUrl(pr.url);
      if (repo) {
        repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
      }
    }
    // Sort by count descending
    return [...repoCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([repo]) => repo);
  }

  getStarredRepos(): string[] {
    return this.state.starredRepos;
  }

  getPreferredOrgs(): string[] {
    return this.state.preferences.preferredOrgs;
  }

  getProjectCategories(): ProjectCategory[] {
    return this.state.preferences.projectCategories;
  }

  getRepoScore(repo: string): number | null {
    const score = this.state.repoScores[repo];
    return score ? score.score : null;
  }

  /** Get current preferences (read-only). */
  getPreferences(): Readonly<ScoutPreferences> {
    return this.state.preferences;
  }

  /** Get repo score record for a specific repository. */
  getRepoScoreRecord(repo: string): Readonly<RepoScore> | undefined {
    return this.state.repoScores[repo];
  }

  // ── State Mutations ─────────────────────────────────────────────────

  /**
   * Record that a PR was merged in this repo.
   * Updates the merged PRs list and recalculates the repo score.
   */
  recordMergedPR(pr: MergedPRRecord): void {
    const existing = this.state.mergedPRs ?? [];
    // Deduplicate by URL
    if (existing.some((p) => p.url === pr.url)) return;

    this.state.mergedPRs = [...existing, { url: pr.url, title: pr.title, mergedAt: pr.mergedAt }];
    this.updateRepoScoreFromPRs(pr.repo);
    this.dirty = true;
  }

  /**
   * Record that a PR was closed without merge.
   */
  recordClosedPR(pr: ClosedPRRecord): void {
    const existing = this.state.closedPRs ?? [];
    if (existing.some((p) => p.url === pr.url)) return;

    this.state.closedPRs = [...existing, { url: pr.url, title: pr.title, closedAt: pr.closedAt }];
    this.updateRepoScoreFromPRs(pr.repo);
    this.dirty = true;
  }

  /**
   * Update repo score with observed signals.
   */
  updateRepoScore(repo: string, update: Partial<RepoScoreUpdate>): void {
    const existing = this.state.repoScores[repo];
    const base: RepoScore = existing ?? {
      repo,
      score: 5,
      mergedPRCount: 0,
      closedWithoutMergeCount: 0,
      avgResponseDays: null,
      lastEvaluatedAt: new Date().toISOString(),
      signals: { hasActiveMaintainers: false, isResponsive: false, hasHostileComments: false },
    };

    const updated: RepoScore = {
      ...base,
      ...update,
      repo,
      lastEvaluatedAt: new Date().toISOString(),
      signals: { ...base.signals, ...(update.signals ?? {}) },
    };

    // Recalculate score
    updated.score = this.calculateScore(updated);
    this.state.repoScores[repo] = updated;
    this.dirty = true;
  }

  /**
   * Update user preferences.
   */
  updatePreferences(updates: Partial<ScoutPreferences>): void {
    this.state.preferences = { ...this.state.preferences, ...updates };
    this.dirty = true;
  }

  /**
   * Update starred repos cache.
   */
  setStarredRepos(repos: string[]): void {
    this.state.starredRepos = repos;
    this.state.starredReposLastFetched = new Date().toISOString();
    this.dirty = true;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Check if state has uncommitted changes.
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Push pending changes to the persistence layer.
   * Currently a no-op placeholder — gist persistence added in Phase 3.
   */
  async checkpoint(): Promise<boolean> {
    if (!this.dirty) return true;
    // Phase 3: push to gist here
    this.state.lastRunAt = new Date().toISOString();
    this.dirty = false;
    return true;
  }

  /**
   * Get the full state snapshot (for OSS Autopilot to read or for serialization).
   */
  getState(): Readonly<ScoutState> {
    return this.state;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private extractRepoFromUrl(url: string): string | null {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\//);
    return match ? match[1] : null;
  }

  private updateRepoScoreFromPRs(repo: string): void {
    const mergedCount = (this.state.mergedPRs ?? []).filter(
      (p) => this.extractRepoFromUrl(p.url) === repo,
    ).length;
    const closedCount = (this.state.closedPRs ?? []).filter(
      (p) => this.extractRepoFromUrl(p.url) === repo,
    ).length;

    this.updateRepoScore(repo, {
      mergedPRCount: mergedCount,
      closedWithoutMergeCount: closedCount,
      lastMergedAt: mergedCount > 0
        ? (this.state.mergedPRs ?? [])
            .filter((p) => this.extractRepoFromUrl(p.url) === repo)
            .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0]?.mergedAt
        : undefined,
    });
  }

  /**
   * Calculate repo score (1-10) from observed data.
   * Scoring: base 5, +1 per merged PR (max +3), -1 per closed-without-merge,
   * +1 for responsive, +1 for active maintainers, clamped 1-10.
   */
  private calculateScore(repoScore: RepoScore): number {
    let score = 5;
    score += Math.min(repoScore.mergedPRCount, 3);
    score -= Math.min(repoScore.closedWithoutMergeCount, 3);
    if (repoScore.signals.isResponsive) score += 1;
    if (repoScore.signals.hasActiveMaintainers) score += 1;
    if (repoScore.signals.hasHostileComments) score -= 2;
    return Math.max(1, Math.min(10, score));
  }
}
