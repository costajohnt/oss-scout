/**
 * OssScout — the public API for oss-scout.
 *
 * Provides personalized issue discovery, vetting, and scoring.
 * Implements ScoutStateReader to bridge state with the search engine.
 */

import { IssueDiscovery } from "./core/issue-discovery.js";
import { IssueVetter } from "./core/issue-vetting.js";
import type {
  ScoutStateReader,
  ScoutStateWriter,
  SLMConfig,
} from "./core/issue-vetting.js";
import {
  discoverFeatures,
  discoverFeaturesBroad,
  type FeatureSearchResult,
} from "./core/feature-discovery.js";
import type {
  ScoutState,
  ScoutPreferences,
  RepoScore,
  SavedCandidate,
  SkippedIssue,
  Horizon,
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
  ProjectHealth,
  SyncResult,
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
import { loadLocalState, saveLocalState } from "./core/local-state.js";
import { warn, setLogLevel } from "./core/logger.js";
import { extractRepoFromUrl, parseGitHubUrl } from "./core/utils.js";
import {
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
  rethrowIfFatal,
} from "./core/errors.js";
import { getHttpCache } from "./core/http-cache.js";

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
  // Apply the host's log-level preference before any bootstrap chatter (#156).
  if (config.logLevel !== undefined) {
    setLogLevel(config.logLevel);
  }

  let state: ScoutState;
  let gistStore: GistStateStore | null = null;

  let persistLocal = false;

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
    // Default: local-file persistence. The previous else-branch silently
    // created throwaway in-memory state, so a documented standalone scout
    // (and the MCP server) read no preferences and persisted nothing while
    // checkpoint() reported success (#116). Load the real state and save it
    // on checkpoint.
    state = loadLocalState();
    persistLocal = true;
  }

  return new OssScout(config.githubToken, state, gistStore, { persistLocal });
}

/**
 * Main oss-scout class. Provides search, vetting, and state management.
 *
 * Implements ScoutStateReader so the search engine can read state
 * without knowing about the persistence layer.
 */
export class OssScout implements ScoutStateReader, ScoutStateWriter {
  private state: ScoutState;
  private dirty = false;

  /** When true, checkpoint() also writes ~/.oss-scout/state.json. */
  private persistLocal: boolean;

  constructor(
    private githubToken: string,
    initialState: ScoutState,
    private gistStore: GistStateStore | null = null,
    opts: { persistLocal?: boolean } = {},
  ) {
    this.state = initialState;
    this.persistLocal = opts.persistLocal ?? false;
  }

  // ── Search ──────────────────────────────────────────────────────────

  /**
   * Drop stale disk-cache entries. Called at the top of every cache-burning
   * entry point (search, features, vetList); without it ~/.oss-scout/cache
   * grows without bound. evictStale never throws (fs errors degrade to warn).
   */
  private evictStaleCacheEntries(): void {
    getHttpCache().evictStale();
  }

