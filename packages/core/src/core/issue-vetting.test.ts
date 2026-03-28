import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectHealth, CheckResult, IssueCandidate } from './types.js';
import type { ScoutStateReader } from './issue-vetting.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('./utils.js', () => ({
  parseGitHubUrl: vi.fn(),
}));

vi.mock('./errors.js', () => ({
  ValidationError: class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ValidationError';
    }
  },
  errorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  isRateLimitError: vi.fn(() => false),
}));

vi.mock('./logger.js', () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./issue-scoring.js', () => ({
  calculateRepoQualityBonus: vi.fn(() => 5),
  calculateViabilityScore: vi.fn(() => 75),
}));

vi.mock('./category-mapping.js', () => ({
  repoBelongsToCategory: vi.fn(() => false),
}));

vi.mock('./issue-eligibility.js', () => ({
  checkNoExistingPR: vi.fn(),
  checkNotClaimed: vi.fn(),
  checkUserMergedPRsInRepo: vi.fn(),
  analyzeRequirements: vi.fn(),
}));

vi.mock('./repo-health.js', () => ({
  checkProjectHealth: vi.fn(),
  fetchContributionGuidelines: vi.fn(),
}));

vi.mock('./http-cache.js', () => ({
  getHttpCache: vi.fn(),
}));

import { parseGitHubUrl } from './utils.js';
import { isRateLimitError } from './errors.js';
import { calculateRepoQualityBonus, calculateViabilityScore } from './issue-scoring.js';
import { repoBelongsToCategory } from './category-mapping.js';
import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from './issue-eligibility.js';
import { checkProjectHealth, fetchContributionGuidelines } from './repo-health.js';
import { getHttpCache } from './http-cache.js';
import { IssueVetter } from './issue-vetting.js';

// ── Helpers ────────────────────────────────────────────────────────

const ISSUE_URL = 'https://github.com/acme/widgets/issues/42';

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

function makeOctokit(): any {
  return {
    issues: {
      get: vi.fn().mockResolvedValue({
        data: {
          id: 100,
          title: 'Fix the widget',
          body: 'Detailed bug description with clear steps.',
          comments: 2,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-03-01T00:00:00Z',
          labels: [{ name: 'bug' }, { name: 'good first issue' }],
        },
      }),
    },
  };
}

const passingHealth: ProjectHealth = {
  repo: 'acme/widgets',
  lastCommitAt: '2026-03-01T00:00:00Z',
  daysSinceLastCommit: 5,
  openIssuesCount: 20,
  avgIssueResponseDays: 2,
  ciStatus: 'passing',
  isActive: true,
  stargazersCount: 1000,
  forksCount: 200,
};

function mockCache(cached: unknown = null) {
  const cache = { getIfFresh: vi.fn(() => cached), set: vi.fn() };
  vi.mocked(getHttpCache).mockReturnValue(cache as any);
  return cache;
}

