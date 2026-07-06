/**
 * Vet eval — runner.
 *
 * Feeds each fixture's frozen vet-time facts into oss-scout's CURRENT
 * production decision functions:
 *   - analyzeRequirements (issue-eligibility.ts) on the real issue body
 *   - calculateRepoQualityBonus + calculateViabilityScore (issue-scoring.ts)
 *   - deriveRecommendation (issue-vetting.ts)
 *
 * This deliberately does NOT replay the full vetIssue() I/O pipeline
 * (Octokit calls, GraphQL prefetch, etc.) — see the PR description for
 * why: there is no existing full-Octokit fixture harness in this repo,
 * and GitHub's search/timeline APIs cannot be reliably time-traveled to
 * reconstruct historical existing-PR/claim state. Targeting the pure
 * decision-layer functions directly is higher-fidelity and lower-risk:
 * these functions ARE the actual judgment; the rest of vetIssue is I/O
 * plumbing to gather their inputs.
 *
 * One important wrinkle: calculateViabilityScore's freshness bonus calls
 * `daysBetween(issueUpdatedAt)`, which compares against the REAL current
 * date. Replaying a historical fixture naively would make every fixture
 * look maximally stale (freshness bonus ~0) regardless of how fresh the
 * issue actually was at vet time, corrupting scores uniformly. We correct
 * for this with a time-shifted synthetic timestamp that preserves the
 * vet-time freshness gap: `now - (vetDate - issueUpdatedAt)`.
 */
import { analyzeRequirements } from "../core/issue-eligibility.js";
import {
  calculateRepoQualityBonus,
  calculateViabilityScore,
} from "../core/issue-scoring.js";
import {
  deriveRecommendation,
  type RecommendationInput,
} from "../core/issue-vetting.js";
import type { VerdictGrade, VetEvalResult, VetFixture } from "./types.js";

/**
 * Grade a recommendation against the ground-truth expected verdict. Three
 * outcomes, not two — see VerdictGrade's doc comment for why "cautious"
 * (a needs_review that isn't confidently right, but isn't a confident
 * miss either) is kept distinct from "correct" and "wrong".
 */
export function gradeVerdict(
  recommendation: "approve" | "skip" | "needs_review",
  expectedVerdict: "pursue" | "skip",
): VerdictGrade {
  if (expectedVerdict === "pursue") {
    if (recommendation === "approve") return "correct";
    if (recommendation === "needs_review") return "cautious";
    return "wrong"; // recommendation === "skip"
  }
  // expectedVerdict === "skip"
  if (recommendation === "skip") return "correct";
  if (recommendation === "needs_review") return "cautious";
  return "wrong"; // recommendation === "approve"
}

/**
 * Freshness-preserving synthetic updatedAt: shifts the real historical
 * updatedAt forward so that `daysBetween(synthetic, Date.now())` equals
 * `daysBetween(actualUpdatedAt, vetDate)` — i.e. reproduces the same
 * "how stale was this issue AT VET TIME" gap against today's clock.
 */
export function syntheticUpdatedAt(
  issueUpdatedAt: string,
  vetDate: string,
  now: Date = new Date(),
): string {
  const updatedMs = new Date(issueUpdatedAt).getTime();
  const vetMs = new Date(vetDate).getTime();
  const gapMs = Math.max(0, vetMs - updatedMs);
  return new Date(now.getTime() - gapMs).toISOString();
}