  /**
   * Multi-strategy issue search. Returns scored, sorted candidates.
   * Automatically culls expired skip entries and filters skipped issues.
   */
  async search(options?: SearchOptions): Promise<SearchResult> {
    this.evictStaleCacheEntries();

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
    // Per-call flags override the persisted personalization defaults (#168).
    // An empty preference array reads as "no boost" just like an absent flag.
    const prefs = this.state.preferences;
    const prefLangs = prefs.preferLanguages ?? [];
    const prefRepos = prefs.preferRepos ?? [];
    const preferLanguages =
      options?.preferLanguages ??
      (prefLangs.length > 0 ? prefLangs : undefined);
    const preferRepos =
      options?.preferRepos ?? (prefRepos.length > 0 ? prefRepos : undefined);
    const diversityRatio = options?.diversityRatio ?? prefs.diversityRatio ?? 0;

    const { candidates, strategiesUsed } = await discovery.searchIssues({
      maxResults: options?.maxResults,
      strategies: options?.strategies,
      skippedUrls,
      preferLanguages,
      preferRepos,
      diversityRatio,
      interPhaseDelayMs: options?.interPhaseDelayMs,
      broadPhaseDelayMs: options?.broadPhaseDelayMs,
    });

    // Feed the freshly observed maintainer-responsiveness signals back into the
    // repo scores so the next search ranks responsive/active repos higher (#167).
    for (const c of candidates) {
      this.updateRepoSignalsFromHealth(c.projectHealth);
    }

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
   * Populate the `hasActiveMaintainers` repo-score signal from a freshly
   * computed projectHealth (#167). It was initialized false and never set, so
   * calculateScore's +1 active-maintainers weight was inert; `isActive`
   * (recent commit activity) is a real, already-computed proxy.
   *
   * `isResponsive` and `avgResponseDays` are deliberately NOT set here:
   * `projectHealth.avgIssueResponseDays` is a hardcoded `0` placeholder
   * (repo-health.ts), so deriving responsiveness from it would award +1 to
   * every repo — a fake signal worse than the inert one. Real responsiveness
   * needs an actual response-time measurement (extra API calls), deferred.
   * `hasHostileComments` likewise stays a host-settable capability (it needs
   * comment sentiment, out of scope). A failed health check is skipped so its
   * neutral-default fields don't pollute the score.
   */
  private updateRepoSignalsFromHealth(health: ProjectHealth): void {
    if (health.checkFailed) return;
    this.updateRepoScore(health.repo, {
      signals: { hasActiveMaintainers: health.isActive },
    });
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

  /**
   * `scout features` — surfaces feature-scoped contribution opportunities
   * in repos where the user has 3+ merged PRs (configurable via
   * `featuresAnchorThreshold`), ranked into separate "quick wins" and
   * "bigger bets" buckets (split via `featuresSplitRatio`).
   *
   * Per-call `anchorThreshold` and `splitRatio` overrides take precedence
   * over the persisted preferences.
   *
   * When `broad` is true (#100), bypasses anchor resolution and runs a
   * cross-repo GitHub Search query for first-touch contributors who
   * haven't yet built repo relationships. Filters by user language
   * preferences and excluded repos/orgs.
   */
  async features(options?: {
    count?: number;
    anchorThreshold?: number;
    splitRatio?: number;
    broad?: boolean;
  }): Promise<FeatureSearchResult> {
    this.evictStaleCacheEntries();
    const count = options?.count ?? 10;
    const octokit = getOctokit(this.githubToken);
    const vetter = new IssueVetter(octokit, this);
    const result = options?.broad
      ? await discoverFeaturesBroad({
          octokit,
          vetter,
          count,
          languages: this.state.preferences.languages,
          excludeRepos: this.state.preferences.excludeRepos,
          excludeOrgs: this.state.preferences.excludeOrgs,
          splitRatio:
            options?.splitRatio ?? this.state.preferences.featuresSplitRatio,
        })
      : await discoverFeatures({
          octokit,
          vetter,
          repoScores: this.state.repoScores ?? {},
          count,
          anchorThreshold:
            options?.anchorThreshold ??
            this.state.preferences.featuresAnchorThreshold,
          splitRatio:
            options?.splitRatio ?? this.state.preferences.featuresSplitRatio,
        });

    this.saveResults([...result.quickWins, ...result.biggerBets]);
    this.state.lastSearchAt = new Date().toISOString();
    this.dirty = true;

    return result;
  }

  // ── Batch Vetting ───────────────────────────────────────────────────

  /**
   * Re-vet all saved results with bounded concurrency.
   * Classifies each as still_available, claimed, has_pr, closed, or error.
   * Optionally prunes unavailable issues from saved results.
   */
  async vetList(options?: VetListOptions): Promise<VetListResult> {
    this.evictStaleCacheEntries();
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
            ok: true,
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
            ok: false,
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

    // Claim-watch (#165): compare each result's current status to the status
    // recorded on the saved result last time, then persist the new status so
    // the next run can diff again. "error" is transient — never a transition
    // target and never stored.
    const prevStatus = new Map(
      (this.state.savedResults ?? []).map((r) => [r.issueUrl, r.lastStatus]),
    );
    const transitions = results
      .filter((r) => r.status !== "error")
      .filter((r) => {
        const prev = prevStatus.get(r.issueUrl);
        return prev !== undefined && prev !== r.status;
      })
      .map((r) => ({
        issueUrl: r.issueUrl,
        repo: r.repo,
        number: r.number,
        from: prevStatus.get(r.issueUrl)!,
        to: r.status,
      }));

    const currentStatus = new Map(results.map((r) => [r.issueUrl, r.status]));
    for (const saved of this.state.savedResults ?? []) {
      const status = currentStatus.get(saved.issueUrl);
      if (status !== undefined && status !== "error") {
        saved.lastStatus = status;
      }
    }
    if (results.length > 0) this.dirty = true;

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
      if (prunedCount > 0) this.addTombstones([...unavailableUrls]);
      this.dirty = true;
    }

    return { results, summary, prunedCount, transitions };
  }

  private classifyVetResult(candidate: IssueCandidate): VetListEntry["status"] {
    // Closed wins over everything: GitHub returns 200 for closed issues, so
    // the 404/410 catch path alone never saw them (#120). Candidates cached
    // by older versions lack issueState and read as open.
    if (candidate.issueState === "closed") return "closed";
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

  /** Configured GitHub username (used to classify own vs competing PRs, #166). */
  getGitHubUsername(): string {
    return this.state.preferences.githubUsername;
  }

  getRepoScore(repo: string): number | null {
    const score = this.state.repoScores[repo];
    return score ? score.score : null;
  }

  /**
   * Number of the user's PRs closed without merge in this repo (#125).
   * Prefers the tracked repo score; falls back to counting closedPRs so the
   * scoring penalty works even before a score record exists.
   */
  getClosedWithoutMergeCount(repo: string): number {
    const score = this.state.repoScores[repo];
    if (score) return score.closedWithoutMergeCount;
    return (this.state.closedPRs ?? []).filter(
      (p) => extractRepoFromUrl(p.url) === repo,
    ).length;
  }

  /**
   * SLM pre-triage config read from preferences (oss-autopilot#1122). Returns
   * `null` when no `slmTriageModel` is configured — the vetter skips the SLM
   * call entirely (#158).
   */
  getSLMTriageConfig(): SLMConfig | null {
    const model = this.state.preferences.slmTriageModel ?? "";
    if (!model) return null;
    return { model, host: this.state.preferences.slmTriageHost ?? "" };
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
   * Reconcile tracked open PRs against their current GitHub state (#164).
   *
   * `state.openPRs` was append-only — nothing transitioned an open PR to
   * merged/closed, so getReposWithOpenPRs() over-reported forever once a PR
   * merged. This checks each open PR, records merges/closures (which updates
   * the repo score), prunes resolved entries, and checkpoints. Cheaper than a
   * full bootstrap, so a host can call it on daily startup. Transient errors
   * leave the entry in place; auth/rate-limit failures propagate.
   */
  async syncOpenPRs(): Promise<SyncResult> {
    const octokit = getOctokit(this.githubToken);
    const open = this.state.openPRs ?? [];
    const result: SyncResult = {
      checked: open.length,
      merged: 0,
      closed: 0,
      stillOpen: 0,
      errors: 0,
    };
    const remaining: typeof open = [];

    for (const pr of open) {
      const parsed = parseGitHubUrl(pr.url);
      if (!parsed || parsed.type !== "pull") {
        remaining.push(pr);
        result.errors++;
        continue;
      }
      const repoFullName = `${parsed.owner}/${parsed.repo}`;
      try {
        const { data } = await octokit.pulls.get({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
        });
        if (data.merged) {
          this.recordMergedPR({
            url: pr.url,
            title: pr.title,
            mergedAt: data.merged_at ?? new Date().toISOString(),
            repo: repoFullName,
          });
          result.merged++;
        } else if (data.state === "closed") {
          this.recordClosedPR({
            url: pr.url,
            title: pr.title,
            closedAt: data.closed_at ?? new Date().toISOString(),
            repo: repoFullName,
          });
          result.closed++;
        } else {
          remaining.push(pr);
          result.stillOpen++;
        }
      } catch (err) {
        // Auth/rate-limit aborts the whole sync; a transient/404 leaves the
        // entry untouched so a later sync can retry rather than losing it.
        rethrowIfFatal(err);
        warn("scout", `sync: could not check ${pr.url}: ${errorMessage(err)}`);
        remaining.push(pr);
        result.errors++;
      }
    }

    this.state.openPRs = remaining;
    this.dirty = true;
    await this.checkpoint();
    return result;
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
    // Stamp so the gist merge keeps the fresher preferences instead of
    // always taking the remote copy (#117).
    this.state.preferencesUpdatedAt = new Date().toISOString();
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
  saveResults(
    candidates: Array<
      IssueCandidate | (IssueCandidate & { horizon?: Horizon })
    >,
  ): void {
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
        horizon: "horizon" in c ? c.horizon : undefined,
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
    this.addTombstones((this.state.savedResults ?? []).map((r) => r.issueUrl));
    this.state.savedResults = [];
    this.dirty = true;
  }

  /**
   * Record deletion tombstones (#117) so a later gist merge does not
   * resurrect these URLs from another machine's copy. A re-add with a newer
   * timestamp overrides the tombstone in mergeStates.
   */
  private addTombstones(urls: string[]): void {
    if (urls.length === 0) return;
    const removedAt = new Date().toISOString();
    const existing = this.state.tombstones ?? [];
    const byUrl = new Map(existing.map((t) => [t.url, t]));
    for (const url of urls) byUrl.set(url, { url, removedAt });
    this.state.tombstones = [...byUrl.values()];
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
    // Also remove from saved results if present. No tombstone needed: the
    // skip entry itself is the durable record, and mergeStates reconciles
    // saved results against the skip list so a merge can't resurrect a
    // skipped URL into the saved list (#117).
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
    const before = (this.state.skippedIssues ?? []).length;
    this.state.skippedIssues = (this.state.skippedIssues ?? []).filter(
      (s) => s.url !== url,
    );
    if (this.state.skippedIssues.length < before) this.addTombstones([url]);
    this.dirty = true;
  }

  /**
   * Clear all skipped issues.
   */
  clearSkippedIssues(): void {
    this.addTombstones((this.state.skippedIssues ?? []).map((s) => s.url));
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

    if (this.persistLocal) {
      // Honest persistence: in local mode the previous no-op return true
      // claimed success while saving nothing (#116). A failed write keeps
      // the dirty flag and reports failure.
      try {
        saveLocalState(this.state);
      } catch {
        return false;
      }
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
