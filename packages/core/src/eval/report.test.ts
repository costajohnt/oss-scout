import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import type { VetEvalResult, VetFixture } from "./types.js";
import type { VetEvalSummary } from "./vet-eval.js";
import { summarize } from "./vet-eval.js";

interface ResultOverrides extends Partial<Omit<VetEvalResult, "fixture">> {
  fixture?: Partial<VetFixture>;
}

function makeResult(overrides: ResultOverrides = {}): VetEvalResult {
  const base: VetEvalResult = {
    fixture: {
      id: "canned-1",
      url: "https://github.com/o/r/issues/1",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      vetDate: "2026-01-01",
      issue: {
        title: "t",
        body: "b",
        labels: [],
        state: "open",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAtObserved: "2026-01-01T00:00:00Z",
      },
      repoMeta: { stars: 10, forks: 1 },
      vetTimeFacts: {
        hasExistingPR: false,
        isClaimed: false,
        projectActive: true,
        contributionGuidelinesFound: true,
        mergedPRCount: 0,
        orgHasMergedPRs: false,
        matchesPreferredCategory: false,
        closedWithoutMergeCount: 0,
      },
      outcome: {
        label: "merged",
        date: "2026-01-02",
        detail: "canned outcome detail",
      },
      measurable: true,
      expectedVerdict: "pursue",
      fidelityNote: "canned fidelity note",
      vaultSource: "test",
    },
    clearRequirements: true,
    recommendation: "approve",
    viabilityScore: 90,
    pursued: true,
    verdictGrade: "correct",
  };
  return {
    ...base,
    ...overrides,
    fixture: { ...base.fixture, ...overrides.fixture },
  };
}

describe("buildReport", () => {
  const meta = {
    date: "2026-07-05",
    mode: "full" as const,
    fixtureCount: 2,
    fixtureSetHash: "deadbeef1234",
  };

  it("states the model, n, mode, fixture count, and hash in the header", () => {
    const summary: VetEvalSummary = summarize([makeResult()]);
    const report = buildReport(summary, meta);
    expect(report).toContain("deriveRecommendation");
    expect(report).toContain("n: 1 run per fixture");
    expect(report).toContain("Mode: full");
    expect(report).toContain("deadbeef1234");
  });

  it("includes a row per measurable fixture with its grade", () => {
    const summary = summarize([
      makeResult({
        fixture: { id: "canned-correct" },
        verdictGrade: "correct",
      }),
      makeResult({
        fixture: {
          id: "canned-cautious",
          outcome: { label: "skip_correct", date: "2026-01-02", detail: "d" },
          expectedVerdict: "skip",
        },
        recommendation: "needs_review",
        verdictGrade: "cautious",
      }),
    ]);
    const report = buildReport(summary, meta);
    expect(report).toContain("canned-correct");
    expect(report).toContain("canned-cautious");
    expect(report).toContain("🟡 cautious");
    expect(report).toContain("✅ correct");
  });

  it("surfaces the needs_review-dominance finding only when it actually occurs", () => {
    const allCorrect = summarize([makeResult()]);
    expect(buildReport(allCorrect, meta)).not.toContain("**Finding:**");

    const withCautiousSkip = summarize([
      makeResult({
        fixture: {
          id: "canned-cautious-skip",
          outcome: { label: "skip_correct", date: "2026-01-02", detail: "d" },
          expectedVerdict: "skip",
        },
        recommendation: "needs_review",
        verdictGrade: "cautious",
      }),
    ]);
    expect(buildReport(withCautiousSkip, meta)).toContain("**Finding:**");
  });

  it("lists unmeasurable fixtures separately from the graded table", () => {
    const summary = summarize([
      makeResult({
        fixture: { id: "canned-unmeasurable", measurable: false },
        verdictGrade: "cautious",
      }),
    ]);
    const report = buildReport(summary, meta);
    expect(report).toContain("Out-of-model-scope fixtures");
    expect(report).toContain("canned-unmeasurable");
  });

  it("includes the honest-limits section verbatim caveats", () => {
    const summary = summarize([makeResult()]);
    const report = buildReport(summary, meta);
    expect(report).toContain("Survivorship bias");
    expect(report).toContain("Outcome conflation");
    expect(report).toContain("Reconstruction fidelity");
  });

  it("is stable output for identical input (no Date.now()/Math.random() leakage)", () => {
    const summary = summarize([makeResult()]);
    const a = buildReport(summary, meta);
    const b = buildReport(summary, meta);
    expect(a).toBe(b);
  });
});
