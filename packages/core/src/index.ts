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
export { createScout, OssScout } from './scout.js';

// Types
export type {
  ScoutConfig,
  SearchOptions,
  SearchResult,
  IssueCandidate,
  MergedPRRecord,
  ClosedPRRecord,
  RepoScoreUpdate,
  ProjectHealth,
  SearchPriority,
  CheckResult,
  VetListOptions,
  VetListResult,
  VetListEntry,
  VetListSummary,
} from './core/types.js';

export type {
  ScoutState,
  ScoutPreferences,
  RepoScore,
  RepoSignals,
  IssueVettingResult,
  ContributionGuidelines,
  TrackedIssue,
  IssueScope,
  ProjectCategory,
  StoredMergedPR,
  StoredClosedPR,
} from './core/schemas.js';

// Schemas (for consumers who need runtime validation)
export {
  ScoutStateSchema,
  ScoutPreferencesSchema,
  RepoScoreSchema,
  IssueScopeSchema,
  ProjectCategorySchema,
} from './core/schemas.js';

// Utilities
export { requireGitHubToken, getGitHubToken } from './core/utils.js';

// Internal classes (for advanced use)
export { IssueDiscovery } from './core/issue-discovery.js';
export { IssueVetter, type ScoutStateReader } from './core/issue-vetting.js';
