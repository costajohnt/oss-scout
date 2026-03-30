/**
 * Gist-backed state persistence for oss-scout.
 *
 * Stores ScoutState as a private GitHub Gist, with a local file cache
 * as fallback when the API is unavailable.
 */

import * as fs from "fs";
import * as path from "path";
import { ScoutStateSchema } from "./schemas.js";
import type {
  ScoutState,
  RepoScore,
  SavedCandidate,
  SkippedIssue,
} from "./schemas.js";
import { getDataDir } from "./utils.js";
import { debug, warn } from "./logger.js";
import { errorMessage } from "./errors.js";

const MODULE = "gist-state";

const GIST_DESCRIPTION = "oss-scout-state";
const GIST_FILENAME = "state.json";
const GIST_ID_FILE = "gist-id";
const CACHE_FILE = "state-cache.json";
const SEARCH_MAX_PAGES = 5;

/** Minimal Octokit interface for gist operations — keeps the class testable. */
export interface GistOctokitLike {
  gists: {
    get(params: { gist_id: string }): Promise<{
      data: {
        id: string;
        files: Record<string, { content?: string } | undefined> | null;
      };
    }>;
    create(params: {
      description: string;
      public: boolean;
      files: Record<string, { content: string }>;
    }): Promise<{
      data: { id: string };
    }>;
    update(params: {
      gist_id: string;
      files: Record<string, { content: string }>;
    }): Promise<{ data: { id: string } }>;
    list(params: { per_page: number; page: number }): Promise<{
      data: Array<{ id: string; description: string | null }>;
    }>;
  };
}

export interface BootstrapResult {
  gistId: string;
  state: ScoutState;
  created: boolean;
  degraded?: boolean;
}

function getGistIdPath(): string {
  return path.join(getDataDir(), GIST_ID_FILE);
}

function getCachePath(): string {
  return path.join(getDataDir(), CACHE_FILE);
}

export class GistStateStore {
  private gistId: string | null = null;

  constructor(private octokit: GistOctokitLike) {}

  /**
   * Bootstrap: find an existing gist or create a new one.
   * Falls back to local cache if the API is unavailable.
   */
  async bootstrap(): Promise<BootstrapResult> {
    try {
      return await this.bootstrapFromApi();
    } catch (err) {
      warn(MODULE, `API bootstrap failed: ${errorMessage(err)}`);
      return this.bootstrapFromCache();
    }
  }

  /**
   * Push state to the gist. Also writes to local cache as fallback.
   */
  async push(state: ScoutState): Promise<boolean> {
    this.writeCache(state);

    if (!this.gistId) {
      warn(MODULE, "No gist ID — cannot push");
      return false;
    }

    const json = JSON.stringify(state, null, 2);
    if (json.length > 900000) {
      warn(
        MODULE,
        `State too large for gist (${Math.round(json.length / 1024)}KB). Consider clearing old results with 'oss-scout results clear'.`,
      );
      return false;
    }

    try {
      await this.octokit.gists.update({
        gist_id: this.gistId,
        files: {
          [GIST_FILENAME]: { content: json },
        },
      });
      debug(MODULE, "State pushed to gist");
      return true;
    } catch (err) {
      warn(MODULE, `Failed to push: ${errorMessage(err)}`);
      return false;
    }
  }

  /**
   * Pull state from the gist and merge with local state.
   */
  async pull(): Promise<ScoutState | null> {
    if (!this.gistId) return null;

    try {
      const state = await this.fetchGistState(this.gistId);
      if (state) {
        this.writeCache(state);
      }
      return state;
    } catch (err) {
      warn(MODULE, `Failed to pull: ${errorMessage(err)}`);
      return null;
    }
  }

  /** Get the current gist ID (if known). */
  getGistId(): string | null {
    return this.gistId;
  }

  // ── API bootstrap flow ───────────────────────────────────────────────

