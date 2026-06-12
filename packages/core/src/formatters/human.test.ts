import { describe, it, expect } from "vitest";
import {
  recommendationIcon,
  renderSearch,
  renderFeatures,
  renderResults,
  renderVetList,
  renderVet,
  RESULTS_EMPTY_MESSAGE,
  VET_LIST_EMPTY_MESSAGE,
} from "./human.js";
import type { SearchOutput } from "../commands/search.js";
import type { FeaturesOutput } from "../commands/features.js";
import type { SavedCandidate } from "../core/schemas.js";
import type { VetListResult } from "../core/types.js";
import type { VetOutput } from "../commands/vet.js";

// ── recommendationIcon ──────────────────────────────────────────────

describe("recommendationIcon", () => {
  it("maps each recommendation to its emoji", () => {
    expect(recommendationIcon("approve")).toBe("✅");
    expect(recommendationIcon("skip")).toBe("❌");
    expect(recommendationIcon("needs_review")).toBe("⚠️");
  });
});

// ── renderSearch ────────────────────────────────────────────────────

function searchCandidate(
  overrides: Partial<SearchOutput["candidates"][number]> = {},
): SearchOutput["candidates"][number] {
  return {
    issue: {
      repo: "owner/repo",
      repoUrl: "https://github.com/owner/repo",
      number: 1,
      title: "Fix the bug",
      url: "https://github.com/owner/repo/issues/1",
      labels: [],
    },
    recommendation: "approve",
    reasonsToApprove: [],
    reasonsToSkip: [],
    searchPriority: "normal",
    viabilityScore: 80,
    ...overrides,
  };
}

function searchOutput(
  candidates: SearchOutput["candidates"],
  overrides: Partial<SearchOutput> = {},
): SearchOutput {
  return {
    candidates,
    excludedRepos: [],
    aiPolicyBlocklist: [],
    strategiesUsed: [],
    ...overrides,
  };
}

describe("renderSearch", () => {
  it("renders the header with the candidate count", () => {
    const out = renderSearch(searchOutput([searchCandidate()]));
    expect(out).toContain("Found 1 issue candidates:");
  });

  it("renders zero candidates without throwing", () => {
    const out = renderSearch(searchOutput([]));
    expect(out).toBe("\nFound 0 issue candidates:\n");
  });

  it("renders the icon, slug, score, title, and url per candidate", () => {
    const out = renderSearch(searchOutput([searchCandidate()]));
    expect(out).toContain("✅ owner/repo#1 [80/100]");
    expect(out).toContain("     Fix the bug");
    expect(out).toContain("     https://github.com/owner/repo/issues/1");
  });

  it("uses the skip icon for skip recommendations", () => {
    const out = renderSearch(
      searchOutput([searchCandidate({ recommendation: "skip" })]),
    );
    expect(out).toContain("❌ owner/repo#1");
  });

  it("renders the repoScore line when present", () => {
    const out = renderSearch(
      searchOutput([
        searchCandidate({
          repoScore: {
            score: 7,
            mergedPRCount: 3,
            closedWithoutMergeCount: 0,
            isResponsive: true,
          },
        }),
      ]),
    );
    expect(out).toContain("     Repo: 7/10, 3 merged PRs");
  });

  it("renders a stalled-PR tag when the linked PR is stalled", () => {
    const out = renderSearch(
      searchOutput([
        searchCandidate({
          linkedPR: {
            number: 9,
            state: "open",
            url: "https://github.com/owner/repo/pull/9",
            isStalled: true,
          },
        }),
      ]),
    );
    expect(out).toContain("(stalled PR, revive opportunity)");
  });

  it("tags a positively boosted candidate", () => {
    const out = renderSearch(
      searchOutput([
        searchCandidate({
          boostScore: 5,
          boostReasons: ["repo affinity: owner/repo"],
        }),
      ]),
    );
    expect(out).toContain("[boosted: repo affinity: owner/repo]");
  });

  it("tags a net-negative boost as deprioritized", () => {
    const out = renderSearch(
      searchOutput([
        searchCandidate({
          boostScore: -3,
          boostReasons: ["avoid: owner/repo"],
        }),
      ]),
    );
    expect(out).toContain("[deprioritized: avoid: owner/repo]");
  });

  it("tags a diversity-slot candidate", () => {
    const out = renderSearch(
      searchOutput([searchCandidate({ diversitySlot: true })]),
    );
    expect(out).toContain("[diversity slot]");
  });

  it("does NOT include the rate-limit warning in the returned stdout string", () => {
    const out = renderSearch(
      searchOutput([searchCandidate()], {
        rateLimitWarning: "rate limit low",
      }),
    );
    expect(out).not.toContain("rate limit low");
  });
});

