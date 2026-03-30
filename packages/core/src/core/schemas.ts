/**
 * Zod schemas for all types persisted in oss-scout state.
 *
 * This file is the single source of truth for persisted type shapes.
 * Types are inferred via `z.infer<>` at the bottom.
 */
import { z } from "zod";

// ── Enum schemas ────────────────────────────────────────────────────

export const IssueStatusSchema = z.enum([
  "candidate",
  "claimed",
  "in_progress",
  "pr_submitted",
]);

export const ProjectCategorySchema = z.enum([
  "nonprofit",
  "devtools",
  "infrastructure",
  "web-frameworks",
  "data-ml",
  "education",
]);

export const IssueScopeSchema = z.enum([
  "beginner",
  "intermediate",
  "advanced",
]);

export const SearchStrategySchema = z.enum([
  "merged",
  "starred",
  "broad",
  "maintained",
  "all",
]);

/** All concrete strategies (excludes 'all' meta-strategy). */
export const CONCRETE_STRATEGIES = [
  "merged",
  "starred",
  "broad",
  "maintained",
] as const;

// ── Leaf schemas ────────────────────────────────────────────────────

export const RepoSignalsSchema = z.object({
  hasActiveMaintainers: z.boolean(),
  isResponsive: z.boolean(),
  hasHostileComments: z.boolean(),
});

export const RepoScoreSchema = z.object({
  repo: z.string(),
  score: z.number(),
  mergedPRCount: z.number(),
  closedWithoutMergeCount: z.number(),
  avgResponseDays: z.number().nullable(),
  lastMergedAt: z.string().optional(),
  lastEvaluatedAt: z.string(),
  signals: RepoSignalsSchema,
  stargazersCount: z.number().optional(),
  language: z.string().nullable().optional(),
});

export const StoredMergedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  mergedAt: z.string(),
});

export const StoredClosedPRSchema = z.object({
  url: z.string(),
  title: z.string(),
  closedAt: z.string(),
});

// ── Contribution schemas ────────────────────────────────────────────

export const ContributionGuidelinesSchema = z.object({
  branchNamingConvention: z.string().optional(),
  commitMessageFormat: z.string().optional(),
  prTitleFormat: z.string().optional(),
  requiredChecks: z.array(z.string()).optional(),
  testFramework: z.string().optional(),
  testCoverageRequired: z.boolean().optional(),
  testFileNaming: z.string().optional(),
  linter: z.string().optional(),
  formatter: z.string().optional(),
  styleGuideUrl: z.string().optional(),
  issueClaimProcess: z.string().optional(),
  reviewProcess: z.string().optional(),
  claRequired: z.boolean().optional(),
  rawContent: z.string().optional(),
});

export const IssueVettingResultSchema = z.object({
  passedAllChecks: z.boolean(),
  checks: z.object({
    noExistingPR: z.boolean(),
    notClaimed: z.boolean(),
    projectActive: z.boolean(),
    clearRequirements: z.boolean(),
    contributionGuidelinesFound: z.boolean(),
  }),
  contributionGuidelines: ContributionGuidelinesSchema.optional(),
  notes: z.array(z.string()),
});

export const TrackedIssueSchema = z.object({
  id: z.number(),
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  status: IssueStatusSchema,
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  vetted: z.boolean(),
  vettingResult: IssueVettingResultSchema.optional(),
});

// ── Skipped issue schema ──────────────────────────────────────────

export const SkippedIssueSchema = z.object({
  url: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  skippedAt: z.string(),
});

// ── Saved candidate schema ─────────────────────────────────────────

export const SavedCandidateSchema = z.object({
  issueUrl: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  labels: z.array(z.string()),
  recommendation: z.enum(["approve", "skip", "needs_review"]),
  viabilityScore: z.number(),
  searchPriority: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastScore: z.number(),
});

// ── Scout preferences schema ────────────────────────────────────────

export const PersistenceModeSchema = z.enum(["local", "gist"]);

export const ScoutPreferencesSchema = z.object({
  githubUsername: z.string().default(""),
  languages: z.array(z.string()).default(["any"]),
  labels: z.array(z.string()).default(["good first issue", "help wanted"]),
  scope: z.array(IssueScopeSchema).optional(),
  excludeRepos: z.array(z.string()).default([]),
  excludeOrgs: z.array(z.string()).default([]),
  aiPolicyBlocklist: z.array(z.string()).default(["matplotlib/matplotlib"]),
  projectCategories: z.array(ProjectCategorySchema).default([]),
  minStars: z.number().default(50),
  maxIssueAgeDays: z.number().default(90),
  includeDocIssues: z.boolean().default(true),
  minRepoScoreThreshold: z.number().default(4),
  persistence: PersistenceModeSchema.default("local"),
  defaultStrategy: z.array(SearchStrategySchema).optional(),
});

// ── Root state schema ───────────────────────────────────────────────

export const ScoutStateSchema = z.object({
  version: z.literal(1),

  preferences: ScoutPreferencesSchema.default(() =>
    ScoutPreferencesSchema.parse({}),
  ),

  repoScores: z.record(z.string(), RepoScoreSchema).default({}),

  starredRepos: z.array(z.string()).default([]),
  starredReposLastFetched: z.string().optional(),

  mergedPRs: z.array(StoredMergedPRSchema).default([]),
  closedPRs: z.array(StoredClosedPRSchema).default([]),

  savedResults: z.array(SavedCandidateSchema).default([]),
  skippedIssues: z.array(SkippedIssueSchema).default([]),

  lastSearchAt: z.string().optional(),
  lastRunAt: z.string().default(() => new Date().toISOString()),

  gistId: z.string().optional(),
});

// ── Inferred types ──────────────────────────────────────────────────

export type ProjectCategory = z.infer<typeof ProjectCategorySchema>;
export type IssueScope = z.infer<typeof IssueScopeSchema>;
export type SearchStrategy = z.infer<typeof SearchStrategySchema>;
export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
export type RepoScore = z.infer<typeof RepoScoreSchema>;
export type StoredMergedPR = z.infer<typeof StoredMergedPRSchema>;
export type StoredClosedPR = z.infer<typeof StoredClosedPRSchema>;
export type ContributionGuidelines = z.infer<
  typeof ContributionGuidelinesSchema
>;
export type IssueVettingResult = z.infer<typeof IssueVettingResultSchema>;
export type TrackedIssue = z.infer<typeof TrackedIssueSchema>;
export type ScoutPreferences = z.infer<typeof ScoutPreferencesSchema>;
export type SavedCandidate = z.infer<typeof SavedCandidateSchema>;
export type SkippedIssue = z.infer<typeof SkippedIssueSchema>;
export type ScoutState = z.infer<typeof ScoutStateSchema>;