  private async bootstrapFromApi(): Promise<BootstrapResult> {
    // 1. Check local gist-id cache
    const cachedId = this.readCachedGistId();
    if (cachedId) {
      debug(MODULE, `Trying cached gist ID: ${cachedId}`);
      try {
        const state = await this.fetchGistState(cachedId);
        if (state) {
          this.gistId = cachedId;
          this.writeCache(state);
          return { gistId: cachedId, state, created: false };
        }
      } catch (err) {
        debug(MODULE, `Cached gist ID invalid: ${errorMessage(err)}`);
      }
      debug(MODULE, "Cached gist ID invalid, searching...");
    }

    // 2. Search user's gists
    const foundId = await this.searchForGist();
    if (foundId) {
      debug(MODULE, `Found gist via search: ${foundId}`);
      this.saveGistId(foundId);
      this.gistId = foundId;
      const state = await this.fetchGistState(foundId);
      if (state) {
        this.writeCache(state);
        return { gistId: foundId, state, created: false };
      }
      // Gist exists but content failed validation — fall back to cache
      // to avoid overwriting the user's data by creating a new gist.
      warn(
        MODULE,
        `Found existing gist ${foundId} but content failed validation. Using local cache to avoid data loss.`,
      );
      return this.bootstrapFromCache();
    }

    // 3. Create new gist
    debug(MODULE, "No existing gist found, creating new one");
    const freshState = ScoutStateSchema.parse({ version: 1 });
    const newId = await this.createGist(freshState);
    this.saveGistId(newId);
    this.gistId = newId;
    this.writeCache(freshState);
    return { gistId: newId, state: freshState, created: true };
  }

  private bootstrapFromCache(): BootstrapResult {
    const cached = this.readCache();
    if (cached) {
      debug(MODULE, "Bootstrapped from local cache (degraded mode)");
      const cachedId = this.readCachedGistId();
      if (cachedId) this.gistId = cachedId;
      return {
        gistId: cachedId ?? "",
        state: cached,
        created: false,
        degraded: true,
      };
    }

    debug(MODULE, "No cache available, using fresh state (degraded mode)");
    const fresh = ScoutStateSchema.parse({ version: 1 });
    return { gistId: "", state: fresh, created: false, degraded: true };
  }

  // ── Gist API operations ──────────────────────────────────────────────

  private async fetchGistState(gistId: string): Promise<ScoutState | null> {
    const { data } = await this.octokit.gists.get({ gist_id: gistId });
    const file = data.files?.[GIST_FILENAME];
    if (!file?.content) return null;

    try {
      const parsed = JSON.parse(file.content);
      return ScoutStateSchema.parse(parsed);
    } catch (err) {
      warn(MODULE, `Gist content failed validation: ${errorMessage(err)}`);
      return null;
    }
  }

  private async searchForGist(): Promise<string | null> {
    for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
      const { data: gists } = await this.octokit.gists.list({
        per_page: 100,
        page,
      });

      if (gists.length === 0) break;

      const match = gists.find((g) => g.description === GIST_DESCRIPTION);
      if (match) return match.id;
    }
    return null;
  }

  private async createGist(state: ScoutState): Promise<string> {
    const { data } = await this.octokit.gists.create({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [GIST_FILENAME]: { content: JSON.stringify(state, null, 2) },
      },
    });
    return data.id;
  }

  // ── Local file helpers ───────────────────────────────────────────────

  private readCachedGistId(): string | null {
    try {
      const id = fs.readFileSync(getGistIdPath(), "utf-8").trim();
      return id || null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        warn(MODULE, `Failed to read cached gist ID: ${errorMessage(err)}`);
      }
      return null;
    }
  }

  private saveGistId(id: string): void {
    fs.writeFileSync(getGistIdPath(), id + "\n", { mode: 0o600 });
  }

  private readCache(): ScoutState | null {
    try {
      const raw = fs.readFileSync(getCachePath(), "utf-8");
      return ScoutStateSchema.parse(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        warn(MODULE, `Failed to read state cache: ${errorMessage(err)}`);
      }
      return null;
    }
  }

  private writeCache(state: ScoutState): void {
    try {
      fs.writeFileSync(getCachePath(), JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
      });
    } catch (err) {
      warn(MODULE, `Failed to write cache: ${errorMessage(err)}`);
    }
  }
}

