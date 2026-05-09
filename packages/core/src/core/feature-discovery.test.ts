import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoScore } from "./schemas.js";
import {
  resolveAnchorRepos,
  ANCHOR_THRESHOLD,
  classifyHorizon,
  splitByHorizon,
  discoverFeatures,
  detectWontfixNoContributor,
  WONTFIX_MIN_AGE_DAYS,
  type FeatureCandidate,
} from "./feature-discovery.js";
import { _clearRoadmapCacheForTests } from "./roadmap.js";

const mkScore = (repo: string, mergedPRCount: number): RepoScore => ({
  repo,
  score: 5,
  mergedPRCount,
  closedWithoutMergeCount: 0,
  avgResponseDays: null,
  lastEvaluatedAt: "2026-05-08T00:00:00Z",
  signals: {
    hasActiveMaintainers: true,
    isResponsive: true,
    hasHostileComments: false,
  },
});

const mkScores = (
  ...entries: Array<[string, number]>
): Record<string, RepoScore> =>
  Object.fromEntries(
    entries.map(([repo, count]) => [repo, mkScore(repo, count)]),
  );

describe("resolveAnchorRepos", () => {
  it("returns empty array when no scores meet threshold", () => {
    const out = resolveAnchorRepos(mkScores(["a/b", 1], ["c/d", 2]));
    expect(out).toEqual([]);
  });
  it("filters by ANCHOR_THRESHOLD (3)", () => {
    expect(ANCHOR_THRESHOLD).toBe(3);
    const out = resolveAnchorRepos(
      mkScores(["a/b", 2], ["c/d", 3], ["e/f", 5]),
    );
    expect(out).toEqual(["e/f", "c/d"]);
  });
  it("sorts by mergedPRCount desc", () => {
    const out = resolveAnchorRepos(
      mkScores(["a/b", 4], ["c/d", 10], ["e/f", 7]),
    );
    expect(out).toEqual(["c/d", "e/f", "a/b"]);
  });
  it("honors an explicit threshold override", () => {
    const out = resolveAnchorRepos(
      mkScores(["a/b", 3], ["c/d", 5], ["e/f", 8]),
      5,
    );
    expect(out).toEqual(["e/f", "c/d"]);
  });
  it("defaults to ANCHOR_THRESHOLD when threshold is undefined", () => {
    const out = resolveAnchorRepos(mkScores(["a/b", 2], ["c/d", 3]), undefined);
    expect(out).toEqual(["c/d"]);
  });
});

describe("detectWontfixNoContributor", () => {
  const NOW = new Date("2026-05-09T00:00:00Z");
  const oldCreated = new Date(
    NOW.getTime() - (WONTFIX_MIN_AGE_DAYS + 5) * 86400000,
  ).toISOString();
  const recentCreated = new Date(
    NOW.getTime() - 10 * 86400000,
  ).toISOString();

  it("returns true with help-wanted label and old enough age", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["help wanted"],
        createdAt: oldCreated,
        now: NOW,
      }),
    ).toBe(true);
  });
  it("returns false when no qualifying label is present", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["enhancement"],
        createdAt: oldCreated,
        now: NOW,
      }),
    ).toBe(false);
  });
  it("returns false for an issue younger than 60 days", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["help wanted"],
        createdAt: recentCreated,
        now: NOW,
      }),
    ).toBe(false);
  });
  it("matches case-insensitively", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["Help Wanted"],
        createdAt: oldCreated,
        now: NOW,
      }),
    ).toBe(true);
  });
  it("recognises contributions-welcome, up-for-grabs, bounty, pinned, unmaintained", () => {
    for (const label of [
      "contributions welcome",
      "up-for-grabs",
      "bounty",
      "pinned",
      "unmaintained",
    ]) {
      expect(
        detectWontfixNoContributor({
          labels: [label],
          createdAt: oldCreated,
          now: NOW,
        }),
      ).toBe(true);
    }
  });
  it("returns false on unparseable createdAt", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["help wanted"],
        createdAt: "not-a-date",
        now: NOW,
      }),
    ).toBe(false);
  });
  it("respects custom minAgeDays override", () => {
    expect(
      detectWontfixNoContributor({
        labels: ["help wanted"],
        createdAt: recentCreated,
        now: NOW,
        minAgeDays: 5,
      }),
    ).toBe(true);
  });
});

