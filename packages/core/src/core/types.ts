/**
 * Core types for oss-scout — ephemeral types that are never persisted.
 */

import {
  ScoutPreferencesSchema,
  ScoutStateSchema,
  IssueScopeSchema,
  ProjectCategorySchema,
} from './schemas.js';

import type {
  RepoSignals,
  TrackedIssue,
  IssueVettingResult,
  IssueScope,
  ScoutPreferences,
  ScoutState,
  RepoScore,
} from './schemas.js';

// Re-export persisted types for convenience
export type {
  IssueStatus,
  ProjectCategory,
  IssueScope,
  RepoSignals,
  RepoScore,
  StoredMergedPR,
  StoredClosedPR,
  ContributionGuidelines,
  IssueVettingResult,
  TrackedIssue,
  ScoutPreferences,
  ScoutState,
} from './schemas.js';

// ── Ephemeral types ─────────────────────────────────────────────────

/** Health snapshot of a GitHub repository. */
export interface ProjectHealth {
  repo: string;
  lastCommitAt: string;
  daysSinceLastCommit: number;
  openIssuesCount: number;
  avgIssueResponseDays: number;
  ciStatus: 'passing' | 'failing' | 'unknown';
  isActive: boolean;
  stargazersCount?: number;
  forksCount?: number;
  language?: string | null;
  checkFailed?: boolean;
  failureReason?: string;
}

/** Priority tier for issue search results. */
export type SearchPriority = 'merged_pr' | 'preferred_org' | 'starred' | 'normal';

/** A fully vetted issue candidate with scoring. */
export interface IssueCandidate {
  issue: TrackedIssue;
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  recommendation: 'approve' | 'skip' | 'needs_review';
  reasonsToSkip: string[];
  reasonsToApprove: string[];
  viabilityScore: number;
  searchPriority: SearchPriority;
}

/** Subset of RepoScore fields that callers may update. */
export interface RepoScoreUpdate {
  mergedPRCount?: number;
  closedWithoutMergeCount?: number;
  avgResponseDays?: number | null;
  lastMergedAt?: string;
  signals?: Partial<RepoSignals>;
  stargazersCount?: number;
  language?: string | null;
}

/** Result of a check (e.g., no existing PR, not claimed). */
export interface CheckResult {
  passed: boolean;
  inconclusive?: boolean;
  reason?: string;
}

// ── Const arrays and mappings ───────────────────────────────────────

export const PROJECT_CATEGORIES = ProjectCategorySchema.options;
export const ISSUE_SCOPES = IssueScopeSchema.options;

export const SCOPE_LABELS: Record<IssueScope, string[]> = {
  beginner: ['good first issue', 'help wanted', 'easy', 'up-for-grabs', 'first-timers-only', 'beginner'],
  intermediate: ['enhancement', 'feature', 'feature-request', 'contributions welcome'],
  advanced: ['proposal', 'RFC', 'accepted', 'design'],
};

export const DEFAULT_PREFERENCES = ScoutPreferencesSchema.parse({}) as ScoutPreferences;
export const INITIAL_STATE = ScoutStateSchema.parse({ version: 1 }) as ScoutState;

// ── Config types for the OssScout API ───────────────────────────────

/** Configuration for creating an OssScout instance. */
export interface ScoutConfig {
  /** GitHub token with `repo` read scope. Add `gist` scope for persistence. */
  githubToken: string;

  /**
   * How to load/persist state.
   * - 'gist': Use gist-backed persistence (default for standalone CLI)
   * - 'provided': Caller provides state directly via `initialState`
   */
  persistence?: 'gist' | 'provided';

  /** Pre-loaded state. Required when persistence === 'provided'. */
  initialState?: ScoutState;

  /** Gist ID override. Skips gist discovery/creation if provided. */
  gistId?: string;
}

/** Options for the search method. */
export interface SearchOptions {
  maxResults?: number;
}

/** Options for the vet-list method. */
export interface VetListOptions {
  issueListPath?: string;
  concurrency?: number;
  prune?: boolean;
}

/** Result of a search operation. */
export interface SearchResult {
  candidates: IssueCandidate[];
  excludedRepos: string[];
  aiPolicyBlocklist: string[];
  rateLimitWarning?: string;
}

/** Record of a merged PR for state contribution. */
export interface MergedPRRecord {
  url: string;
  title: string;
  mergedAt: string;
  repo: string;
}

/** Record of a closed PR for state contribution. */
export interface ClosedPRRecord {
  url: string;
  title: string;
  closedAt: string;
  repo: string;
}
