import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IssueCandidate, ProjectHealth } from "./types.js";

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock("./logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./utils.js", () => ({
  parseGitHubUrl: vi.fn((url: string) => {
    const match = url.match(
      /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/,
    );
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      type: match[3],
      number: parseInt(match[4], 10),
    };
  }),
}));

vi.mock("./errors.js", () => ({
  ValidationError: class ValidationError extends Error {
    code = "VALIDATION_ERROR";
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  },
  errorMessage: vi.fn((e: unknown) =>
    e instanceof Error ? e.message : String(e),
  ),
  isRateLimitError: vi.fn(() => false),
}));

vi.mock("./issue-scoring.js", () => ({
  calculateRepoQualityBonus: vi.fn(() => 5),
  calculateViabilityScore: vi.fn(() => 75),
}));

vi.mock("./category-mapping.js", () => ({
  repoBelongsToCategory: vi.fn(() => false),
}));

vi.mock("./issue-eligibility.js", () => ({
  checkNoExistingPR: vi.fn().mockResolvedValue({ passed: true }),
  checkNotClaimed: vi.fn().mockResolvedValue({ passed: true }),
  checkUserMergedPRsInRepo: vi.fn().mockResolvedValue(0),
  analyzeRequirements: vi.fn(() => true),
}));

vi.mock("./repo-health.js", () => ({
  checkProjectHealth: vi.fn().mockResolvedValue({
    repo: "owner/repo",
    lastCommitAt: new Date().toISOString(),
    daysSinceLastCommit: 1,
    openIssuesCount: 10,
    avgIssueResponseDays: 2,
    ciStatus: "passing",
    isActive: true,
    stargazersCount: 500,
    forksCount: 50,
  } satisfies ProjectHealth),
  fetchContributionGuidelines: vi.fn().mockResolvedValue({
    url: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md",
    content: "Please read before contributing.",
  }),
}));

vi.mock("./http-cache.js", () => ({
  getHttpCache: vi.fn(() => ({
    getIfFresh: vi.fn(() => null),
    set: vi.fn(),
  })),
}));

import { IssueVetter, type ScoutStateReader } from "./issue-vetting.js";
import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from "./issue-eligibility.js";
import {
  checkProjectHealth,
  fetchContributionGuidelines,
} from "./repo-health.js";
import { repoBelongsToCategory } from "./category-mapping.js";
import { isRateLimitError } from "./errors.js";
import { getHttpCache } from "./http-cache.js";
import type { Octokit } from "@octokit/rest";

// ── Helpers ────────────────────────────────────────────────────────

function makeStubStateReader(
  overrides: Partial<ScoutStateReader> = {},
): ScoutStateReader {
  return {
    getReposWithMergedPRs: vi.fn(() => []),
    getStarredRepos: vi.fn(() => []),
    getPreferredOrgs: vi.fn(() => []),
    getProjectCategories: vi.fn(() => []),
    getRepoScore: vi.fn(() => null),
    ...overrides,
  };
}

function makeMockOctokit(): Octokit {
  return {
    issues: {
      get: vi.fn().mockResolvedValue({
        data: {
          id: 123,
          html_url: "https://github.com/owner/repo/issues/1",
          title: "Fix the bug",
          body: "1. Steps to reproduce\n2. Expected\n```js\ncode\n```",
          comments: 3,
          labels: [{ name: "bug" }],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-03-01T00:00:00Z",
        },
      }),
    },
  } as unknown as Octokit;
}

function makeVetter(
  stateOverrides: Partial<ScoutStateReader> = {},
): IssueVetter {
  const octokit = makeMockOctokit();
  const stateReader = makeStubStateReader(stateOverrides);
  return new IssueVetter(octokit, stateReader);
}

const VALID_ISSUE_URL = "https://github.com/owner/repo/issues/1";

// ── vetIssue ──────────────────────────────────────────────────────