// ── renderFeatures ──────────────────────────────────────────────────

function featureCandidate(
  overrides: Partial<FeaturesOutput["quickWins"][number]> = {},
): FeaturesOutput["quickWins"][number] {
  return {
    issue: {
      repo: "owner/repo",
      number: 2,
      title: "Add a feature",
      url: "https://github.com/owner/repo/issues/2",
      labels: [],
    },
    recommendation: "approve",
    viabilityScore: 70,
    horizon: "quick-win",
    ...overrides,
  };
}

function featuresOutput(
  overrides: Partial<FeaturesOutput> = {},
): FeaturesOutput {
  return {
    quickWins: [],
    biggerBets: [],
    anchorRepos: ["owner/repo"],
    message: null,
    ...overrides,
  };
}

describe("renderFeatures", () => {
  it("returns an empty string when there is no message and nothing to list", () => {
    expect(renderFeatures(featuresOutput(), {})).toBe("");
  });

  it("returns just the message when total is zero but a message is present", () => {
    const out = renderFeatures(
      featuresOutput({ message: "No anchor repos yet." }),
      {},
    );
    expect(out).toBe("\nNo anchor repos yet.\n");
  });

  it("renders the anchor-scoped header and anchor repos line", () => {
    const out = renderFeatures(
      featuresOutput({ quickWins: [featureCandidate()] }),
      {},
    );
    expect(out).toContain("🎯 Feature opportunities in your anchor repos");
    expect(out).toContain("(1 quick wins + 0 bigger bets)");
    expect(out).toContain("Anchor repos: owner/repo");
  });

  it("renders the ecosystem header and omits anchor repos in broad mode", () => {
    const out = renderFeatures(
      featuresOutput({ quickWins: [featureCandidate()] }),
      { broad: true },
    );
    expect(out).toContain("🎯 Feature opportunities across the ecosystem");
    expect(out).not.toContain("Anchor repos:");
  });

  it("renders the Quick wins section", () => {
    const out = renderFeatures(
      featuresOutput({ quickWins: [featureCandidate()] }),
      {},
    );
    expect(out).toContain("── Quick wins");
    expect(out).toContain("owner/repo#2 [70/100] Add a feature");
    expect(out).toContain("     https://github.com/owner/repo/issues/2");
  });

  it("renders the Bigger bets section and a stalled tag", () => {
    const out = renderFeatures(
      featuresOutput({
        biggerBets: [
          featureCandidate({
            horizon: "bigger-bet",
            linkedPR: {
              number: 4,
              state: "open",
              url: "https://github.com/owner/repo/pull/4",
              isStalled: true,
            },
          }),
        ],
      }),
      {},
    );
    expect(out).toContain("── Bigger bets");
    expect(out).toContain("(stalled PR, revive opportunity)");
  });
});

// ── renderResults ───────────────────────────────────────────────────

function savedCandidate(
  overrides: Partial<SavedCandidate> = {},
): SavedCandidate {
  return {
    issueUrl: "https://github.com/owner/repo/issues/1",
    repo: "owner/repo",
    number: 1,
    title: "Fix the bug",
    labels: [],
    recommendation: "approve",
    viabilityScore: 75,
    searchPriority: "normal",
    firstSeenAt: "2026-03-01T00:00:00.000Z",
    lastSeenAt: "2026-03-01T00:00:00.000Z",
    lastScore: 75,
    ...overrides,
  };
}

