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
  SkippedIssue,
} from "./core/schemas.js";
import type {
  ScoutConfig,
  SearchOptions,
  SearchResult,
  IssueCandidate,
  MergedPRRecord,
  ClosedPRRecord,
  OpenPRRecord,
  RepoScoreUpdate,
  ProjectCategory,
  VetListOptions,
  VetListResult,
  VetListEntry,
} from "./core/types.js";
import { GistStateStore, mergeStates } from "./core/gist-state-store.js";
import type {
  DegradedReason,
  GistOctokitLike,
} from "./core/gist-state-store.js";
import { getOctokit } from "./core/github.js";
import type { Octokit } from "@octokit/rest";
import { loadLocalState } from "./core/local-state.js";
import { warn } from "./core/logger.js";
import { extractRepoFromUrl } from "./core/utils.js";
import {
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
} from "./core/errors.js";

/** Cause-specific user-facing message for degraded (offline) mode. */
function offlineModeMessage(reason: DegradedReason | undefined): string {
  const tail = "Changes will only be saved locally.";
  switch (reason) {
    case "rate_limit":
      return `Gist sync unavailable — GitHub API rate limit exceeded. ${tail} Try again after the rate limit resets.`;
    case "network":
      return `Gist sync unavailable — could not reach GitHub. ${tail} Check your network connection.`;
    case "server":
      return `Gist sync unavailable — GitHub returned a server error. ${tail} Try again later.`;
    case "unknown":
    case undefined:
      return `Gist sync unavailable — running in offline mode. ${tail}`;
  }
}

