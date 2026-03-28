import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueCandidate, SearchPriority, ProjectHealth } from './types.js';
import type { IssueVettingResult, TrackedIssue, ScoutPreferences } from './schemas.js';
import type { ScoutStateReader } from './issue-vetting.js';
import type { GitHubSearchItem } from './issue-filtering.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('./github.js', () => ({
  getOctokit: vi.fn(() => ({})),
  checkRateLimit: vi.fn(async () => ({
    remaining: 30,
    limit: 30,
    resetAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}));

const mockTrackerInit = vi.fn();
const mockTrackerGetTotalCalls = vi.fn(() => 0);
vi.mock('./search-budget.js', () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    init: mockTrackerInit,
    getTotalCalls: mockTrackerGetTotalCalls,
  })),
}));

const mockVetIssuesParallel = vi.fn(async () => ({
  candidates: [],
  allFailed: false,
  rateLimitHit: false,
}));
vi.mock('./issue-vetting.js', () => ({
  IssueVetter: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.vetIssuesParallel = mockVetIssuesParallel;
  }),
}));

const mockSearchInRepos = vi.fn(async () => ({
  candidates: [],
  allBatchesFailed: false,
  rateLimitHit: false,
}));
const mockSearchWithChunkedLabels = vi.fn(async () => []);
const mockCachedSearchIssues = vi.fn(async () => ({
  total_count: 0,
  items: [],
}));
const mockFilterVetAndScore = vi.fn(async () => ({
  candidates: [],
  allVetFailed: false,
  rateLimitHit: false,
}));
const mockBuildEffectiveLabels = vi.fn((_scopes: unknown, labels: string[]) => labels);
const mockInterleaveArrays = vi.fn(<T>(arrays: T[][]) => arrays.flat());

vi.mock('./search-phases.js', () => ({
  buildEffectiveLabels: (...args: unknown[]) => mockBuildEffectiveLabels(...args),
  interleaveArrays: (...args: unknown[]) => mockInterleaveArrays(...args),
  cachedSearchIssues: (...args: unknown[]) => mockCachedSearchIssues(...args),
  filterVetAndScore: (...args: unknown[]) => mockFilterVetAndScore(...args),
  searchInRepos: (...args: unknown[]) => mockSearchInRepos(...args),
  searchWithChunkedLabels: (...args: unknown[]) => mockSearchWithChunkedLabels(...args),
}));

vi.mock('./issue-filtering.js', () => ({
  isDocOnlyIssue: vi.fn(() => false),
  applyPerRepoCap: vi.fn(<T>(candidates: T[], _max: number) => candidates),
}));

vi.mock('./category-mapping.js', () => ({
  getTopicsForCategories: vi.fn(() => []),
}));

vi.mock('./logger.js', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  daysBetween: vi.fn(() => 1),
  sleep: vi.fn(async () => {}),
}));

// Import after mocks
import { IssueDiscovery } from './issue-discovery.js';
import { checkRateLimit } from './github.js';
import { applyPerRepoCap } from './issue-filtering.js';
import { daysBetween } from './utils.js';
import { ValidationError } from './errors.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeStateReader(overrides: Partial<ScoutStateReader> = {}): ScoutStateReader {
  return {
    getReposWithMergedPRs: () => [],
    getStarredRepos: () => [],
    getPreferredOrgs: () => [],
    getProjectCategories: () => [],
    getRepoScore: () => null,
    ...overrides,
  };
}

function makePreferences(overrides: Partial<ScoutPreferences> = {}): ScoutPreferences {
  return {
    languages: ['typescript'],
    labels: ['good first issue'],
    excludeRepos: [],
    minStars: 50,
    maxIssueAgeDays: 90,
    minRepoScoreThreshold: 3,
    includeDocIssues: true,
    aiPolicyBlocklist: [],
    ...overrides,
  } as ScoutPreferences;
}