describe("renderResults", () => {
  it("exposes the empty-state message as a constant", () => {
    expect(RESULTS_EMPTY_MESSAGE).toBe(
      "\nNo saved results. Run `oss-scout search` to find issues.\n",
    );
  });

  it("renders the header count, table header, and divider", () => {
    const out = renderResults([savedCandidate()]);
    expect(out).toContain("Saved results (1):");
    expect(out).toContain(
      "  Score  Repo                              Issue   Recommendation  Title",
    );
    expect(out).toContain(
      "  ─────  ────────────────────────────────  ──────  ──────────────  ─────",
    );
  });

  it("pads the score, repo, issue, and recommendation columns", () => {
    const out = renderResults([
      savedCandidate({ viabilityScore: 9, number: 3 }),
    ]);
    const row = out.split("\n").find((l) => l.includes("#3"))!;
    // score padStart(3): "  9"; then four spaces.
    expect(row).toContain("    9    ");
    expect(row).toContain("#3   ");
    // recommendation padEnd(14): "approve" + 7 spaces.
    expect(row).toContain("approve       ");
  });

  it("truncates titles longer than 50 chars with an ellipsis", () => {
    const longTitle = "x".repeat(60);
    const out = renderResults([savedCandidate({ title: longTitle })]);
    expect(out).toContain("x".repeat(47) + "...");
    expect(out).not.toContain("x".repeat(51));
  });
});

// ── renderVetList ───────────────────────────────────────────────────

function vetListResult(overrides: Partial<VetListResult> = {}): VetListResult {
  return {
    results: [],
    summary: {
      total: 0,
      stillAvailable: 0,
      claimed: 0,
      closed: 0,
      hasPR: 0,
      errors: 0,
    },
    transitions: [],
    ...overrides,
  };
}

describe("renderVetList", () => {
  it("exposes the empty-state message as a constant", () => {
    expect(VET_LIST_EMPTY_MESSAGE).toBe(
      "\nNo saved results to vet. Run `oss-scout search` first.\n",
    );
  });

  it("renders the header count and the summary line", () => {
    const out = renderVetList(
      vetListResult({
        results: [
          {
            issueUrl: "https://github.com/owner/repo/issues/1",
            repo: "owner/repo",
            number: 1,
            title: "Fix the bug",
            status: "still_available",
            ok: true,
            recommendation: "approve",
            viabilityScore: 88,
          },
        ],
        summary: {
          total: 1,
          stillAvailable: 1,
          claimed: 0,
          closed: 0,
          hasPR: 0,
          errors: 0,
        },
      }),
    );
    expect(out).toContain("Vet-list results (1):");
    expect(out).toContain("✅ owner/repo#1 — still_available [88/100]");
    expect(out).toContain("     Fix the bug");
    expect(out).toContain(
      "Summary: 1 available, 0 claimed, 0 has PR, 0 closed, 0 errors",
    );
  });

  it("renders each status icon", () => {
    const base = {
      issueUrl: "https://github.com/owner/repo/issues/1",
      repo: "owner/repo",
      number: 1,
      title: "t",
    };
    const out = renderVetList(
      vetListResult({
        results: [
          {
            ...base,
            number: 1,
            status: "still_available",
            ok: false,
            errorMessage: "",
          },
          {
            ...base,
            number: 2,
            status: "claimed",
            ok: false,
            errorMessage: "",
          },
          { ...base, number: 3, status: "has_pr", ok: false, errorMessage: "" },
          { ...base, number: 4, status: "closed", ok: false, errorMessage: "" },
          {
            ...base,
            number: 5,
            status: "error",
            ok: false,
            errorMessage: "boom",
          },
        ],
      }),
    );
    expect(out).toContain("✅ owner/repo#1");
    expect(out).toContain("🔒 owner/repo#2");
    expect(out).toContain("🔀 owner/repo#3");
    expect(out).toContain("🚫 owner/repo#4");
    expect(out).toContain("❌ owner/repo#5");
  });

  it("omits the score for an errored (ok: false) entry", () => {
    const out = renderVetList(
      vetListResult({
        results: [
          {
            issueUrl: "https://github.com/owner/repo/issues/1",
            repo: "owner/repo",
            number: 1,
            title: "t",
            status: "error",
            ok: false,
            errorMessage: "boom",
          },
        ],
      }),
    );
    expect(out).toContain("❌ owner/repo#1 — error");
    expect(out).not.toContain("/100");
  });

  it("renders the transitions block when transitions exist", () => {
    const out = renderVetList(
      vetListResult({
        transitions: [
          {
            issueUrl: "https://github.com/owner/repo/issues/1",
            repo: "owner/repo",
            number: 1,
            from: "still_available",
            to: "claimed",
          },
        ],
      }),
    );
    expect(out).toContain("🔔 Changes since last check (1):");
    expect(out).toContain("owner/repo#1: still_available → claimed");
  });

  it("omits the transitions block when there are none", () => {
    const out = renderVetList(vetListResult());
    expect(out).not.toContain("Changes since last check");
  });

  it("renders the pruned-count line when prunedCount is set", () => {
    const out = renderVetList(vetListResult({ prunedCount: 2 }));
    expect(out).toContain("Pruned 2 unavailable issues from saved results.");
  });

  it("omits the pruned-count line when prunedCount is absent", () => {
    const out = renderVetList(vetListResult());
    expect(out).not.toContain("Pruned");
  });
});