export function runFixture(
  fixture: VetFixture,
  now: Date = new Date(),
): VetEvalResult {
  const clearRequirements = analyzeRequirements(fixture.issue.body);
  const repoQualityBonus = calculateRepoQualityBonus(
    fixture.repoMeta.stars,
    fixture.repoMeta.forks,
  );

  const viabilityScore = calculateViabilityScore({
    repoScore: null,
    hasExistingPR: fixture.vetTimeFacts.hasExistingPR,
    isClaimed: fixture.vetTimeFacts.isClaimed,
    clearRequirements,
    hasContributionGuidelines: fixture.vetTimeFacts.contributionGuidelinesFound,
    issueUpdatedAt: syntheticUpdatedAt(
      fixture.issue.updatedAtObserved,
      fixture.vetDate,
      now,
    ),
    closedWithoutMergeCount: fixture.vetTimeFacts.closedWithoutMergeCount,
    mergedPRCount: fixture.vetTimeFacts.mergedPRCount,
    orgHasMergedPRs: fixture.vetTimeFacts.orgHasMergedPRs,
    repoQualityBonus,
    matchesPreferredCategory: fixture.vetTimeFacts.matchesPreferredCategory,
  });

  const recInput: RecommendationInput = {
    noExistingPR: !fixture.vetTimeFacts.hasExistingPR,
    ownPR: false,
    linkedPRMerged: false,
    linkedPRClosed: false,
    notClaimed: !fixture.vetTimeFacts.isClaimed,
    clearRequirements,
    contributionGuidelinesFound:
      fixture.vetTimeFacts.contributionGuidelinesFound,
    projectIsActive: fixture.vetTimeFacts.projectActive,
    projectCheckFailed: false,
    existingPRInconclusive: false,
    claimInconclusive: false,
    mergedCountInconclusive: false,
    effectiveMergedCount: fixture.vetTimeFacts.mergedPRCount,
    orgName: fixture.owner,
    orgHasMergedPRs: fixture.vetTimeFacts.orgHasMergedPRs,
    matchesCategory: fixture.vetTimeFacts.matchesPreferredCategory,
    issueClosed: false, // fixtures freeze the OPEN, at-vet-time state
    passedAllChecks:
      !fixture.vetTimeFacts.hasExistingPR &&
      !fixture.vetTimeFacts.isClaimed &&
      fixture.vetTimeFacts.projectActive &&
      clearRequirements,
  };
  const { recommendation } = deriveRecommendation(recInput);

  const pursued = recommendation !== "skip";
  const verdictGrade: VerdictGrade = fixture.measurable
    ? gradeVerdict(recommendation, fixture.expectedVerdict)
    : "cautious"; // unmeasurable fixtures aren't graded; see summarize()

  return {
    fixture,
    clearRequirements,
    recommendation,
    viabilityScore,
    pursued,
    verdictGrade,
  };
}

export interface VetEvalSummary {
  results: VetEvalResult[];
  measurable: VetEvalResult[];
  unmeasurable: VetEvalResult[];
  accuracy: {
    correct: number;
    cautious: number;
    wrong: number;
    total: number;
    /** (correct + cautious) / total — a needs_review isn't a confident
     * miss, so it's not counted against the lenient rate. */
    lenientRate: number;
    /** correct / total — only a confident, exactly-right verdict counts. */
    strictRate: number;
  };
  byOutcomeLabel: Record<
    string,
    { count: number; avgScore: number; pursuedRate: number }
  >;
}

export function summarize(results: VetEvalResult[]): VetEvalSummary {
  const measurable = results.filter((r) => r.fixture.measurable);
  const unmeasurable = results.filter((r) => !r.fixture.measurable);
  const correct = measurable.filter((r) => r.verdictGrade === "correct").length;
  const cautious = measurable.filter(
    (r) => r.verdictGrade === "cautious",
  ).length;
  const wrong = measurable.filter((r) => r.verdictGrade === "wrong").length;

  const byOutcomeLabel: VetEvalSummary["byOutcomeLabel"] = {};
  for (const r of results) {
    const label = r.fixture.outcome.label;
    byOutcomeLabel[label] ??= { count: 0, avgScore: 0, pursuedRate: 0 };
    const bucket = byOutcomeLabel[label];
    bucket.count += 1;
    bucket.avgScore += r.viabilityScore;
    bucket.pursuedRate += r.pursued ? 1 : 0;
  }
  for (const bucket of Object.values(byOutcomeLabel)) {
    bucket.avgScore = bucket.avgScore / bucket.count;
    bucket.pursuedRate = bucket.pursuedRate / bucket.count;
  }

  return {
    results,
    measurable,
    unmeasurable,
    accuracy: {
      correct,
      cautious,
      wrong,
      total: measurable.length,
      lenientRate:
        measurable.length > 0 ? (correct + cautious) / measurable.length : 0,
      strictRate: measurable.length > 0 ? correct / measurable.length : 0,
    },
    byOutcomeLabel,
  };
}