function makeCandidate(
  repo: string,
  priority: SearchPriority = 'normal',
  recommendation: 'approve' | 'skip' | 'needs_review' = 'approve',
  score = 80,
): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: `https://github.com/${repo}/issues/1`,
      repo,
      number: 1,
      title: 'Test issue',
      status: 'candidate',
      labels: ['good first issue'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as TrackedIssue,
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
    } as IssueVettingResult,
    projectHealth: {
      repo,
      lastCommitAt: new Date().toISOString(),
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: 'passing',
      isActive: true,
      stargazersCount: 1000,
    } as ProjectHealth,
    recommendation,
    reasonsToSkip: [],
    reasonsToApprove: ['Active project'],
    viabilityScore: score,
    searchPriority: priority,
  };
}

function makeSearchItem(repo: string, daysOld = 1): GitHubSearchItem {
  const date = new Date();
  date.setDate(date.getDate() - daysOld);
  return {
    html_url: `https://github.com/${repo}/issues/1`,
    repository_url: `https://api.github.com/repos/${repo}`,
    updated_at: date.toISOString(),
    title: 'Test issue',
    labels: [{ name: 'good first issue' }],
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('IssueDiscovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: healthy rate limit
    vi.mocked(checkRateLimit).mockResolvedValue({
      remaining: 30,
      limit: 30,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
    });
  });

  describe('Phase 0: merged-PR repos', () => {
    it('calls searchInRepos with merged-PR repos and priority merged_pr', async () => {
      const mergedRepos = ['org/repo-a', 'org/repo-b'];
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => mergedRepos,
      });
      const candidate = makeCandidate('org/repo-a', 'merged_pr');
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [candidate],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(mockSearchInRepos).toHaveBeenCalledWith(
        expect.anything(), // octokit
        expect.anything(), // vetter
        mergedRepos,
        expect.stringContaining('is:issue'),
        [], // no labels for Phase 0
        10,
        'merged_pr',
        expect.any(Function),
      );
      expect(result.candidates).toHaveLength(1);
      expect(result.strategiesUsed).toContain('merged');
    });
  });

  describe('Phase 0.5: preferred organizations', () => {
    it('calls searchWithChunkedLabels for preferred orgs', async () => {
      const stateReader = makeStateReader();
      const prefs = makePreferences({ preferredOrgs: ['my-org', 'other-org'] });
      const items = [makeSearchItem('my-org/cool-repo')];
      mockSearchWithChunkedLabels.mockResolvedValueOnce(items);
      mockVetIssuesParallel.mockResolvedValueOnce({
        candidates: [makeCandidate('my-org/cool-repo', 'preferred_org')],
        allFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(mockSearchWithChunkedLabels).toHaveBeenCalledWith(
        expect.anything(), // octokit
        expect.arrayContaining(['good first issue']), // labels
        1, // orgOps = orgsToSearch.length - 1
        expect.any(Function), // buildQuery
        expect.any(Number), // perPage
      );
      expect(result.strategiesUsed).toContain('orgs');
    });
  });

  describe('Phase 1: starred repos', () => {
    it('calls searchInRepos with starred repos and priority starred', async () => {
      const starredRepos = ['starred/repo-1', 'starred/repo-2'];
      const stateReader = makeStateReader({
        getStarredRepos: () => starredRepos,
      });
      const candidate = makeCandidate('starred/repo-1', 'starred');
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [candidate],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(mockSearchInRepos).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        starredRepos,
        expect.stringContaining('is:issue'),
        expect.any(Array), // phase1Labels (capped to 3)
        10,
        'starred',
        expect.any(Function),
      );
      expect(result.strategiesUsed).toContain('starred');
    });
  });

  describe('Phase 2: general search', () => {
    it('calls searchWithChunkedLabels then filterVetAndScore', async () => {
      const stateReader = makeStateReader();
      const items = [makeSearchItem('general/repo')];
      mockSearchWithChunkedLabels.mockResolvedValueOnce(items);
      const candidate = makeCandidate('general/repo', 'normal');
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [candidate],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(mockSearchWithChunkedLabels).toHaveBeenCalled();
      expect(mockFilterVetAndScore).toHaveBeenCalledWith(
        expect.anything(), // vetter
        items,
        expect.any(Function), // filterIssues
        expect.any(Array), // excludedRepoSets
        expect.any(Number), // remainingNeeded
        50, // minStars
        expect.stringContaining('Phase 2'),
      );
      expect(result.candidates).toHaveLength(1);
      expect(result.strategiesUsed).toContain('broad');
    });
  });

  describe('Phase 3: maintained repos', () => {
    it('calls cachedSearchIssues then filterVetAndScore', async () => {
      const stateReader = makeStateReader();
      const items = [makeSearchItem('maintained/repo')];
      mockCachedSearchIssues.mockResolvedValueOnce({
        total_count: 1,
        items,
      });
      const candidate = makeCandidate('maintained/repo', 'normal');
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [candidate],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(mockCachedSearchIssues).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          q: expect.stringContaining('is:issue'),
          sort: 'updated',
          order: 'desc',
        }),
      );
      // Phase 2 calls filterVetAndScore first, then Phase 3
      expect(mockFilterVetAndScore).toHaveBeenCalledTimes(2);
      expect(result.strategiesUsed).toContain('maintained');
    });
  });

  describe('strategy filtering', () => {
    it('with strategies=[merged], only Phase 0 runs', async () => {
      const mergedRepos = ['org/repo-a'];
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => mergedRepos,
        getStarredRepos: () => ['starred/repo-1'],
      });
      const prefs = makePreferences({ preferredOrgs: ['some-org'] });
      const candidate = makeCandidate('org/repo-a', 'merged_pr');
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [candidate],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ strategies: ['merged'], maxResults: 10 });

      expect(result.strategiesUsed).toEqual(['merged']);
      // searchInRepos called once for Phase 0, not for Phase 1
      expect(mockSearchInRepos).toHaveBeenCalledTimes(1);
      expect(mockSearchWithChunkedLabels).not.toHaveBeenCalled();
      expect(mockCachedSearchIssues).not.toHaveBeenCalled();
      expect(mockFilterVetAndScore).not.toHaveBeenCalled();
    });

    it('with strategies=[starred, broad], only Phases 1 and 2 run', async () => {
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['merged/repo'],
        getStarredRepos: () => ['starred/repo-1'],
      });
      const prefs = makePreferences({ preferredOrgs: ['some-org'] });

      // Phase 1 (starred) returns a candidate via searchInRepos
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [makeCandidate('starred/repo-1', 'starred')],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      // Phase 2 (broad) returns via searchWithChunkedLabels + filterVetAndScore
      mockSearchWithChunkedLabels.mockResolvedValueOnce([makeSearchItem('broad/repo')]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [makeCandidate('broad/repo')],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ strategies: ['starred', 'broad'], maxResults: 10 });

      expect(result.strategiesUsed).toContain('starred');
      expect(result.strategiesUsed).toContain('broad');
      expect(result.strategiesUsed).not.toContain('merged');
      expect(result.strategiesUsed).not.toContain('orgs');
      expect(result.strategiesUsed).not.toContain('maintained');
    });
  });

  describe('budget management', () => {
    it('when remaining < CRITICAL (10), only Phase 0 runs', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 5,
        limit: 30,
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['org/repo'],
        getStarredRepos: () => ['starred/repo'],
      });
      const prefs = makePreferences({ preferredOrgs: ['pref-org'] });
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [makeCandidate('org/repo', 'merged_pr')],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      // Phase 0 runs
      expect(result.strategiesUsed).toContain('merged');
      // Phases 0.5, 1, 2, 3 should NOT run
      expect(result.strategiesUsed).not.toContain('orgs');
      expect(result.strategiesUsed).not.toContain('starred');
      expect(result.strategiesUsed).not.toContain('broad');
      expect(result.strategiesUsed).not.toContain('maintained');
    });

    it('when remaining < LOW (20), Phases 2 and 3 are skipped', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 15,
        limit: 30,
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const stateReader = makeStateReader({
        getStarredRepos: () => ['starred/repo'],
      });
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      // Phase 1 runs (starred)
      expect(result.strategiesUsed).toContain('starred');
      // Phase 2 and 3 should NOT run due to low budget
      expect(result.strategiesUsed).not.toContain('broad');
      expect(result.strategiesUsed).not.toContain('maintained');
    });
  });

  describe('rate limit warning', () => {
    it('sets rateLimitWarning when rateLimit.remaining < 5', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 3,
        limit: 30,
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['org/repo'],
      });
      mockSearchInRepos.mockResolvedValueOnce({
        candidates: [makeCandidate('org/repo', 'merged_pr')],
        allBatchesFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      await discovery.searchIssues({ maxResults: 10 });

      // The initial "quota low" warning gets overwritten by the post-search warning
      // because results were found but phases were skipped
      expect(discovery.rateLimitWarning).toBeTruthy();
      expect(discovery.rateLimitWarning).toMatch(/rate limit/i);
    });
  });

  describe('per-repo cap', () => {
    it('applyPerRepoCap is called with max 2', async () => {
      const stateReader = makeStateReader();
      const candidates = [
        makeCandidate('repo/a', 'normal', 'approve', 90),
        makeCandidate('repo/a', 'normal', 'approve', 80),
        makeCandidate('repo/a', 'normal', 'approve', 70),
      ];
      mockSearchWithChunkedLabels.mockResolvedValueOnce([makeSearchItem('repo/a')]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates,
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      await discovery.searchIssues({ maxResults: 10 });

      expect(applyPerRepoCap).toHaveBeenCalledWith(expect.any(Array), 2);
    });
  });

  describe('sorting', () => {
    it('sorts by priority > recommendation > score', async () => {
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['merged/repo'],
        getStarredRepos: () => ['starred/repo'],
      });

      // Phase 0 returns merged_pr candidate with lower score
      const mergedCandidate = makeCandidate('merged/repo', 'merged_pr', 'approve', 60);
      mockSearchInRepos
        .mockResolvedValueOnce({
          candidates: [mergedCandidate],
          allBatchesFailed: false,
          rateLimitHit: false,
        })
        // Phase 1 returns starred candidate with higher score
        .mockResolvedValueOnce({
          candidates: [makeCandidate('starred/repo', 'starred', 'approve', 95)],
          allBatchesFailed: false,
          rateLimitHit: false,
        });

      // Phase 2
      const normalApprove = makeCandidate('normal/repo-1', 'normal', 'approve', 85);
      const normalSkip = makeCandidate('normal/repo-2', 'normal', 'skip', 90);
      mockSearchWithChunkedLabels.mockResolvedValueOnce([
        makeSearchItem('normal/repo-1'),
        makeSearchItem('normal/repo-2'),
      ]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [normalSkip, normalApprove],
        allVetFailed: false,
        rateLimitHit: false,
      });

      // Phase 3
      mockCachedSearchIssues.mockResolvedValueOnce({ total_count: 0, items: [] });
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [],
        allVetFailed: false,
        rateLimitHit: false,
      });

      // Make applyPerRepoCap pass through for this test
      vi.mocked(applyPerRepoCap).mockImplementation((c) => c);

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      const repos = result.candidates.map((c) => c.issue.repo);
      // merged_pr (highest priority) comes first regardless of score
      expect(repos[0]).toBe('merged/repo');
      // starred next
      expect(repos[1]).toBe('starred/repo');
      // Among normal: approve before skip
      expect(repos[2]).toBe('normal/repo-1'); // approve
      expect(repos[3]).toBe('normal/repo-2'); // skip
    });
  });

  describe('filterIssues', () => {
    it('excludes repos in excludeRepos', async () => {
      const stateReader = makeStateReader();
      const prefs = makePreferences({ excludeRepos: ['excluded/repo'] });
      const items = [makeSearchItem('excluded/repo'), makeSearchItem('allowed/repo')];
      mockSearchWithChunkedLabels.mockResolvedValueOnce(items);
      // Capture the filterIssues function passed to filterVetAndScore
      mockFilterVetAndScore.mockImplementationOnce(
        async (_vetter, passedItems, filterFn, ..._rest) => {
          const filtered = filterFn(passedItems as GitHubSearchItem[]);
          return {
            candidates: filtered.map((item: GitHubSearchItem) => {
              const repo = item.repository_url.split('/').slice(-2).join('/');
              return makeCandidate(repo);
            }),
            allVetFailed: false,
            rateLimitHit: false,
          };
        },
      );

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      const repos = result.candidates.map((c) => c.issue.repo);
      expect(repos).not.toContain('excluded/repo');
      expect(repos).toContain('allowed/repo');
    });

    it('excludes repos in aiPolicyBlocklist', async () => {
      const stateReader = makeStateReader();
      const prefs = makePreferences({ aiPolicyBlocklist: ['blocked/repo'] });
      const items = [makeSearchItem('blocked/repo'), makeSearchItem('ok/repo')];
      mockSearchWithChunkedLabels.mockResolvedValueOnce(items);
      mockFilterVetAndScore.mockImplementationOnce(
        async (_vetter, passedItems, filterFn, ..._rest) => {
          const filtered = filterFn(passedItems as GitHubSearchItem[]);
          return {
            candidates: filtered.map((item: GitHubSearchItem) => {
              const repo = item.repository_url.split('/').slice(-2).join('/');
              return makeCandidate(repo);
            }),
            allVetFailed: false,
            rateLimitHit: false,
          };
        },
      );

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      const repos = result.candidates.map((c) => c.issue.repo);
      expect(repos).not.toContain('blocked/repo');
      expect(repos).toContain('ok/repo');
    });

    it('excludes issues older than maxIssueAgeDays', async () => {
      vi.mocked(daysBetween).mockImplementation((updatedAt: Date) => {
        // Return 100 for the old item, 1 for the recent one
        return updatedAt.toISOString().includes('2020') ? 100 : 1;
      });

      const stateReader = makeStateReader();
      const prefs = makePreferences({ maxIssueAgeDays: 90 });

      const oldItem: GitHubSearchItem = {
        html_url: 'https://github.com/old/repo/issues/1',
        repository_url: 'https://api.github.com/repos/old/repo',
        updated_at: '2020-01-01T00:00:00Z',
        title: 'Old issue',
      };
      const newItem = makeSearchItem('new/repo');
      mockSearchWithChunkedLabels.mockResolvedValueOnce([oldItem, newItem]);
      mockFilterVetAndScore.mockImplementationOnce(
        async (_vetter, passedItems, filterFn, ..._rest) => {
          const filtered = filterFn(passedItems as GitHubSearchItem[]);
          return {
            candidates: filtered.map((item: GitHubSearchItem) => {
              const repo = item.repository_url.split('/').slice(-2).join('/');
              return makeCandidate(repo);
            }),
            allVetFailed: false,
            rateLimitHit: false,
          };
        },
      );

      const discovery = new IssueDiscovery('token', prefs, stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      const repos = result.candidates.map((c) => c.issue.repo);
      expect(repos).not.toContain('old/repo');
      expect(repos).toContain('new/repo');
    });
  });

  describe('empty results', () => {
    it('returns empty array with rateLimitWarning when rate limits caused failure', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 3,
        limit: 30,
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // Budget is critical (3 < 10), so only Phase 0 runs
      // Phase 0 won't run because no merged repos
      const stateReader = makeStateReader();

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      const result = await discovery.searchIssues({ maxResults: 10 });

      expect(result.candidates).toHaveLength(0);
      expect(discovery.rateLimitWarning).toBeTruthy();
      expect(discovery.rateLimitWarning).toMatch(/rate limit/i);
    });

    it('throws ValidationError when no candidates and no rate limit issues', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue({
        remaining: 30,
        limit: 30,
        resetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const stateReader = makeStateReader();

      // Phase 2 and 3 return empty
      mockSearchWithChunkedLabels.mockResolvedValueOnce([]);
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [],
        allVetFailed: false,
        rateLimitHit: false,
      });
      mockCachedSearchIssues.mockResolvedValueOnce({ total_count: 0, items: [] });
      mockFilterVetAndScore.mockResolvedValueOnce({
        candidates: [],
        allVetFailed: false,
        rateLimitHit: false,
      });

      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);

      await expect(discovery.searchIssues({ maxResults: 10 })).rejects.toThrow(ValidationError);
    });
  });

  describe('getStarredRepos', () => {
    it('delegates to stateReader', () => {
      const starredRepos = ['org/repo-1', 'org/repo-2'];
      const stateReader = makeStateReader({
        getStarredRepos: () => starredRepos,
      });
      const discovery = new IssueDiscovery('token', makePreferences(), stateReader);
      expect(discovery.getStarredRepos()).toEqual(starredRepos);
    });
  });
});