function setupDefaults() {
  vi.mocked(parseGitHubUrl).mockReturnValue({ owner: 'acme', repo: 'widgets', number: 42, type: 'issues' });
  vi.mocked(checkNoExistingPR).mockResolvedValue({ passed: true });
  vi.mocked(checkNotClaimed).mockResolvedValue({ passed: true });
  vi.mocked(checkProjectHealth).mockResolvedValue(passingHealth);
  vi.mocked(fetchContributionGuidelines).mockResolvedValue({ content: '# Contributing', source: 'CONTRIBUTING.md' });
  vi.mocked(checkUserMergedPRsInRepo).mockResolvedValue(0);
  vi.mocked(analyzeRequirements).mockReturnValue(true);
  vi.mocked(repoBelongsToCategory).mockReturnValue(false);
  vi.mocked(calculateViabilityScore).mockReturnValue(75);
  vi.mocked(calculateRepoQualityBonus).mockReturnValue(5);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('IssueVetter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCache(null);
    setupDefaults();
  });

  // ── vetIssue ───────────────────────────────────────────────────

  describe('vetIssue', () => {
    it('returns approve when all checks pass', async () => {
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.recommendation).toBe('approve');
      expect(result.vettingResult.passedAllChecks).toBe(true);
      expect(result.viabilityScore).toBe(75);
      expect(result.reasonsToApprove).toContain('No existing PR');
      expect(result.reasonsToApprove).toContain('Not claimed');
      expect(result.reasonsToApprove).toContain('Active project');
      expect(result.reasonsToApprove).toContain('Clear requirements');
      expect(result.reasonsToApprove).toContain('Has contribution guidelines');
      expect(result.reasonsToSkip).toHaveLength(0);
    });

    it('returns skip when existing PR detected', async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValue({ passed: false });
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToSkip).toContain('Has existing PR');
      expect(result.vettingResult.checks.noExistingPR).toBe(false);
    });

    it('returns skip when issue is claimed', async () => {
      vi.mocked(checkNotClaimed).mockResolvedValue({ passed: false });
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToSkip).toContain('Already claimed');
      expect(result.vettingResult.checks.notClaimed).toBe(false);
    });

    it('returns needs_review when project is inactive', async () => {
      vi.mocked(checkProjectHealth).mockResolvedValue({
        ...passingHealth,
        isActive: false,
      });
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToSkip).toContain('Inactive project');
      // Inactive alone = 1 skip reason (< 3), so needs_review not skip
      expect(result.recommendation).toBe('needs_review');
    });

    it('downgrades approve to needs_review when checks are inconclusive', async () => {
      // All checks pass but existingPR is inconclusive
      vi.mocked(checkNoExistingPR).mockResolvedValue({ passed: true, inconclusive: true, reason: 'API timeout' });
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.recommendation).toBe('needs_review');
      expect(result.vettingResult.notes).toContain('Recommendation downgraded: one or more checks were inconclusive');
    });

    it('returns skip when 3+ skip reasons', async () => {
      vi.mocked(checkNoExistingPR).mockResolvedValue({ passed: false });
      vi.mocked(checkNotClaimed).mockResolvedValue({ passed: false });
      vi.mocked(checkProjectHealth).mockResolvedValue({ ...passingHealth, isActive: false });
      vi.mocked(analyzeRequirements).mockReturnValue(false);

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToSkip.length).toBeGreaterThanOrEqual(3);
      expect(result.recommendation).toBe('skip');
    });

    it('throws ValidationError for invalid URL', async () => {
      vi.mocked(parseGitHubUrl).mockReturnValue(null);
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());

      await expect(vetter.vetIssue('https://not-github.com/foo')).rejects.toThrow('Invalid issue URL');
    });

    it('throws ValidationError for non-issue URL', async () => {
      vi.mocked(parseGitHubUrl).mockReturnValue({ owner: 'acme', repo: 'widgets', number: 1, type: 'pull' });
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());

      await expect(vetter.vetIssue('https://github.com/acme/widgets/pull/1')).rejects.toThrow('Invalid issue URL');
    });

    it('throws when API error on issue fetch', async () => {
      const octokit = makeOctokit();
      octokit.issues.get.mockRejectedValue(new Error('Request failed: 404'));
      const vetter = new IssueVetter(octokit, makeStateReader());

      await expect(vetter.vetIssue(ISSUE_URL)).rejects.toThrow('Request failed: 404');
    });

    it('returns cached result within 15min TTL', async () => {
      const cachedCandidate: Partial<IssueCandidate> = {
        issue: { id: 100, url: ISSUE_URL } as any,
        viabilityScore: 80,
        recommendation: 'approve',
      };
      const cache = mockCache(cachedCandidate);

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.viabilityScore).toBe(80);
      expect(cache.getIfFresh).toHaveBeenCalledWith(`vet:${ISSUE_URL}`, 15 * 60 * 1000);
      // Should NOT have called octokit or any checks
      expect(checkNoExistingPR).not.toHaveBeenCalled();
    });

    it('re-vets when cache expired (returns null)', async () => {
      mockCache(null); // cache miss

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(checkNoExistingPR).toHaveBeenCalled();
      expect(result.recommendation).toBe('approve');
    });

    it('adds trusted project reason and sets merged_pr priority when user has merged PRs', async () => {
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['acme/widgets'],
      });
      const vetter = new IssueVetter(makeOctokit(), stateReader);
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToApprove).toContain('Trusted project (1 PR merged)');
      expect(result.searchPriority).toBe('merged_pr');
      // Should skip the API call since local state is authoritative
      expect(checkUserMergedPRsInRepo).not.toHaveBeenCalled();
    });

    it('adds org affinity reason when user has merged PRs in another repo under same org', async () => {
      const stateReader = makeStateReader({
        getReposWithMergedPRs: () => ['acme/other-repo'],
      });
      const vetter = new IssueVetter(makeOctokit(), stateReader);
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToApprove).toEqual(
        expect.arrayContaining([expect.stringContaining('Org affinity')]),
      );
    });

    it('adds category match reason when repo matches preferred category', async () => {
      vi.mocked(repoBelongsToCategory).mockReturnValue(true);
      const stateReader = makeStateReader({
        getProjectCategories: () => ['devtools'],
      });
      const vetter = new IssueVetter(makeOctokit(), stateReader);
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.reasonsToApprove).toContain('Matches preferred project category');
    });

    it('caches result after vetting', async () => {
      const cache = mockCache(null);
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      await vetter.vetIssue(ISSUE_URL);

      expect(cache.set).toHaveBeenCalledWith(
        `vet:${ISSUE_URL}`,
        '',
        expect.objectContaining({ recommendation: 'approve' }),
      );
    });

    it('sets preferred_org priority when org is in preferred list', async () => {
      const stateReader = makeStateReader({
        getPreferredOrgs: () => ['acme'],
      });
      const vetter = new IssueVetter(makeOctokit(), stateReader);
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.searchPriority).toBe('preferred_org');
    });

    it('sets starred priority when repo is starred', async () => {
      const stateReader = makeStateReader({
        getStarredRepos: () => ['acme/widgets'],
      });
      const vetter = new IssueVetter(makeOctokit(), stateReader);
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.searchPriority).toBe('starred');
    });

    it('uses API merged PR count when not in local state', async () => {
      vi.mocked(checkUserMergedPRsInRepo).mockResolvedValue(3);
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(checkUserMergedPRsInRepo).toHaveBeenCalled();
      expect(result.reasonsToApprove).toContain('Trusted project (3 PRs merged)');
      expect(result.searchPriority).toBe('merged_pr');
    });

    it('adds note when health check failed and quality bonus unavailable', async () => {
      vi.mocked(checkProjectHealth).mockResolvedValue({
        ...passingHealth,
        checkFailed: true,
        failureReason: 'API error',
        stargazersCount: undefined,
        forksCount: undefined,
      });
      vi.mocked(calculateRepoQualityBonus).mockReturnValue(0);
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssue(ISSUE_URL);

      expect(result.vettingResult.notes).toContain(
        'Repo quality bonus unavailable: could not fetch star/fork counts due to API error',
      );
    });
  });

  // ── vetIssuesParallel ──────────────────────────────────────────

  describe('vetIssuesParallel', () => {
    it('vets multiple issues and returns candidates', async () => {
      const urls = [
        'https://github.com/acme/widgets/issues/1',
        'https://github.com/acme/widgets/issues/2',
        'https://github.com/acme/widgets/issues/3',
      ];

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 10);

      expect(result.candidates).toHaveLength(3);
      expect(result.allFailed).toBe(false);
      expect(result.rateLimitHit).toBe(false);
    });

    it('respects concurrency limit of 3', async () => {
      let activeConcurrency = 0;
      let maxConcurrency = 0;

      // Track how many vetIssue calls are active simultaneously
      vi.mocked(checkNoExistingPR).mockImplementation(() => {
        activeConcurrency++;
        maxConcurrency = Math.max(maxConcurrency, activeConcurrency);
        return new Promise<CheckResult>((resolve) => {
          setTimeout(() => {
            activeConcurrency--;
            resolve({ passed: true });
          }, 10);
        });
      });

      const urls = Array.from({ length: 6 }, (_, i) => `https://github.com/acme/widgets/issues/${i + 1}`);
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      await vetter.vetIssuesParallel(urls, 10);

      expect(maxConcurrency).toBeLessThanOrEqual(3);
    });

    it('handles partial failures gracefully', async () => {
      const urls = [
        'https://github.com/acme/widgets/issues/1',
        'https://github.com/acme/widgets/issues/2',
        'https://github.com/acme/widgets/issues/3',
      ];

      // Make the second URL fail by making issues.get fail for specific calls
      const octokit = makeOctokit();
      let callCount = 0;
      octokit.issues.get.mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.reject(new Error('Not found'));
        return Promise.resolve({
          data: {
            id: 100,
            title: 'Fix the widget',
            body: 'Clear description.',
            comments: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
            labels: [],
          },
        });
      });

      const vetter = new IssueVetter(octokit, makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 10);

      expect(result.candidates.length).toBe(2);
      expect(result.allFailed).toBe(false);
    });

    it('returns allFailed=true when all issues fail', async () => {
      vi.mocked(parseGitHubUrl).mockReturnValue(null);

      const urls = [
        'https://github.com/acme/widgets/issues/1',
        'https://github.com/acme/widgets/issues/2',
      ];

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 10);

      expect(result.allFailed).toBe(true);
      expect(result.candidates).toHaveLength(0);
    });

    it('sets rateLimitHit=true when rate limit error occurs', async () => {
      vi.mocked(isRateLimitError).mockReturnValue(true);
      const octokit = makeOctokit();
      octokit.issues.get.mockRejectedValue(new Error('rate limit'));

      const urls = ['https://github.com/acme/widgets/issues/1'];
      const vetter = new IssueVetter(octokit, makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 10);

      expect(result.rateLimitHit).toBe(true);
      expect(result.allFailed).toBe(true);
    });

    it('respects maxResults limit', async () => {
      const urls = Array.from({ length: 10 }, (_, i) => `https://github.com/acme/widgets/issues/${i + 1}`);

      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 3);

      expect(result.candidates.length).toBeLessThanOrEqual(3);
    });

    it('overrides searchPriority when priority arg is provided', async () => {
      const urls = ['https://github.com/acme/widgets/issues/1'];
      const vetter = new IssueVetter(makeOctokit(), makeStateReader());
      const result = await vetter.vetIssuesParallel(urls, 10, 'starred');

      expect(result.candidates[0].searchPriority).toBe('starred');
    });
  });
});
