/**
 * @oss-scout/core — Find open source issues personalized to your contribution history.
 *
 * @example
 * ```typescript
 * import { createScout } from '@oss-scout/core';
 *
 * const scout = await createScout({ githubToken: 'ghp_...' });
 * const results = await scout.search({ maxResults: 10 });
 * for (const c of results.candidates) {
 *   console.log(`${c.issue.repo}#${c.issue.number}: ${c.viabilityScore}/100`);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main API
export { createScout, OssScout } from "./scout.js";

// Types
export type {
  ScoutConfig,
  SearchOptions,
  SearchResult,
  IssueCandidate,
  MergedPRRecord,
  ClosedPRRecord,
  OpenPRRecord,
  RepoScoreUpdate,
  ProjectHealth,
  SearchPriority,
  CheckResult,
  AntiLLMPolicyResult,
  AntiLLMPolicySourceFile,
  VetListOptions,
  VetListResult,
  VetListEntry,
  VetListSummary,
} from "./core/types.js";

export type {
  ScoutState,
  ScoutPreferences,
  RepoScore,
  RepoSignals,
  IssueVettingResult,
  LinkedPR,
  ContributionGuidelines,
  TrackedIssue,
  IssueScope,
  ProjectCategory,
  StoredMergedPR,
  StoredClosedPR,
  StoredOpenPR,
  SearchStrategy,
  SkippedIssue,
} from "./core/schemas.js";

// Schemas (for consumers who need runtime validation)
export {
  ScoutStateSchema,
  ScoutPreferencesSchema,
  RepoScoreSchema,
  IssueScopeSchema,
  ProjectCategorySchema,
  SearchStrategySchema,
  SkippedIssueSchema,
} from "./core/schemas.js";

// Utilities
export { requireGitHubToken, getGitHubToken } from "./core/utils.js";

// Internal classes (for advanced use)
export { IssueDiscovery } from "./core/issue-discovery.js";
export { IssueVetter, type ScoutStateReader } from "./core/issue-vetting.js";
export {
  scanForAntiLLMPolicy,
  ANTI_LLM_KEYWORDS,
} from "./core/anti-llm-policy.js";