describe("IssueVetter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    // Re-establish default mock implementations after restoreAllMocks
    vi.mocked(checkNoExistingPR).mockResolvedValue({ passed: true });
    vi.mocked(checkNotClaimed).mockResolvedValue({ passed: true });
    vi.mocked(checkUserMergedPRsInRepo).mockResolvedValue(0);
    vi.mocked(analyzeRequirements).mockReturnValue(true);
    vi.mocked(checkProjectHealth).mockResolvedValue({
      repo: "owner/repo",
      lastCommitAt: new Date().toISOString(),
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: "passing",
      isActive: true,
      stargazersCount: 500,
      forksCount: 50,
    });
    vi.mocked(fetchContributionGuidelines).mockResolvedValue({
      url: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md",
      content: "Please read before contributing.",
    });
    vi.mocked(repoBelongsToCategory).mockReturnValue(false);
    vi.mocked(isRateLimitError).mockReturnValue(false);
    vi.mocked(getHttpCache).mockReturnValue({
      getIfFresh: vi.fn(() => null),
      set: vi.fn(),
    } as unknown as ReturnType<typeof getHttpCache>);
  });

  describe("vetIssue", () => {
    it("recommends approve when all checks pass", async () => {
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.recommendation).toBe("approve");
      expect(result.vettingResult.passedAllChecks).toBe(true);
      expect(result.viabilityScore).toBeGreaterThan(0);
    });

    it("recommends skip when an existing PR is found", async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValueOnce({ passed: false });
      vi.mocked(checkNotClaimed).mockResolvedValueOnce({ passed: false });
      vi.mocked(analyzeRequirements).mockReturnValueOnce(false);
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.recommendation).toBe("skip");
      expect(result.reasonsToSkip).toContain("Has existing PR");
    });

    it("recommends skip when issue is claimed", async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValueOnce({ passed: false });
      vi.mocked(checkNotClaimed).mockResolvedValueOnce({ passed: false });
      vi.mocked(analyzeRequirements).mockReturnValueOnce(false);
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.recommendation).toBe("skip");
      expect(result.reasonsToSkip).toContain("Already claimed");
    });

    it("recommends skip when 2+ skip reasons exist", async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValueOnce({ passed: false });
      vi.mocked(checkNotClaimed).mockResolvedValueOnce({ passed: false });
      vi.mocked(analyzeRequirements).mockReturnValueOnce(false);
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      // Has existing PR + Already claimed + Unclear requirements = 3 reasons
      expect(result.recommendation).toBe("skip");
      expect(result.reasonsToSkip.length).toBeGreaterThanOrEqual(2);
    });

    it("downgrades approve to needs_review when checks are inconclusive", async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValueOnce({
        passed: true,
        inconclusive: true,
        reason: "API error",
      });
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.recommendation).toBe("needs_review");
      expect(result.vettingResult.notes).toContain(
        "Recommendation downgraded: one or more checks were inconclusive",
      );
    });

    it("throws ValidationError for invalid URL", async () => {
      const vetter = makeVetter();
      await expect(vetter.vetIssue("not-a-url")).rejects.toThrow(
        "Invalid issue URL",
      );
    });

    it("returns cached result within 15min TTL", async () => {
      const cachedResult: IssueCandidate = {
        issue: {
          id: 1,
          url: VALID_ISSUE_URL,
          repo: "owner/repo",
          number: 1,
          title: "Cached",
          status: "candidate",
          labels: [],
          createdAt: "",
          updatedAt: "",
          vetted: true,
          vettingResult: {
            passedAllChecks: true,
            checks: {
              noExistingPR: true,
              notClaimed: true,
              projectActive: true,
              clearRequirements: true,
              contributionGuidelinesFound: true,
            },
            notes: [],
          },
        },
        vettingResult: {
          passedAllChecks: true,
          checks: {
            noExistingPR: true,
            notClaimed: true,
            projectActive: true,
            clearRequirements: true,
            contributionGuidelinesFound: true,
          },
          notes: [],
        },
        projectHealth: {
          repo: "owner/repo",
          lastCommitAt: "",
          daysSinceLastCommit: 1,
          openIssuesCount: 5,
          avgIssueResponseDays: 1,
          ciStatus: "passing",
          isActive: true,
        },
        recommendation: "approve",
        reasonsToSkip: [],
        reasonsToApprove: ["Cached"],
        viabilityScore: 90,
        searchPriority: "normal",
      };

      vi.mocked(getHttpCache).mockReturnValue({
        getIfFresh: vi.fn(() => cachedResult),
        set: vi.fn(),
      } as unknown as ReturnType<typeof getHttpCache>);

      const callsBefore = vi.mocked(checkNoExistingPR).mock.calls.length;
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result).toBe(cachedResult);
      // Verify no NEW calls were made (cache short-circuited)
      expect(vi.mocked(checkNoExistingPR).mock.calls.length).toBe(callsBefore);
    });

    it("sets priority to merged_pr when user has merged PRs in repo", async () => {
      vi.mocked(checkUserMergedPRsInRepo).mockResolvedValueOnce(2);
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.searchPriority).toBe("merged_pr");
      expect(result.reasonsToApprove).toContainEqual(
        expect.stringContaining("Trusted project"),
      );
    });

    it("adds org affinity reason when user has merged PRs in same org", async () => {
      const vetter = makeVetter({
        getReposWithMergedPRs: vi.fn(() => ["owner/other-repo"]),
      });
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.reasonsToApprove).toContainEqual(
        expect.stringContaining("Org affinity"),
      );
    });

    it("adds category match reason when repo matches preferred category", async () => {
      vi.mocked(repoBelongsToCategory).mockReturnValueOnce(true);
      const vetter = makeVetter();
      const result = await vetter.vetIssue(VALID_ISSUE_URL);
      expect(result.reasonsToApprove).toContain(
        "Matches preferred project category",
      );
    });
  });

  // ── vetIssuesParallel ─────────────────────────────────────────────

  describe("vetIssuesParallel", () => {
    it("returns multiple candidates on success", async () => {
      const vetter = makeVetter();
      const urls = [
        "https://github.com/owner/repo/issues/1",
        "https://github.com/owner/repo/issues/2",
      ];
      const result = await vetter.vetIssuesParallel(urls, 10);
      expect(result.candidates.length).toBe(2);
      expect(result.allFailed).toBe(false);
      expect(result.rateLimitHit).toBe(false);
    });

    it("respects concurrency limit (MAX_CONCURRENT_VETTING=3)", async () => {
      // Create 5 URLs — only 3 should be in flight at once
      const urls = Array.from(
        { length: 5 },
        (_, i) => `https://github.com/owner/repo/issues/${i + 1}`,
      );

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      // Use the real Octokit mock but track concurrency
      const octokit = makeMockOctokit();
      vi.mocked(checkNoExistingPR).mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return { passed: true };
      });

      const stateReader = makeStubStateReader();
      const vetter = new IssueVetter(octokit, stateReader);
      await vetter.vetIssuesParallel(urls, 10);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    it("returns successful candidates when some fail (partial failure)", async () => {
      const octokit = {
        issues: {
          get: vi
            .fn()
            .mockResolvedValueOnce({
              data: {
                id: 1,
                html_url: "https://github.com/owner/repo/issues/1",
                title: "Good issue",
                body: "1. Step\n2. Step\n```code```",
                comments: 0,
                labels: [],
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-03-01T00:00:00Z",
              },
            })
            .mockRejectedValueOnce(new Error("Not found")),
        },
      } as unknown as Octokit;

      const stateReader = makeStubStateReader();
      const vetter = new IssueVetter(octokit, stateReader);
      const result = await vetter.vetIssuesParallel(
        [
          "https://github.com/owner/repo/issues/1",
          "https://github.com/owner/repo/issues/2",
        ],
        10,
      );
      expect(result.candidates.length).toBe(1);
      expect(result.allFailed).toBe(false);
    });

    it("sets allFailed:true when all vetting attempts fail", async () => {
      const octokit = {
        issues: {
          get: vi.fn().mockRejectedValue(new Error("Server error")),
        },
      } as unknown as Octokit;

      const stateReader = makeStubStateReader();
      const vetter = new IssueVetter(octokit, stateReader);
      const result = await vetter.vetIssuesParallel(
        [
          "https://github.com/owner/repo/issues/1",
          "https://github.com/owner/repo/issues/2",
        ],
        10,
      );
      expect(result.candidates).toHaveLength(0);
      expect(result.allFailed).toBe(true);
    });

    it("sets rateLimitHit:true when failures are rate-limit errors", async () => {
      vi.mocked(isRateLimitError).mockReturnValue(true);

      const octokit = {
        issues: {
          get: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error("rate limit exceeded"), { status: 429 }),
            ),
        },
      } as unknown as Octokit;

      const stateReader = makeStubStateReader();
      const vetter = new IssueVetter(octokit, stateReader);
      const result = await vetter.vetIssuesParallel(
        ["https://github.com/owner/repo/issues/1"],
        10,
      );
      expect(result.rateLimitHit).toBe(true);
    });
  });
});
