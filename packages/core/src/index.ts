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
  SyncResult,
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
  Horizon,
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
  HorizonSchema,
} from "./core/schemas.js";

// Preference-field metadata + parsing (shared by the CLI and the MCP server)
export {
  applyPreferenceField,
  FIELD_CONFIGS,
  PREFERENCE_KEYS,
  SORTED_PREFERENCE_KEYS,
  assertFieldConfigsCover,
  updateArray,
  type FieldConfig,
} from "./core/preference-fields.js";

// Utilities
export { requireGitHubToken, getGitHubToken } from "./core/utils.js";

// Internal classes (for advanced use)
export { IssueDiscovery } from "./core/issue-discovery.js";
export {
  IssueVetter,
  type ScoutStateReader,
  type ScoutStateWriter,
  type FeatureSignals,
} from "./core/issue-vetting.js";
export {
  scanForAntiLLMPolicy,
  ANTI_LLM_KEYWORDS,
} from "./core/anti-llm-policy.js";

// Bootstrap (seed state from GitHub) — usable by library/MCP hosts (#156)
export { bootstrapScout, type BootstrapResult } from "./core/bootstrap.js";

// Log-level control for library hosts (#156)
export {
  setLogLevel,
  getLogLevel,
  enableDebug,
  type LogLevel,
} from "./core/logger.js";

// Feature discovery API
export {
  discoverFeatures,
  resolveAnchorRepos,
  classifyHorizon,
  splitByHorizon,
  ANCHOR_THRESHOLD,
  FEATURE_LABELS,
  NO_ANCHORS_MESSAGE,
  NO_RESULTS_MESSAGE,
  type FeatureCandidate,
  type FeatureSearchResult,
  type DiscoverFeaturesOptions,
} from "./core/feature-discovery.js";

// Linked-PR helpers (#97)
export {
  isLinkedPRStalled,
  STALLED_PR_THRESHOLD_DAYS,
} from "./core/linked-pr.js";

// Roadmap scraping (#95)
export {
  fetchRoadmapIssueRefs,
  parseRoadmapIssueRefs,
} from "./core/roadmap.js";

// Issue-URL validation (shared by the CLI and the MCP server)
export {
  ISSUE_URL_PATTERN,
  validateGitHubUrl,
  validateUrl,
} from "./commands/validation.js";
