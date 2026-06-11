/**
 * E2E test — exercises the real OssScout search pipeline end-to-end.
 *
 * Only the Octokit boundary is mocked (canned search / timeline / repo / content
 * responses). Discovery, phase gating, filtering, vetting, scoring, and
 * persistence all run for real, so this catches cross-phase regressions that a
 * test mocking the whole IssueDiscovery engine cannot (#161).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;

// Mock only the Octokit boundary. getOctokit is shared by discovery, the
// budget pre-flight (checkRateLimit), and vetting, so one fake octokit drives
// the whole pipeline. checkRateLimit stays real (it calls the mocked
// getOctokit internally).
const { fakeOctokit } = vi.hoisted(() => {
  // Recent so the issue survives buildIssueFilter's maxIssueAgeDays (90) gate
  // and the repo reads as active. created_at can stay old.
  const recentIso = new Date(
    Date.now() - 3 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const issueItem = {
    id: 101,
    html_url: "https://github.com/test-org/test-repo/issues/7",
    number: 7,
    title: "Add dark mode support to the settings panel",
    body: "We should add a dark mode toggle. Steps: 1) add a theme context, 2) wire the toggle, 3) persist the choice.",
    labels: [{ name: "good first issue" }, { name: "enhancement" }],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: recentIso,
    state: "open",
    user: { login: "maintainer" },
    repository_url: "https://api.github.com/repos/test-org/test-repo",
  };

  const fakeOctokit = {
    rateLimit: {
      get: vi.fn().mockResolvedValue({
        data: {
          resources: {
            // reset is read via new Date(reset * 1000); use a far-future epoch.
            search: { remaining: 5000, limit: 5000, reset: 4102444800 },
            core: { remaining: 5000, limit: 5000, reset: 4102444800 },
          },
        },
      }),
    },
    search: {
      issuesAndPullRequests: vi.fn(async ({ q }: { q: string }) => {
        // The user's merged-PR affinity check searches for is:pr is:merged.
        if (typeof q === "string" && q.includes("is:pr")) {
          return { data: { total_count: 0, items: [] } };
        }
        // Issue discovery phases.
        return { data: { total_count: 1, items: [issueItem] } };
      }),
    },
    issues: {
      // vetIssue re-fetches the full issue by URL.
      get: vi.fn().mockResolvedValue({
        data: {
          id: 101,
          number: 7,
          title: "Add dark mode support to the settings panel",
          body: "We should add a dark mode toggle. Steps: 1) add a theme context, 2) wire the toggle, 3) persist the choice.",
          state: "open",
          labels: [{ name: "good first issue" }, { name: "enhancement" }],
          created_at: "2025-01-01T00:00:00Z",
          updated_at: recentIso,
          user: { login: "maintainer" },
          html_url: "https://github.com/test-org/test-repo/issues/7",
        },
      }),
      listEventsForTimeline: vi.fn().mockResolvedValue({ data: [] }),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      listForRepo: vi.fn().mockResolvedValue({ data: [] }),
    },
    repos: {
      get: vi.fn().mockResolvedValue({
        data: {
          pushed_at: recentIso,
          stargazers_count: 500,
          forks_count: 40,
          open_issues_count: 12,
          owner: { login: "test-org" },
          name: "test-repo",
        },
      }),
      listCommits: vi.fn().mockResolvedValue({
        data: [{ commit: { author: { date: recentIso } } }],
      }),
      // No CONTRIBUTING / CODE_OF_CONDUCT / README files: 404 = clean absent.
      getContent: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Not Found"), { status: 404 }),
        ),
    },
  };
  return { fakeOctokit };
});

vi.mock("../core/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/github.js")>();
  return {
    ...actual,
    getOctokit: () =>
      fakeOctokit as unknown as ReturnType<typeof actual.getOctokit>,
    // checkRateLimit calls github.js's INTERNAL getOctokit (intra-module
    // binding the export override can't reach), so stub it directly.
    checkRateLimit: async () => ({
      remaining: 5000,
      limit: 5000,
      resetAt: new Date(4102444800000).toISOString(),
    }),
  };
});

// Real on-disk cache, pointed at a temp dir so the pipeline's caching runs for
// real without touching ~/.oss-scout.
vi.mock("../core/http-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/http-cache.js")>();
  let cache: InstanceType<typeof actual.HttpCache> | null = null;
  return {
    ...actual,
    getHttpCache: () => {
      if (!cache) cache = new actual.HttpCache(tmpDir);
      return cache;
    },
  };
});

vi.mock("../core/logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => "info"),
  enableDebug: vi.fn(),
}));

const { OssScout } = await import("../scout.js");
const { ScoutStateSchema } = await import("../core/schemas.js");

function freshScout() {
  const state = ScoutStateSchema.parse({
    version: 1,
    preferences: {
      githubUsername: "tester",
      // Permissive filters so the canned issue survives to vetting.
      languages: ["any"],
      labels: ["good first issue", "help wanted"],
      minStars: 0,
      minRepoScoreThreshold: 1,
    },
  });
  return new OssScout("test-token", state);
}

describe("search pipeline e2e (#161)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oss-scout-e2e-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs discovery, vetting, and scoring against the Octokit boundary", async () => {
    const scout = freshScout();

    const result = await scout.search({
      maxResults: 5,
      interPhaseDelayMs: 0,
      broadPhaseDelayMs: 0,
    });

    // The real discovery engine selected at least one strategy and the canned
    // issue crossed phase gating + filtering into a vetted candidate.
    expect(result.strategiesUsed.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);

    const candidate = result.candidates[0];
    expect(candidate.issue.repo).toBe("test-org/test-repo");
    expect(candidate.issue.number).toBe(7);
    // Scoring ran for real (a number in range), not a canned value.
    expect(typeof candidate.viabilityScore).toBe("number");
    expect(candidate.viabilityScore).toBeGreaterThanOrEqual(0);
    // Vetting ran for real: no PR (empty timeline) and not claimed (no comments).
    expect(candidate.vettingResult.checks.noExistingPR).toBe(true);
    expect(candidate.vettingResult.checks.notClaimed).toBe(true);
    // The real project-health check consumed the repo + commits responses.
    expect(fakeOctokit.repos.get).toHaveBeenCalled();

    // Real search-API calls were issued (not a mocked IssueDiscovery).
    expect(fakeOctokit.search.issuesAndPullRequests).toHaveBeenCalled();
  });

  it("persists vetted results via saveResults (the command-layer bookkeeping)", async () => {
    const scout = freshScout();
    const result = await scout.search({
      maxResults: 5,
      interPhaseDelayMs: 0,
      broadPhaseDelayMs: 0,
    });

    // search() returns candidates; the command layer persists them. Mirror it.
    scout.saveResults(result.candidates);

    const saved = scout.getSavedResults();
    expect(saved.length).toBe(result.candidates.length);
    expect(saved.some((r) => r.issueUrl.includes("test-repo/issues/7"))).toBe(
      true,
    );
  });
});
