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

/** A successful health snapshot of a GitHub repository. */
export interface ProjectHealthData {
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
  /** Discriminant: a real snapshot is never `checkFailed`. */
  checkFailed?: false;
  failureReason?: undefined;
}

/**
 * The health check itself failed (transient API error). Only the repo and the
 * failure reason are known — none of the snapshot fields are meaningful, so the
 * type does not carry them. Narrow on `checkFailed` to reach a real snapshot.
 */
export interface ProjectHealthFailure {
  repo: string;
  checkFailed: true;
  failureReason: string;
}

/**
 * Health snapshot of a GitHub repository, or a marker that the check failed.
 * A discriminated union (on `checkFailed`) so the "failure" shape can't be read
 * as if it carried real snapshot data. Narrow before reading snapshot fields.
 */
export type ProjectHealth = ProjectHealthData | ProjectHealthFailure;

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
   * Personalization marker (#1244). A candidate is EITHER boosted (it matched
   * a `preferLanguages` / `preferRepos` bias and gets a soft sort boost between
   * the `recommendation` tier and `viabilityScore`) OR a diversity slot (it
   * matched no bias and filled a slot reserved by `diversityRatio`) — never
   * both. Modelling it as a single discriminated field makes that mutual
   * exclusivity structural instead of prose across three optional fields.
   * Absent when no personalization was requested or the candidate matched
   * nothing.
   */
  personalization?:
    | { kind: "boosted"; score: number; reasons: string[] }
    | { kind: "diversity" };
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

/**
 * Result of a check (e.g., no existing PR, not claimed). Discriminated on
 * `inconclusive`: a `reason` exists only when the check could not be completed
 * (a transient API error), and an inconclusive check always reports `passed:
 * true` because the caller assumes the issue is still eligible. A conclusive
 * result carries no `reason`.
 */
export type CheckResult =
  | { passed: boolean; inconclusive?: false; reason?: undefined }
  | { passed: true; inconclusive: true; reason: string };

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

/** Identity fields shared by every vet-list entry, regardless of outcome. */
export interface VetListEntryBase {
  issueUrl: string;
  repo: string;
  number: number;
  title: string;
  status: "still_available" | "claimed" | "closed" | "has_pr" | "error";
}

/**
 * A single entry in the vet-list result. Discriminated on `ok`: a completed vet
 * (`ok: true`) carries `recommendation` + `viabilityScore` and never an
 * `errorMessage`; a vet that threw (`ok: false`, including a 404/410 that
 * classifies the issue as `closed`) carries only the `errorMessage`. This makes
 * the "score xor error" invariant structural instead of prose.
 */
export type VetListEntry =
  | (VetListEntryBase & {
      ok: true;
      recommendation: "approve" | "skip" | "needs_review";
      viabilityScore: number;
    })
  | (VetListEntryBase & {
      ok: false;
      errorMessage: string;
    });

/** Summary counts for a vet-list run. */
export interface VetListSummary {
  total: number;
  stillAvailable: number;
  claimed: number;
  closed: number;
  hasPR: number;
  errors: number;
}

/** Result of reconciling tracked open PRs against their current GitHub state (#164). */
export interface SyncResult {
  /** Open PRs checked. */
  checked: number;
  /** Transitioned to merged. */
  merged: number;
  /** Transitioned to closed-without-merge. */
  closed: number;
  /** Still open (kept). */
  stillOpen: number;
  /** Could not be checked (parse failure or transient API error). */
  errors: number;
}

/** A saved result whose availability status changed since the last vet-list (#165). */
export interface VetStatusTransition {
  issueUrl: string;
  repo: string;
  number: number;
  from: VetListEntry["status"];
  to: VetListEntry["status"];
}

/** Result of a batch vet-list operation. */
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
   * Per-call personalization bias: a SOFT penalty (milder than the hard
   * `excludeRepos` filter) for candidates in one of these `owner/repo` slugs
   * (#168). They are pushed below equally-recommended non-matches but not
   * removed; a strong boost can still outweigh the penalty. Empty / undefined
   * disables it.
   */
  avoidRepos?: string[];
  /**
   * Per-call personalization bias: a soft boost for candidates whose issue
   * labels match one of these types, case-insensitive (e.g. "bug",
   * "good first issue") (#168). Same tier as a language match. Does not filter
   * results, does not change `viabilityScore`. Empty / undefined disables it.
   */
  boostIssueTypes?: string[];
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
  /**
   * Exclude issues already surfaced by a recent search so consecutive
   * searches rotate to fresh candidates instead of returning the same set
   * (#249). A result counts as "recently surfaced" when its `lastSeenAt`
   * (recorded by `saveResults`) is within `recentlySurfacedTtlDays`.
   * Defaults to `true`. Pass `false` to force-resurface (e.g. an explicit
   * "search the same pool again" request).
   */
  excludeRecentlySurfaced?: boolean;
  /**
   * TTL in days for the `excludeRecentlySurfaced` rotation window (#249).
   * Results last surfaced more than this many days ago are eligible to
   * resurface. Defaults to 7.
   */
  recentlySurfacedTtlDays?: number;
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
