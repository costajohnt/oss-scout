import { describe, it, expect } from "vitest";
import {
  deriveRecommendation,
  type RecommendationInput,
} from "./issue-vetting.js";

// All checks passing, no affinity signals — the "clean approve" baseline.
function baseInput(
  overrides: Partial<RecommendationInput> = {},
): RecommendationInput {
  return {
    noExistingPR: true,
    ownPR: false,
    notClaimed: true,
    clearRequirements: true,
    contributionGuidelinesFound: true,
    projectIsActive: true,
    projectCheckFailed: false,
    existingPRInconclusive: false,
    claimInconclusive: false,
    mergedCountInconclusive: false,
    effectiveMergedCount: 0,
    orgName: "owner",
    orgHasMergedPRs: false,
    matchesCategory: false,
    issueClosed: false,
    passedAllChecks: true,
    ...overrides,
  };
}

describe("deriveRecommendation (#157)", () => {
  it("approves when all checks pass and nothing is inconclusive", () => {
    const out = deriveRecommendation(baseInput());
    expect(out.recommendation).toBe("approve");
    expect(out.notes).toEqual([]);
    expect(out.reasonsToApprove).toContain("No existing PR");
    expect(out.reasonsToApprove).toContain("Active project");
    expect(out.reasonsToSkip).toEqual([]);
  });

  it("downgrades approve to needs_review on an inconclusive check", () => {
    const out = deriveRecommendation(baseInput({ claimInconclusive: true }));
    expect(out.recommendation).toBe("needs_review");
    expect(out.notes).toContain(
      "Recommendation downgraded: one or more checks were inconclusive",
    );
    expect(out.notes).toContain("Could not verify claim status: API error");
  });

  it("reframes the user's own open PR as 'you're already on it' (#166)", () => {
    const out = deriveRecommendation(
      baseInput({ noExistingPR: false, ownPR: true, passedAllChecks: false }),
    );
    expect(out.recommendation).toBe("skip");
    expect(out.reasonsToSkip).toContain("You already have a PR in flight");
    expect(out.reasonsToSkip).not.toContain("Has existing PR");
    expect(out.notes).toContain("Your PR is already in flight for this issue");
  });

  it("treats a competing existing PR as 'Has existing PR' (not own)", () => {
    const out = deriveRecommendation(
      baseInput({ noExistingPR: false, ownPR: false, passedAllChecks: false }),
    );
    expect(out.reasonsToSkip).toContain("Has existing PR");
    expect(out.reasonsToSkip).not.toContain("You already have a PR in flight");
  });

  it("skips a closed issue regardless of other checks", () => {
    const out = deriveRecommendation(baseInput({ issueClosed: true }));
    expect(out.recommendation).toBe("skip");
    expect(out.reasonsToSkip).toContain("Issue is closed");
  });

  it("skips when more than two skip reasons accumulate", () => {
    const out = deriveRecommendation(
      baseInput({
        noExistingPR: false,
        notClaimed: false,
        clearRequirements: false,
        projectIsActive: false,
        passedAllChecks: false,
      }),
    );
    expect(out.recommendation).toBe("skip");
    expect(out.reasonsToSkip.length).toBeGreaterThan(2);
  });

  it("needs_review when checks fail but fewer than three skip reasons", () => {
    const out = deriveRecommendation(
      baseInput({ clearRequirements: false, passedAllChecks: false }),
    );
    expect(out.recommendation).toBe("needs_review");
    expect(out.reasonsToSkip).toEqual(["Unclear requirements"]);
  });

  it("emits trusted-project and org-affinity reasons from merged-PR signals", () => {
    const out = deriveRecommendation(
      baseInput({ effectiveMergedCount: 3, orgHasMergedPRs: true }),
    );
    expect(out.reasonsToApprove).toContain("Trusted project (3 PRs merged)");
    expect(out.reasonsToApprove).toContain(
      "Org affinity (merged PRs in other owner repos)",
    );
  });

  // Linked-PR lifecycle gate (#249 part B).
  it("skips an issue whose linked PR was already merged", () => {
    const out = deriveRecommendation(
      baseInput({
        noExistingPR: false,
        linkedPRMerged: true,
        passedAllChecks: false,
      }),
    );
    expect(out.recommendation).toBe("skip");
    expect(out.reasonsToSkip).toContain("Linked PR already merged");
    expect(out.reasonsToSkip).not.toContain("Has existing PR");
    expect(out.notes).toContain("A PR for this issue was already merged");
  });

  it("skips an issue whose linked PR was closed without merging", () => {
    const out = deriveRecommendation(
      baseInput({
        noExistingPR: false,
        linkedPRClosed: true,
        passedAllChecks: false,
      }),
    );
    expect(out.recommendation).toBe("skip");
    expect(out.reasonsToSkip).toContain("Linked PR closed without merge");
    expect(out.reasonsToSkip).not.toContain("Has existing PR");
  });

  it("leaves an OPEN competing PR as needs_review, not a hard skip", () => {
    // Regression guard: the merged/closed gate must NOT swallow open PRs,
    // which remain revive opportunities surfaced for review.
    const out = deriveRecommendation(
      baseInput({ noExistingPR: false, passedAllChecks: false }),
    );
    expect(out.recommendation).toBe("needs_review");
    expect(out.reasonsToSkip).toContain("Has existing PR");
  });
});
