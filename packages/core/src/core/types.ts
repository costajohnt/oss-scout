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
import type { LogLevel } from "./logger.js";

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
  LinkedPR,
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
export type SearchPriority = "merged_pr" | "starred" | "normal";

/** Source file the anti-LLM policy match came from, or null when no file matched. */
export type AntiLLMPolicySourceFile =
  | "CONTRIBUTING.md"
  | "CODE_OF_CONDUCT.md"
  | "README.md";

/** Result of scanning a repo's policy docs for anti-LLM/AI keywords. */
export interface AntiLLMPolicyResult {
  matched: boolean;
  matchedKeywords: string[];
  sourceFile: AntiLLMPolicySourceFile | null;
}

/**
 * Optional SLM (small language model) pre-triage classification for an
 * issue (oss-autopilot#1122). Populated when the user has configured
 * `slmTriageModel` and a local Ollama instance is reachable. Always
 * fail-open: any error path leaves this `null`.
 */
export interface SLMTriageSummary {
  decision: "pursue" | "investigate" | "skip";
  confidence: "high" | "medium" | "low";
  reasons: string[];
  modelVersion: string;
}

/** A fully vetted issue candidate with scoring. */
export interface IssueCandidate {
  issue: TrackedIssue;
  /**
   * GitHub issue state at vet time (#120). GitHub answers 200 for closed
   * issues, so without this vet-list classified them still_available and
   * --prune kept them. Optional: cached candidates from older versions
   * lack it and read as open.
   */
  issueState?: "open" | "closed";
  vettingResult: IssueVettingResult;
  projectHealth: ProjectHealth;
  antiLLMPolicy: AntiLLMPolicyResult;
  /** SLM pre-triage result, or `null` when not configured / unavailable. */
  slmTriage: SLMTriageSummary | null;
  recommendation: "approve" | "skip" | "needs_review";
  reasonsToSkip: string[];
  reasonsToApprove: string[];
  viabilityScore: number;
  searchPriority: SearchPriority;
  /**
   * Personalization sort tier (#1244). Populated only when the caller
   * passes `preferLanguages` / `preferRepos` to `search()` *and* the
   * candidate matches at least one. Affects sort order between the
   * `recommendation` tier and `viabilityScore`; never used as a filter.
   */
  boostScore?: number;
  /**
   * Human-readable reasons the candidate matched personalization bias
   * (#1244). Mirrors `reasonsToApprove`/`reasonsToSkip` shape for
   * symmetry with the existing surface.
   */
  boostReasons?: string[];
  /**
   * Marks a candidate that filled a reserved diversity slot (#1244).
   * Populated only when `diversityRatio > 0` was passed AND the
   * candidate matched no personalization bias. Mutually exclusive with
   * a non-zero `boostScore` (a candidate cannot be both biased-toward
   * and a diversity slot in the same result set).
   */
  diversitySlot?: boolean;
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
/** A saved result whose availability status changed since the last vet-list (#165). */
export interface VetStatusTransition {
  issueUrl: string;
  repo: string;
  number: number;
  from: VetListEntry["status"];
  to: VetListEntry["status"];
}

export interface VetListResult {
  results: VetListEntry[];
  summary: VetListSummary;
  prunedCount?: number;
  /**
   * Status changes since the previous vet-list run, computed from each saved
   * result's `lastStatus`. Empty on a first run (no prior status to compare).
   */
  transitions: VetStatusTransition[];
}

// ── Config types for the OssScout API ───────────────────────────────

/** Configuration for creating an OssScout instance. */
export type ScoutConfig =
  | {
      /** GitHub token with `repo` read scope. Add `gist` scope for gist persistence. */
      githubToken: string;
      /**
       * State storage. Omitted defaults to `"local"`: load and persist
       * `~/.oss-scout/state.json`, no network on construct. `"gist"` syncs
       * via a private GitHub gist (needs the `gist` token scope).
       */
      persistence?: "local" | "gist";
      /** Gist ID override (gist mode). Skips gist discovery/creation if provided. */
      gistId?: string;
      /**
       * Minimum log level emitted to stderr. Omitted leaves the global level
       * (default "info"). Hosts that don't want the "[INFO] Phase 0..."
       * chatter can pass "warn" or "silent" (#156).
       */
      logLevel?: LogLevel;
    }
  | {
      /** GitHub token with `repo` read scope. */
      githubToken: string;
      /** Caller provides and owns state directly (embedding hosts). */
      persistence: "provided";
      /** Pre-loaded state. Required when persistence is 'provided'. */
      initialState: ScoutState;
      /**
       * Minimum log level emitted to stderr. Omitted leaves the global level
       * (default "info"). Hosts that don't want the "[INFO] Phase 0..."
       * chatter can pass "warn" or "silent" (#156).
       */
      logLevel?: LogLevel;
    };

/** Options for the search method. */
export interface SearchOptions {
  maxResults?: number;
  strategies?: SearchStrategy[];
  /**
   * Per-call personalization bias: candidates whose repo language matches
   * one of these (case-insensitive) get a soft sort boost above
   * equally-recommended non-matches (#1244). Does not filter results, does
   * not change `viabilityScore`. Empty / undefined disables the boost.
   */
  preferLanguages?: string[];
  /**
   * Per-call personalization bias: candidates in one of these
   * `owner/repo` slugs get a soft sort boost above equally-recommended
   * non-matches (#1244). Stronger weight than language match. Does not
   * filter results, does not change `viabilityScore`. Empty / undefined
   * disables the boost.
   */
  preferRepos?: string[];
  /**
   * Counterweight against echo-chamber bias as `preferLanguages` /
   * `preferRepos` boosts accumulate over time (#1244). A value of 0.2
   * means "reserve roughly 20% of the final slots for candidates that
   * matched NEITHER preference list," filling them from the same sorted
   * pool but skipping any candidate carrying a `boostScore`. 0 disables
   * the counterweight; 1 makes every slot a diversity slot. Range
   * clamped to [0, 1].
   */
  diversityRatio?: number;
  /**
   * Per-call override for the delay between search phases (ms). Defaults to
   * the `interPhaseDelayMs` preference (30s). Latency-sensitive callers like
   * the MCP server pass 0; the sliding-window budget tracker still paces the
   * actual API calls, so the fixed sleep is the only thing removed (#143).
   */
  interPhaseDelayMs?: number;
  /**
   * Per-call override for the extra cooldown before the broad phase (ms).
   * Defaults to the `broadPhaseDelayMs` preference (90s). See
   * `interPhaseDelayMs` for the rationale (#143).
   */
  broadPhaseDelayMs?: number;
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

/** Record of an open PR for state contribution. */
export interface OpenPRRecord {
  url: string;
  title: string;
  openedAt: string;
  repo: string;
}
