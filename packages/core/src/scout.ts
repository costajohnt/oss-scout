/**
 * OssScout — the public API for oss-scout.
 *
 * Provides personalized issue discovery, vetting, and scoring.
 * Implements ScoutStateReader to bridge state with the search engine.
 */

import { IssueDiscovery } from "./core/issue-discovery.js";
import type { ScoutStateReader } from "./core/issue-vetting.js";
import { ScoutStateSchema } from "./core/schemas.js";
import type {
  ScoutState,
  ScoutPreferences,
  RepoScore,
  SavedCandidate,
} from "./core/schemas.js";
import type {
  ScoutConfig,
  SearchOptions,
  SearchResult,
  IssueCandidate,
  MergedPRRecord,
  ClosedPRRecord,
  RepoScoreUpdate,
  ProjectCategory,
  VetListOptions,
  VetListResult,
  VetListEntry,
} from "./core/types.js";
import { GistStateStore, mergeStates } from "./core/gist-state-store.js";
import type { GistOctokitLike } from "./core/gist-state-store.js";
import { getOctokit } from "./core/github.js";
import { loadLocalState } from "./core/local-state.js";
import { warn } from "./core/logger.js";
import { extractRepoFromUrl } from "./core/utils.js";

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
 * // Standalone with gist persistence
 * const scout = await createScout({ githubToken: 'ghp_...', persistence: 'gist' });
 *
 * // As a library (host application provides state)
 * const scout = await createScout({
 *   githubToken: 'ghp_...',
 *   persistence: 'provided',
 *   initialState: myState,
 * });
 * ```
 */
export async function createScout(config: ScoutConfig): Promise<OssScout> {
  let state: ScoutState;
  let gistStore: GistStateStore | null = null;

  if (config.persistence === "provided") {
    state = config.initialState;
  } else if (config.persistence === "gist") {
    gistStore = new GistStateStore(
      getOctokit(config.githubToken) as unknown as GistOctokitLike,
    );
    const result = await gistStore.bootstrap();
    if (result.degraded) {
      warn(
        "scout",
        "Gist sync unavailable — running in offline mode. Changes will only be saved locally.",
      );
    }
    const localState = loadLocalState();
    state = mergeStates(localState, result.state);
    if (config.gistId) {
      state.gistId = config.gistId;
    } else if (result.gistId) {
      state.gistId = result.gistId;
    }
  } else {
    state = ScoutStateSchema.parse({ version: 1 });
  }

  return new OssScout(config.githubToken, state, gistStore);
}

/**
 * Main oss-scout class. Provides search, vetting, and state management.
 *
 * Implements ScoutStateReader so the search engine can read state
 * without knowing about the persistence layer.
 */
export class OssScout implements ScoutStateReader {
  private state: ScoutState;
  private dirty = false;

  constructor(
    private githubToken: string,
    initialState: ScoutState,
    private gistStore: GistStateStore | null = null,
  ) {
    this.state = initialState;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Multi-strategy issue search. Returns scored, sorted candidates.
   */
  async search(options?: SearchOptions): Promise<SearchResult> {
    const discovery = new IssueDiscovery(
      this.githubToken,
      this.state.preferences,
      this,
    );
    const { candidates, strategiesUsed } = await discovery.searchIssues({
      maxResults: options?.maxResults,
      strategies: options?.strategies,
    });

    this.state.lastSearchAt = new Date().toISOString();
    this.dirty = true;

    return {
      candidates,
      excludedRepos: this.state.preferences.excludeRepos,
      aiPolicyBlocklist: this.state.preferences.aiPolicyBlocklist,
      rateLimitWarning: discovery.rateLimitWarning ?? undefined,
      strategiesUsed,
    };
  }

  /**
   * Vet a single issue URL for claimability.
   */
  async vetIssue(issueUrl: string): Promise<IssueCandidate> {
    const discovery = new IssueDiscovery(
      this.githubToken,
      this.state.preferences,
      this,
    );
    return discovery.vetIssue(issueUrl);
  }

  // ── Batch Vetting ───────────────────────────────────────────────────

  /**
   * Re-vet all saved results with bounded concurrency.
   * Classifies each as still_available, claimed, has_pr, closed, or error.
   * Optionally prunes unavailable issues from saved results.
   */
  async vetList(options?: VetListOptions): Promise<VetListResult> {
    const saved = this.getSavedResults();
    const concurrency = options?.concurrency ?? 5;
    const results: VetListEntry[] = [];
    const pending = new Map<string, Promise<void>>();

    for (const item of saved) {
      const task = this.vetIssue(item.issueUrl)
        .then((candidate) => {
          results.push({
            issueUrl: item.issueUrl,
            repo: item.repo,
            number: item.number,
            title: item.title,
            status: this.classifyVetResult(candidate),
            recommendation: candidate.recommendation,
            viabilityScore: candidate.viabilityScore,
          });
        })
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          const isGone = msg.includes("Not Found") || msg.includes("410");
          results.push({
            issueUrl: item.issueUrl,
            repo: item.repo,
            number: item.number,
            title: item.title,
            status: isGone ? "closed" : "error",
            errorMessage: msg,
          });
        })
        .finally(() => {
          pending.delete(item.issueUrl);
        });

      pending.set(item.issueUrl, task);
      if (pending.size >= concurrency) {
        await Promise.race(pending.values());
      }
    }
    await Promise.allSettled(pending.values());

    const summary = {
      total: results.length,
      stillAvailable: results.filter((r) => r.status === "still_available")
        .length,
      claimed: results.filter((r) => r.status === "claimed").length,
      closed: results.filter((r) => r.status === "closed").length,
      hasPR: results.filter((r) => r.status === "has_pr").length,
      errors: results.filter((r) => r.status === "error").length,
    };

    let prunedCount: number | undefined;
    if (options?.prune) {
      const unavailableUrls = new Set(
        results
          .filter((r) => r.status !== "still_available")
          .map((r) => r.issueUrl),
      );
      const before = (this.state.savedResults ?? []).length;
      this.state.savedResults = (this.state.savedResults ?? []).filter(
        (r) => !unavailableUrls.has(r.issueUrl),
      );
      prunedCount = before - (this.state.savedResults?.length ?? 0);
      this.dirty = true;
    }

    return { results, summary, prunedCount };
  }

  private classifyVetResult(candidate: IssueCandidate): VetListEntry["status"] {
    const checks = candidate.vettingResult.checks;
    if (!checks.noExistingPR) return "has_pr";
    if (!checks.notClaimed) return "claimed";
    return "still_available";
  }

  // ── State Reads (ScoutStateReader implementation) ───────────────────

  getReposWithMergedPRs(): string[] {
    const repoCounts = new Map<string, number>();
    for (const pr of this.state.mergedPRs ?? []) {
      const repo = extractRepoFromUrl(pr.url);
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

    this.state.mergedPRs = [
      ...existing,
      { url: pr.url, title: pr.title, mergedAt: pr.mergedAt },
    ];
    this.updateRepoScoreFromPRs(pr.repo);
    this.dirty = true;
  }

  /**
   * Record that a PR was closed without merge.
   */
  recordClosedPR(pr: ClosedPRRecord): void {
    const existing = this.state.closedPRs ?? [];
    if (existing.some((p) => p.url === pr.url)) return;

    this.state.closedPRs = [
      ...existing,
      { url: pr.url, title: pr.title, closedAt: pr.closedAt },
    ];
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
      signals: {
        hasActiveMaintainers: false,
        isResponsive: false,
        hasHostileComments: false,
      },
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

  // ── Saved Results ───────────────────────────────────────────────────

  /**
   * Save search candidates to state, deduplicating by URL.
   * If a candidate already exists, updates score/recommendation/lastSeenAt
   * but preserves firstSeenAt.
   */
  saveResults(candidates: IssueCandidate[]): void {
    const now = new Date().toISOString();
    const existing = new Map(
      (this.state.savedResults ?? []).map((r) => [r.issueUrl, r]),
    );

    for (const c of candidates) {
      const prev = existing.get(c.issue.url);
      existing.set(c.issue.url, {
        issueUrl: c.issue.url,
        repo: c.issue.repo,
        number: c.issue.number,
        title: c.issue.title,
        labels: c.issue.labels,
        recommendation: c.recommendation,
        viabilityScore: c.viabilityScore,
        searchPriority: c.searchPriority,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastSeenAt: now,
        lastScore: c.viabilityScore,
      });
    }

    this.state.savedResults = [...existing.values()];
    this.dirty = true;
  }

  /**
   * Get all saved results.
   */
  getSavedResults(): SavedCandidate[] {
    return this.state.savedResults ?? [];
  }

  /**
   * Clear all saved results.
   */
  clearResults(): void {
    this.state.savedResults = [];
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
   * Pushes to gist if gist persistence is configured.
   */
  async checkpoint(): Promise<boolean> {
    if (!this.dirty) return true;
    this.state.lastRunAt = new Date().toISOString();

    if (this.gistStore) {
      const ok = await this.gistStore.push(this.state);
      if (!ok) return false;
    }

    this.dirty = false;
    return true;
  }

  /**
   * Get the full state snapshot for serialization or external consumption.
   */
  getState(): Readonly<ScoutState> {
    return this.state;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private updateRepoScoreFromPRs(repo: string): void {
    const mergedCount = (this.state.mergedPRs ?? []).filter(
      (p) => extractRepoFromUrl(p.url) === repo,
    ).length;
    const closedCount = (this.state.closedPRs ?? []).filter(
      (p) => extractRepoFromUrl(p.url) === repo,
    ).length;

    this.updateRepoScore(repo, {
      mergedPRCount: mergedCount,
      closedWithoutMergeCount: closedCount,
      lastMergedAt:
        mergedCount > 0
          ? (this.state.mergedPRs ?? [])
              .filter((p) => extractRepoFromUrl(p.url) === repo)
              .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0]?.mergedAt
          : undefined,
    });
  }

  /**
   * Calculate repo score (1-10) from observed data.
   * base 5, +1 per merged PR (max +3), -1 per closed-without-merge (max -3),
   * +1 responsive, +1 active maintainers, -2 hostile comments, clamped 1-10
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
