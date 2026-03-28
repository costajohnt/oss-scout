/**
 * Core types for oss-scout — ephemeral types that are never persisted.
 */

import type {
  RepoSignals,
  TrackedIssue,
  IssueVettingResult,
  IssueScope,
  ScoutState,
  SearchStrategy,
} from "./schemas.js";

// Re-export persisted types for convenience
export type {
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
  SavedCandidate,
  ScoutState,
  SearchStrategy,
} from "./schemas.js";

// ── Ephemeral types ─────────────────────────────────────────────────

/** Health snapshot of a GitHub repository. */
export interface ProjectHealth {
  repo: string;
  lastCommitAt: string;
  daysSinceLastCommit: number;
  openIssuesCount: number;
  avgIssueResponseDays: number;
  ciStatus: "passing" | "failing" | "unknown";
  isActive: boolean;
  stargazersCount?: number;
  forksCount?: number;
  language?: string | null;
  checkFailed?: boolean;
  failureReason?: string;
}

/** Priority tier for issue search results. */
export type SearchPriority =
  | "merged_pr"
  | "preferred_org"
  | "starred"
  | "normal";

/** A fully vetted issue candidate with scoring. */
export interface IssueCandidate {
  issue: TrackedIssue;
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  recommendation: "approve" | "skip" | "needs_review";
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

export const SCOPE_LABELS: Record<IssueScope, string[]> = {
  beginner: [
    "good first issue",
    "help wanted",
    "easy",
    "up-for-grabs",
    "first-timers-only",
    "beginner",
  ],
  intermediate: [
    "enhancement",
    "feature",
    "feature-request",
    "contributions welcome",
  ],
  advanced: ["proposal", "RFC", "accepted", "design"],
};

// ── Vet-list types ─────────────────────────────────────────────────

/** Options for batch vetting saved results. */
export interface VetListOptions {
  concurrency?: number;
  prune?: boolean;
}

/** A single entry in the vet-list result. */
export interface VetListEntry {
  issueUrl: string;
  repo: string;
  number: number;
  title: string;
  status: "still_available" | "claimed" | "closed" | "has_pr" | "error";
  recommendation?: "approve" | "skip" | "needs_review";
  viabilityScore?: number;
  errorMessage?: string;
}

/** Summary counts for a vet-list run. */
export interface VetListSummary {
  total: number;
  stillAvailable: number;
  claimed: number;
  closed: number;
  hasPR: number;
  errors: number;
}

/** Result of a batch vet-list operation. */
export interface VetListResult {
  results: VetListEntry[];
  summary: VetListSummary;
  prunedCount?: number;
}

// ── Config types for the OssScout API ───────────────────────────────

/** Configuration for creating an OssScout instance. */
export type ScoutConfig =
  | {
      /** GitHub token with `repo` read scope. Add `gist` scope for persistence. */
      githubToken: string;
      /** Use gist-backed persistence (default for standalone CLI). */
      persistence?: "gist";
      /** Gist ID override. Skips gist discovery/creation if provided. */
      gistId?: string;
    }
  | {
      /** GitHub token with `repo` read scope. */
      githubToken: string;
      /** Caller provides state directly. */
      persistence: "provided";
      /** Pre-loaded state. Required when persistence is 'provided'. */
      initialState: ScoutState;
    };

/** Options for the search method. */
export interface SearchOptions {
  maxResults?: number;
  strategies?: SearchStrategy[];
}

/** Result of a search operation. */
export interface SearchResult {
  candidates: IssueCandidate[];
  excludedRepos: string[];
  aiPolicyBlocklist: string[];
  rateLimitWarning?: string;
  strategiesUsed: SearchStrategy[];
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