describe("classifyHorizon", () => {
  it("returns bigger-bet when issue has a milestone", () => {
    expect(classifyHorizon({ hasMilestone: true, labels: [] })).toBe(
      "bigger-bet",
    );
  });
  it("returns bigger-bet for roadmap label", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["roadmap"] })).toBe(
      "bigger-bet",
    );
  });
  it("returns bigger-bet for accepted-rfc label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["accepted-rfc"] }),
    ).toBe("bigger-bet");
  });
  it("returns bigger-bet for proposal label", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["proposal"] })).toBe(
      "bigger-bet",
    );
  });
  it("returns quick-win for plain enhancement label", () => {
    expect(
      classifyHorizon({ hasMilestone: false, labels: ["enhancement"] }),
    ).toBe("quick-win");
  });
  it("returns quick-win when no signals fire", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: [] })).toBe(
      "quick-win",
    );
  });
  it("is case-insensitive on label matching", () => {
    expect(classifyHorizon({ hasMilestone: false, labels: ["Roadmap"] })).toBe(
      "bigger-bet",
    );
  });
});

const mkCand = (
  url: string,
  score: number,
  horizon: "quick-win" | "bigger-bet",
): FeatureCandidate =>
  ({
    issue: {
      url,
      repo: "x/y",
      number: 1,
      title: url,
      labels: [],
      updatedAt: "2026-05-08",
    },
    vettingResult: {} as never,
    projectHealth: {} as never,
    antiLLMPolicy: {} as never,
    slmTriage: null,
    recommendation: "approve",
    reasonsToApprove: [],
    reasonsToSkip: [],
    viabilityScore: score,
    searchPriority: "merged_pr",
    horizon,
  }) as never;

describe("splitByHorizon 60/40 split", () => {
  const quickWinPool = [
    mkCand("q1", 90, "quick-win"),
    mkCand("q2", 88, "quick-win"),
    mkCand("q3", 85, "quick-win"),
    mkCand("q4", 82, "quick-win"),
    mkCand("q5", 80, "quick-win"),
    mkCand("q6", 78, "quick-win"),
    mkCand("q7", 75, "quick-win"),
    mkCand("q8", 72, "quick-win"),
  ];
  const biggerBetPool = [
    mkCand("b1", 95, "bigger-bet"),
    mkCand("b2", 92, "bigger-bet"),
    mkCand("b3", 88, "bigger-bet"),
    mkCand("b4", 85, "bigger-bet"),
    mkCand("b5", 80, "bigger-bet"),
  ];

  it("returns 6 quick + 4 bigger when count=10 and both abundant", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins).toHaveLength(6);
    expect(out.biggerBets).toHaveLength(4);
  });
  it("returns 3 quick + 2 bigger when count=5", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 5);
    expect(out.quickWins).toHaveLength(3);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("redirects deficit to other bucket when one is short", () => {
    const out = splitByHorizon(
      [...quickWinPool, biggerBetPool[0], biggerBetPool[1]],
      10,
    );
    // target 6+4, but only 2 bigger bets exist → fill quick to 8.
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(2);
  });
  it("returns all of one bucket when other is empty", () => {
    const out = splitByHorizon([...quickWinPool], 10);
    expect(out.quickWins).toHaveLength(8);
    expect(out.biggerBets).toHaveLength(0);
  });
  it("sorts each bucket by score desc", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10);
    expect(out.quickWins.map((c) => c.viabilityScore)).toEqual([
      90, 88, 85, 82, 80, 78,
    ]);
    expect(out.biggerBets.map((c) => c.viabilityScore)).toEqual([
      95, 92, 88, 85,
    ]);
  });
  it("honors an explicit ratio override (0.5 = 5+5 at count 10)", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 10, 0.5);
    expect(out.quickWins).toHaveLength(5);
    expect(out.biggerBets).toHaveLength(5);
  });
  it("ratio 1.0 puts all into quick wins", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 5, 1);
    expect(out.quickWins).toHaveLength(5);
    expect(out.biggerBets).toHaveLength(0);
  });
  it("ratio 0 puts all into bigger bets when both available", () => {
    const out = splitByHorizon([...quickWinPool, ...biggerBetPool], 4, 0);
    expect(out.quickWins).toHaveLength(0);
    expect(out.biggerBets).toHaveLength(4);
  });
});