// ── State merging ────────────────────────────────────────────────────

/**
 * Merge two ScoutState objects with conflict resolution:
 * - repoScores: per-repo, keep the one with more total PR activity
 * - mergedPRs/closedPRs: union by URL
 * - preferences: remote wins
 * - starredRepos: keep the list with the fresher timestamp
 * - savedResults: union by issueUrl, keep newer lastSeenAt
 */
export function mergeStates(local: ScoutState, remote: ScoutState): ScoutState {
  return {
    version: 1,
    preferences: remote.preferences,
    repoScores: mergeRepoScores(local.repoScores, remote.repoScores),
    starredRepos: mergeStarredRepos(local, remote),
    starredReposLastFetched: pickFresherTimestamp(
      local.starredReposLastFetched,
      remote.starredReposLastFetched,
    ),
    mergedPRs: unionByUrl(local.mergedPRs, remote.mergedPRs),
    closedPRs: unionByUrl(local.closedPRs, remote.closedPRs),
    savedResults: mergeSavedResults(
      local.savedResults ?? [],
      remote.savedResults ?? [],
    ),
    skippedIssues: mergeSkippedIssues(
      local.skippedIssues ?? [],
      remote.skippedIssues ?? [],
    ),
    lastSearchAt: pickFresherTimestamp(local.lastSearchAt, remote.lastSearchAt),
    lastRunAt:
      pickFresherTimestamp(local.lastRunAt, remote.lastRunAt) ??
      new Date().toISOString(),
    gistId: remote.gistId ?? local.gistId,
  };
}

function mergeRepoScores(
  local: Record<string, RepoScore>,
  remote: Record<string, RepoScore>,
): Record<string, RepoScore> {
  const merged: Record<string, RepoScore> = { ...local };
  for (const [repo, remoteScore] of Object.entries(remote)) {
    const localScore = merged[repo];
    if (!localScore) {
      merged[repo] = remoteScore;
    } else {
      const localActivity =
        localScore.mergedPRCount + localScore.closedWithoutMergeCount;
      const remoteActivity =
        remoteScore.mergedPRCount + remoteScore.closedWithoutMergeCount;
      merged[repo] = remoteActivity >= localActivity ? remoteScore : localScore;
    }
  }
  return merged;
}

function mergeStarredRepos(local: ScoutState, remote: ScoutState): string[] {
  const localTs = local.starredReposLastFetched;
  const remoteTs = remote.starredReposLastFetched;
  if (!localTs && !remoteTs)
    return remote.starredRepos.length >= local.starredRepos.length
      ? remote.starredRepos
      : local.starredRepos;
  if (!localTs) return remote.starredRepos;
  if (!remoteTs) return local.starredRepos;
  return remoteTs >= localTs ? remote.starredRepos : local.starredRepos;
}

function unionByUrl<T extends { url: string }>(local: T[], remote: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of local) seen.set(item.url, item);
  for (const item of remote) seen.set(item.url, item);
  return [...seen.values()];
}

function mergeSavedResults(
  local: SavedCandidate[],
  remote: SavedCandidate[],
): SavedCandidate[] {
  const merged = new Map<string, SavedCandidate>();
  for (const item of local) merged.set(item.issueUrl, item);
  for (const item of remote) {
    const existing = merged.get(item.issueUrl);
    if (!existing || item.lastSeenAt > existing.lastSeenAt) {
      merged.set(item.issueUrl, item);
    }
  }
  return [...merged.values()];
}

function mergeSkippedIssues(
  local: SkippedIssue[],
  remote: SkippedIssue[],
): SkippedIssue[] {
  const merged = new Map<string, SkippedIssue>();
  for (const item of local) merged.set(item.url, item);
  for (const item of remote) {
    const existing = merged.get(item.url);
    if (!existing || item.skippedAt > existing.skippedAt) {
      merged.set(item.url, item);
    }
  }
  return [...merged.values()];
}

function pickFresherTimestamp(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
