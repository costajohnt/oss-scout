/**
 * Vet eval — fixture schema.
 *
 * A fixture freezes what oss-scout's vetter would have seen for one
 * historical issue, plus the realized outcome recorded later in John's
 * OSS-pipeline notes. The runner (vet-eval.ts) feeds `vetTimeFacts` and
 * `issue`/`repo` fields into the CURRENT production scoring/recommendation
 * functions (issue-scoring.ts, issue-vetting.ts's `deriveRecommendation`,
 * issue-eligibility.ts's `analyzeRequirements`) and compares the result
 * against `outcome`.
 *
 * See build-fixtures.ts for how these are constructed and
 * eval/fixtures/vet/README.md for the reconstruction methodology.
 */
import { z } from "zod";

export const OutcomeLabelSchema = z.enum([
  "merged",
  "lost_race",
  "maintainer_fixed",
  "skip_correct",
]);
export type OutcomeLabel = z.infer<typeof OutcomeLabelSchema>;

export const VetTimeFactsSchema = z.object({
  /** Was there already a PR addressing this issue at vet time? */
  hasExistingPR: z.boolean(),
  /** Was the issue already claimed (assignee or claim comment) at vet time? */
  isClaimed: z.boolean(),
  /** Was the repo judged active (recent commits, not abandoned)? */
  projectActive: z.boolean(),
  /** Did the repo have a discoverable CONTRIBUTING.md (or variant)? */
  contributionGuidelinesFound: z.boolean(),
  /** John's merged-PR count in this repo as of vet time. */
  mergedPRCount: z.number().int().min(0),
  /** Did John have merged PRs in a sibling repo under the same org? */
  orgHasMergedPRs: z.boolean(),
  /** Did the repo match one of John's preferred project categories? */
  matchesPreferredCategory: z.boolean(),
  /** John's closed-without-merge count in this repo as of vet time. */
  closedWithoutMergeCount: z.number().int().min(0),
});
export type VetTimeFacts = z.infer<typeof VetTimeFactsSchema>;

export const FixtureOutcomeSchema = z.object({
  label: OutcomeLabelSchema,
  date: z.string(),
  detail: z.string(),
  prUrl: z.string().optional(),
});
export type FixtureOutcome = z.infer<typeof FixtureOutcomeSchema>;

export const VetFixtureSchema = z.object({
  id: z.string(),
  url: z.string(),
  owner: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  /** Date John's notes record this issue as having been vetted. */
  vetDate: z.string(),
  issue: z.object({
    title: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
    state: z.enum(["open", "closed"]),
    createdAt: z.string(),
    /** Issue's updatedAt as observed at fixture-build time (reconstruction
     * time), NOT necessarily vet time — see fidelity notes. */
    updatedAtObserved: z.string(),
  }),
  repoMeta: z.object({
    stars: z.number().int().min(0),
    forks: z.number().int().min(0),
  }),
  vetTimeFacts: VetTimeFactsSchema,
  outcome: FixtureOutcomeSchema,
  /**
   * Whether oss-scout's CURRENT deterministic checks (existing-PR, claimed,
   * project-active, clear-requirements) could plausibly have produced the
   * right call for this fixture. False for outcomes that hinge on signals
   * oss-scout doesn't model at all (maintainer self-fix sentiment, race
   * timing, subjective business judgment) — those are still run and
   * reported, but excluded from the headline accuracy score so the report
   * doesn't overclaim. See docs/plans/fleet-evals-design.md.
   */
  measurable: z.boolean(),
  /** What the ground truth says the right call was, independent of
   * whether oss-scout's current features could detect it. */
  expectedVerdict: z.enum(["pursue", "skip"]),
  /** Free-text: why measurable is what it is, provenance of vetTimeFacts,
   * and any known drift between reconstruction and actual vet-time state. */
  fidelityNote: z.string(),
  /** Vault file this fixture's ground truth was extracted from. */
  vaultSource: z.string(),
});
export type VetFixture = z.infer<typeof VetFixtureSchema>;

/**
 * Three-way grade against `expectedVerdict`, not a binary pass/fail —
 * `deriveRecommendation` has three outputs (approve/skip/needs_review) and
 * collapsing "needs_review" into either bucket hides real signal. A
 * `needs_review` on an expected-skip fixture isn't wrong (a human in the
 * loop still catches it), but it's also not the confident "skip" a fully
 * correct verdict would be — "cautious" reports that distinction instead
 * of forcing a binary that would either overstate accuracy or wrongly
 * penalize appropriate caution.
 */
export type VerdictGrade = "correct" | "cautious" | "wrong";

/** Per-fixture eval result: current vet output + how it graded. */
export interface VetEvalResult {
  fixture: VetFixture;
  clearRequirements: boolean;
  recommendation: "approve" | "skip" | "needs_review";
  viabilityScore: number;
  /** recommendation !== "skip" */
  pursued: boolean;
  /** Only meaningful when fixture.measurable is true. */
  verdictGrade: VerdictGrade;
}