/** Wrap a real Octokit instance as GistOctokitLike without unsafe double casts. */
function toGistOctokit(octokit: Octokit): GistOctokitLike {
  return {
    gists: {
      async get(params) {
        const { data } = await octokit.gists.get(params);
        if (!data.id) throw new Error("Gist get returned no id");
        const files: Record<string, { content?: string } | undefined> | null =
          data.files
            ? Object.fromEntries(
                Object.entries(data.files).map(([k, v]) => [
                  k,
                  v ? { content: v.content } : undefined,
                ]),
              )
            : null;
        return { data: { id: data.id, files } };
      },
      async create(params) {
        const { data } = await octokit.gists.create(params);
        if (!data.id) throw new Error("Gist create returned no id");
        return { data: { id: data.id } };
      },
      async update(params) {
        const { data } = await octokit.gists.update(params);
        if (!data.id) throw new Error("Gist update returned no id");
        return { data: { id: data.id } };
      },
      async list(params) {
        const { data } = await octokit.gists.list(params);
        return {
          data: data
            .filter((g) => g.id)
            .map((g) => ({
              id: g.id,
              description: g.description ?? null,
            })),
        };
      },
    },
  };
}

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
      toGistOctokit(getOctokit(config.githubToken)),
    );
    const result = await gistStore.bootstrap();
    if (result.degraded) {
      warn("scout", offlineModeMessage(result.degradedReason));
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
   * Automatically culls expired skip entries and filters skipped issues.
   */
  async search(options?: SearchOptions): Promise<SearchResult> {
    // Auto-cull expired skips before searching
    this.cullExpiredSkips();

    const skippedUrls = new Set(
      (this.state.skippedIssues ?? []).map((s) => s.url),
    );
    const discovery = new IssueDiscovery(
      this.githubToken,
      this.state.preferences,
      this,
    );
    const { candidates, strategiesUsed } = await discovery.searchIssues({
      maxResults: options?.maxResults,
      strategies: options?.strategies,
      skippedUrls,
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
    // First 401 OR rate-limit short-circuits the whole batch. Unlike
    // vetIssuesParallel (which has a batch-level rateLimitHit flag the
    // search orchestrator surfaces via rateLimitWarning), vetList is the
    // user-facing CLI entry point — N rows of "rate limit exceeded" is the
    // exact silent-failure mode the documented strategy aims to prevent.
    let firstHardError: unknown = null;

    for (const item of saved) {
      if (firstHardError) break;
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
          if (getHttpStatusCode(error) === 401 || isRateLimitError(error)) {
            firstHardError ??= error;
            return;
          }
          const status = getHttpStatusCode(error);
          const isGone = status === 404 || status === 410;
          results.push({
            issueUrl: item.issueUrl,
            repo: item.repo,
            number: item.number,
            title: item.title,
            status: isGone ? "closed" : "error",
            errorMessage: errorMessage(error),
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

    if (firstHardError) {
      if (results.length > 0) {
        warn(
          "scout",
          `vetList aborted mid-batch after ${results.length} result(s) — discarding partial results due to auth/rate-limit failure`,
        );
      }
      throw firstHardError;
    }

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

  getReposWithOpenPRs(): string[] {
    const repoCounts = new Map<string, number>();
    for (const pr of this.state.openPRs ?? []) {
      const repo = extractRepoFromUrl(pr.url);
      if (repo) {
        repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
      }
    }
    return [...repoCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([repo]) => repo);
  }

  getStarredRepos(): string[] {
    return this.state.starredRepos;
  }

  getProjectCategories(): ProjectCategory[] {
    return this.state.preferences.projectCategories;
  }

  getRepoScore(repo: string): number | null {
    const score = this.state.repoScores[repo];
    return score ? score.score : null;
  }

  /**
   * Optional SLM pre-triage config read from preferences (oss-autopilot#1122).
   * Empty `model` disables the call; the vetter treats it as a no-op.
   */
  getSLMTriageConfig(): { model: string; host: string } {
    return {
      model: this.state.preferences.slmTriageModel ?? "",
      host: this.state.preferences.slmTriageHost ?? "",
    };
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
   * Record that a PR is currently open in this repo.
   * Open PRs signal active engagement even when nothing is merged yet.
   */
  recordOpenPR(pr: OpenPRRecord): void {
    const existing = this.state.openPRs ?? [];
    if (existing.some((p) => p.url === pr.url)) return;

    this.state.openPRs = [
      ...existing,
      { url: pr.url, title: pr.title, openedAt: pr.openedAt },
    ];
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

  // ── Skip List ───────────────────────────────────────────────────────

  /**
   * Skip an issue — excludes it from future searches. Auto-culled after 90 days.
   */
  skipIssue(
    url: string,
    metadata?: { repo?: string; number?: number; title?: string },
  ): void {
    const existing = this.state.skippedIssues ?? [];
    if (existing.some((s) => s.url === url)) return; // already skipped
    this.state.skippedIssues = [
      ...existing,
      {
        url,
        repo: metadata?.repo ?? "",
        number: metadata?.number ?? 0,
        title: metadata?.title ?? "",
        skippedAt: new Date().toISOString(),
      },
    ];
    // Also remove from saved results if present
    if (this.state.savedResults) {
      this.state.savedResults = this.state.savedResults.filter(
        (r) => r.issueUrl !== url,
      );
    }
    this.dirty = true;
  }

  /**
   * Get all skipped issues.
   */
  getSkippedIssues(): SkippedIssue[] {
    return this.state.skippedIssues ?? [];
  }

  /**
   * Remove a specific issue from the skip list.
   */
  unskipIssue(url: string): void {
    this.state.skippedIssues = (this.state.skippedIssues ?? []).filter(
      (s) => s.url !== url,
    );
    this.dirty = true;
  }

  /**
   * Clear all skipped issues.
   */
  clearSkippedIssues(): void {
    this.state.skippedIssues = [];
    this.dirty = true;
  }

  /**
   * Remove skipped issues older than maxDays (default 90). Called automatically during search.
   * @returns The number of expired entries that were removed.
   */
  cullExpiredSkips(maxDays: number = 90): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    const before = (this.state.skippedIssues ?? []).length;
    this.state.skippedIssues = (this.state.skippedIssues ?? []).filter((s) => {
      const d = new Date(s.skippedAt);
      if (isNaN(d.getTime())) {
        return true; // keep entries with invalid dates rather than silently dropping
      }
      return d >= cutoff;
    });
    const culled = before - this.state.skippedIssues.length;
    if (culled > 0) this.dirty = true;
    return culled;
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