// ── renderVet ───────────────────────────────────────────────────────

function vetOutput(overrides: Partial<VetOutput> = {}): VetOutput {
  return {
    issue: {
      repo: "owner/repo",
      number: 1,
      title: "Fix the bug",
      url: "https://github.com/owner/repo/issues/1",
      labels: [],
    },
    recommendation: "approve",
    reasonsToApprove: [],
    reasonsToSkip: [],
    projectHealth: {
      repo: "owner/repo",
      lastCommitAt: "2026-06-01T00:00:00.000Z",
      daysSinceLastCommit: 3,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
    },
    // vettingResult is part of VetOutput but unused by the renderer; cast a
    // minimal stub to satisfy the type without importing the full schema.
    vettingResult: {} as VetOutput["vettingResult"],
    ...overrides,
  };
}

describe("renderVet", () => {
  it("renders the recommendation header in upper case with the icon", () => {
    const out = renderVet(vetOutput());
    expect(out).toContain("✅ owner/repo#1: APPROVE");
    expect(out).toContain("   Fix the bug");
    expect(out).toContain("   https://github.com/owner/repo/issues/1");
  });

  it("renders reasons to approve and skip", () => {
    const out = renderVet(
      vetOutput({
        reasonsToApprove: ["responsive maintainers"],
        reasonsToSkip: ["already claimed"],
      }),
    );
    expect(out).toContain("Reasons to approve:");
    expect(out).toContain("  + responsive maintainers");
    expect(out).toContain("Reasons to skip:");
    expect(out).toContain("  - already claimed");
  });

  it("renders the active project-health branch", () => {
    const out = renderVet(vetOutput());
    expect(out).toContain("Project health: Active");
    expect(out).toContain("  Last commit: 3 days ago");
    expect(out).toContain("  CI status: passing");
  });

  it("renders the inactive project-health branch", () => {
    const out = renderVet(
      vetOutput({
        projectHealth: {
          repo: "owner/repo",
          lastCommitAt: "2025-01-01T00:00:00.000Z",
          daysSinceLastCommit: 400,
          openIssuesCount: 10,
          avgIssueResponseDays: 2,
          ciStatus: "unknown",
          isActive: false,
        },
      }),
    );
    expect(out).toContain("Project health: Inactive");
  });

  it("renders the checkFailed project-health branch (#158)", () => {
    const out = renderVet(
      vetOutput({
        projectHealth: {
          repo: "owner/repo",
          checkFailed: true,
          failureReason: "GitHub API 502",
        },
      }),
    );
    expect(out).toContain(
      "Project health: unknown (check failed: GitHub API 502)",
    );
    expect(out).not.toContain("Last commit:");
  });
});