describe("discoverFeatures orchestrator", () => {
  beforeEach(() => {
    _clearRoadmapCacheForTests();
  });

  it("returns no-anchors message when repoScores has no qualifying repos", async () => {
    const octokit = { issues: { listForRepo: vi.fn() } } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 1]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual([]);
    expect(result.quickWins).toEqual([]);
    expect(result.biggerBets).toEqual([]);
    expect(result.message).toContain("No anchor repos yet");
    expect(octokit.issues.listForRepo).not.toHaveBeenCalled();
  });

  it("returns no-results message when anchors exist but no feature issues found", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual(["a/b"]);
    expect(result.quickWins).toEqual([]);
    expect(result.biggerBets).toEqual([]);
    expect(result.message).toContain("No open feature opportunities");
  });

  it("classifies, vets, and splits issues into horizons", async () => {
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            {
              html_url: "https://github.com/a/b/issues/1",
              title: "small enhancement",
              labels: [{ name: "enhancement" }],
              updated_at: "2026-05-01",
              comments: 2,
              reactions: { total_count: 4 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
            },
            {
              html_url: "https://github.com/a/b/issues/2",
              title: "big proposal",
              labels: [{ name: "proposal" }],
              updated_at: "2026-05-01",
              comments: 30,
              reactions: { total_count: 50 },
              milestone: { number: 1 },
              pull_request: undefined,
              assignee: null,
            },
          ],
        }),
      },
    } as never;
    const vetter = {
      vetIssue: vi.fn().mockImplementation(async (url: string) => ({
        issue: {
          url,
          repo: "a/b",
          number: 1,
          title: "t",
          labels: [],
          updatedAt: "2026-05-01",
        },
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
        projectHealth: {},
        antiLLMPolicy: {
          matched: false,
          matchedKeywords: [],
          sourceFile: null,
        },
        slmTriage: null,
        recommendation: "approve",
        reasonsToApprove: [],
        reasonsToSkip: [],
        viabilityScore: 80,
        searchPriority: "merged_pr",
      })),
    } as never;
    const result = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 10,
    });
    expect(result.anchorRepos).toEqual(["a/b"]);
    expect(result.quickWins).toHaveLength(1);
    expect(result.biggerBets).toHaveLength(1);
    expect(result.quickWins[0].horizon).toBe("quick-win");
    expect(result.biggerBets[0].horizon).toBe("bigger-bet");
    expect(result.message).toBeNull();
    expect(vetter.vetIssue).toHaveBeenCalledWith(
      "https://github.com/a/b/issues/1",
      {
        featureSignals: {
          reactions: 4,
          comments: 2,
          hasMilestone: false,
          wontfixNoContributor: false,
          onRoadmap: false,
        },
      },
    );
    expect(vetter.vetIssue).toHaveBeenCalledWith(
      "https://github.com/a/b/issues/2",
      {
        featureSignals: {
          reactions: 50,
          comments: 30,
          hasMilestone: true,
          wontfixNoContributor: false,
          onRoadmap: false,
        },
      },
    );
  });

  it("honors anchorThreshold and splitRatio overrides", async () => {
    // Build issues so quick-win and bigger-bet candidates both exist.
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            {
              html_url: "https://github.com/a/b/issues/1",
              title: "qw",
              labels: [{ name: "enhancement" }],
              comments: 1,
              reactions: { total_count: 1 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
            },
            {
              html_url: "https://github.com/a/b/issues/2",
              title: "bb",
              labels: [{ name: "proposal" }],
              comments: 1,
              reactions: { total_count: 1 },
              milestone: { number: 1 },
              pull_request: undefined,
              assignee: null,
            },
          ],
        }),
      },
    } as never;
    const vetter = {
      vetIssue: vi.fn().mockImplementation(async (url: string) => ({
        issue: {
          url,
          repo: "a/b",
          number: 1,
          title: "t",
          labels: [],
          updatedAt: "2026-05-01",
        },
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
        projectHealth: {},
        antiLLMPolicy: {
          matched: false,
          matchedKeywords: [],
          sourceFile: null,
        },
        slmTriage: null,
        recommendation: "approve",
        reasonsToApprove: [],
        reasonsToSkip: [],
        viabilityScore: 80,
        searchPriority: "merged_pr",
      })),
    } as never;

    // anchorThreshold 10 → "a/b" (mergedPRCount 4) is below threshold; no anchors.
    const tightened = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 10,
      anchorThreshold: 10,
    });
    expect(tightened.anchorRepos).toEqual([]);
    expect(tightened.message).toContain("No anchor repos yet");

    // anchorThreshold 1 enables the anchor; splitRatio 0.5 → 1 quick + 1 bigger
    // (rounding behavior with count=2 and one of each candidate).
    vi.mocked(octokit.issues.listForRepo).mockClear();
    vi.mocked(vetter.vetIssue).mockClear();
    const split = await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 2,
      anchorThreshold: 1,
      splitRatio: 0.5,
    });
    expect(split.anchorRepos).toEqual(["a/b"]);
    expect(split.quickWins).toHaveLength(1);
    expect(split.biggerBets).toHaveLength(1);
  });

  it("forwards wontfixNoContributor signal to the vetter when label + age qualify", async () => {
    const oldCreated = new Date(
      Date.now() - (WONTFIX_MIN_AGE_DAYS + 30) * 86400000,
    ).toISOString();
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            {
              html_url: "https://github.com/a/b/issues/9",
              title: "long-open feature ask",
              labels: [{ name: "enhancement" }, { name: "help wanted" }],
              comments: 1,
              reactions: { total_count: 1 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
              created_at: oldCreated,
            },
          ],
        }),
      },
    } as never;
    const vetter = {
      vetIssue: vi.fn().mockImplementation(async (url: string) => ({
        issue: {
          url,
          repo: "a/b",
          number: 9,
          title: "t",
          labels: [],
          updatedAt: "2026-05-01",
        },
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
        projectHealth: {},
        antiLLMPolicy: {
          matched: false,
          matchedKeywords: [],
          sourceFile: null,
        },
        slmTriage: null,
        recommendation: "approve",
        reasonsToApprove: [],
        reasonsToSkip: [],
        viabilityScore: 80,
        searchPriority: "merged_pr",
      })),
    } as never;
    await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 5,
    });
    expect(vetter.vetIssue).toHaveBeenCalledWith(
      "https://github.com/a/b/issues/9",
      {
        featureSignals: {
          reactions: 1,
          comments: 1,
          hasMilestone: false,
          wontfixNoContributor: true,
          onRoadmap: false,
        },
      },
    );
  });

  it("forwards onRoadmap signal when an issue number appears in ROADMAP.md", async () => {
    const md = "Roadmap:\n- ship #7 soon\n";
    const octokit = {
      issues: {
        listForRepo: vi.fn().mockResolvedValue({
          data: [
            {
              html_url: "https://github.com/a/b/issues/7",
              title: "roadmap-listed feature",
              labels: [{ name: "enhancement" }],
              comments: 1,
              reactions: { total_count: 1 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
              created_at: "2026-04-01",
              number: 7,
            },
            {
              html_url: "https://github.com/a/b/issues/8",
              title: "off-roadmap feature",
              labels: [{ name: "enhancement" }],
              comments: 1,
              reactions: { total_count: 1 },
              milestone: null,
              pull_request: undefined,
              assignee: null,
              created_at: "2026-04-01",
              number: 8,
            },
          ],
        }),
      },
      repos: {
        getContent: vi.fn().mockImplementation(async ({ path }) => {
          if (path === "ROADMAP.md") {
            return {
              data: { content: Buffer.from(md, "utf-8").toString("base64") },
            };
          }
          throw Object.assign(new Error("nope"), { status: 404 });
        }),
      },
    } as never;
    const vetter = {
      vetIssue: vi.fn().mockImplementation(async (url: string) => ({
        issue: {
          url,
          repo: "a/b",
          number: 1,
          title: "t",
          labels: [],
          updatedAt: "2026-05-01",
        },
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
        projectHealth: {},
        antiLLMPolicy: {
          matched: false,
          matchedKeywords: [],
          sourceFile: null,
        },
        slmTriage: null,
        recommendation: "approve",
        reasonsToApprove: [],
        reasonsToSkip: [],
        viabilityScore: 80,
        searchPriority: "merged_pr",
      })),
    } as never;
    await discoverFeatures({
      octokit,
      vetter,
      repoScores: mkScores(["a/b", 4]),
      count: 5,
    });
    const calls = vi.mocked(vetter.vetIssue).mock.calls;
    const onRoadmap7 = calls.find(
      (c) => c[0] === "https://github.com/a/b/issues/7",
    )?.[1]?.featureSignals?.onRoadmap;
    const onRoadmap8 = calls.find(
      (c) => c[0] === "https://github.com/a/b/issues/8",
    )?.[1]?.featureSignals?.onRoadmap;
    expect(onRoadmap7).toBe(true);
    expect(onRoadmap8).toBe(false);
  });

  it("propagates auth and rate-limit errors", async () => {
    const error = Object.assign(new Error("401"), { status: 401 });
    const octokit = {
      issues: { listForRepo: vi.fn().mockRejectedValue(error) },
    } as never;
    const vetter = { vetIssue: vi.fn() } as never;
    await expect(
      discoverFeatures({
        octokit,
        vetter,
        repoScores: mkScores(["a/b", 4]),
        count: 10,
      }),
    ).rejects.toThrow();
  });
});
