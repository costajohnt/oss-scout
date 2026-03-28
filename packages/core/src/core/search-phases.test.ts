import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IssueCandidate } from './types.js';
import type { GitHubSearchItem } from './issue-filtering.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('./logger.js', () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./errors.js', () => ({
  errorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
  isRateLimitError: vi.fn(() => false),
}));

vi.mock('./search-budget.js', () => ({
  getSearchBudgetTracker: vi.fn(() => ({
    waitForBudget: vi.fn().mockResolvedValue(undefined),
    recordCall: vi.fn(),
  })),
}));

// Mock http-cache: cachedTimeBased just calls the fetcher (no real caching)
vi.mock('./http-cache.js', () => ({
  getHttpCache: vi.fn(() => ({
    getIfFresh: vi.fn(() => null),
    set: vi.fn(),
  })),
  cachedTimeBased: vi.fn(async (_cache: unknown, _key: string, _maxAge: number, fetcher: () => Promise<unknown>) =>
    fetcher(),
  ),
}));

vi.mock('./issue-filtering.js', () => ({
  detectLabelFarmingRepos: vi.fn(() => new Set<string>()),
}));

vi.mock('./issue-vetting.js', () => ({
  IssueVetter: vi.fn(),
}));

import {
  buildEffectiveLabels,
  interleaveArrays,
  cachedSearchIssues,
  searchWithChunkedLabels,
  filterVetAndScore,
  searchInRepos,
} from './search-phases.js';
import { cachedTimeBased } from './http-cache.js';
import { detectLabelFarmingRepos } from './issue-filtering.js';
import { isRateLimitError } from './errors.js';
import type { Octokit } from '@octokit/rest';
import type { IssueVetter } from './issue-vetting.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeItem(url: string, repoFullName: string): GitHubSearchItem {
  return {
    html_url: url,
    repository_url: `https://api.github.com/repos/${repoFullName}`,
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeCandidate(url: string, stars: number, checkFailed = false): IssueCandidate {
  return {
    issue: { url, repo: 'owner/repo', number: 1, title: 'Test', labels: [], createdAt: '', updatedAt: '' },
    vettingResult: { recommendation: 'approve', reasonsToApprove: [], reasonsToSkip: [], viabilityScore: 80 },
    projectHealth: {
      repo: 'owner/repo',
      lastCommitAt: '',
      daysSinceLastCommit: 0,
      openIssuesCount: 0,
      avgIssueResponseDays: 0,
      ciStatus: 'unknown',
      isActive: true,
      stargazersCount: stars,
      checkFailed,
    },
    recommendation: 'approve',
    reasonsToSkip: [],
    reasonsToApprove: [],
    viabilityScore: 80,
    searchPriority: 'normal',
  };
}

function makeMockOctokit(items: GitHubSearchItem[] = []): Octokit {
  return {
    search: {
      issuesAndPullRequests: vi.fn().mockResolvedValue({ data: { total_count: items.length, items } }),
    },
  } as unknown as Octokit;
}

function makeMockVetter(candidates: IssueCandidate[], opts?: { allFailed?: boolean; rateLimitHit?: boolean }) {
  return {
    vetIssuesParallel: vi.fn().mockResolvedValue({
      candidates,
      allFailed: opts?.allFailed ?? false,
      rateLimitHit: opts?.rateLimitHit ?? false,
    }),
  } as unknown as IssueVetter;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('buildEffectiveLabels', () => {
  it('returns beginner labels for single beginner scope', () => {
    const result = buildEffectiveLabels(['beginner'], []);
    expect(result).toEqual(
      expect.arrayContaining(['good first issue', 'help wanted', 'easy', 'up-for-grabs', 'first-timers-only', 'beginner']),
    );
    expect(result).toHaveLength(6);
  });

  it('combines labels from multiple scopes', () => {
    const result = buildEffectiveLabels(['beginner', 'intermediate'], []);
    // Should include labels from both scopes
    expect(result).toEqual(expect.arrayContaining(['good first issue', 'enhancement']));
    expect(result).toHaveLength(10); // 6 beginner + 4 intermediate
  });

  it('merges custom labels with scope labels', () => {
    const result = buildEffectiveLabels(['beginner'], ['my-custom-label']);
    expect(result).toContain('my-custom-label');
    expect(result).toContain('good first issue');
    expect(result).toHaveLength(7); // 6 beginner + 1 custom
  });

  it('deduplicates overlapping labels', () => {
    // 'good first issue' is already in beginner scope — passing it as custom should not double it
    const result = buildEffectiveLabels(['beginner'], ['good first issue']);
    const occurrences = result.filter((l) => l === 'good first issue');
    expect(occurrences).toHaveLength(1);
    expect(result).toHaveLength(6); // still 6, no duplication
  });
});

describe('interleaveArrays', () => {
  it('round-robins two equal-length arrays', () => {
    const result = interleaveArrays([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('handles unequal-length arrays (shorter stops, longer continues)', () => {
    const result = interleaveArrays([
      ['a1', 'a2', 'a3'],
      ['b1'],
    ]);
    expect(result).toEqual(['a1', 'b1', 'a2', 'a3']);
  });

  it('returns the other array when one is empty', () => {
    const result = interleaveArrays([[], ['b1', 'b2']]);
    expect(result).toEqual(['b1', 'b2']);
  });

  it('returns empty array when both are empty', () => {
    const result = interleaveArrays([[], []]);
    expect(result).toEqual([]);
  });
});

describe('cachedSearchIssues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls octokit search and returns results', async () => {
    const items = [makeItem('https://github.com/owner/repo/issues/1', 'owner/repo')];
    const octokit = makeMockOctokit(items);

    const result = await cachedSearchIssues(octokit, {
      q: 'is:issue is:open',
      sort: 'created',
      order: 'desc',
      per_page: 10,
    });

    expect(result.total_count).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].html_url).toBe('https://github.com/owner/repo/issues/1');
  });

  it('returns cached results on second call with same query (via cachedTimeBased)', async () => {
    const items = [makeItem('https://github.com/owner/repo/issues/1', 'owner/repo')];
    const octokit = makeMockOctokit(items);

    // Make cachedTimeBased return a cached value on second call
    const mockCachedTimeBased = vi.mocked(cachedTimeBased);
    const cachedResult = { total_count: 1, items };
    mockCachedTimeBased
      .mockImplementationOnce(async (_cache, _key, _maxAge, fetcher) => fetcher())
      .mockImplementationOnce(async () => cachedResult);

    await cachedSearchIssues(octokit, { q: 'test', sort: 'created', order: 'desc', per_page: 10 });
    const result2 = await cachedSearchIssues(octokit, { q: 'test', sort: 'created', order: 'desc', per_page: 10 });

    expect(result2).toBe(cachedResult);
    // octokit was only called once (second call returned cache)
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(1);
  });

  it('calls API again for a different query', async () => {
    const octokit = makeMockOctokit([]);

    await cachedSearchIssues(octokit, { q: 'query-a', sort: 'created', order: 'desc', per_page: 10 });
    await cachedSearchIssues(octokit, { q: 'query-b', sort: 'created', order: 'desc', per_page: 10 });

    // cachedTimeBased is called with different keys, so fetcher runs both times
    expect(octokit.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });
});

describe('searchInRepos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches 3 repos in a single batch', async () => {
    const items = [
      makeItem('https://github.com/a/b/issues/1', 'a/b'),
      makeItem('https://github.com/c/d/issues/2', 'c/d'),
    ];
    const octokit = makeMockOctokit(items);
    const candidates = [makeCandidate('https://github.com/a/b/issues/1', 100)];
    const vetter = makeMockVetter(candidates);

    const result = await searchInRepos(
      octokit,
      vetter,
      ['a/b', 'c/d', 'e/f'],
      'is:issue is:open',
      ['good first issue'],
      10,
      'normal',
      (items) => items,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.allBatchesFailed).toBe(false);
    // Only 1 batch of 3 repos — cachedTimeBased called once per label chunk
    expect(vi.mocked(cachedTimeBased)).toHaveBeenCalled();
  });

  it('searches 6 repos in two batches', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const octokit = makeMockOctokit(items);
    const vetter = makeMockVetter([makeCandidate('url', 100)]);

    await searchInRepos(
      octokit,
      vetter,
      ['a/b', 'c/d', 'e/f', 'g/h', 'i/j', 'k/l'],
      'is:issue is:open',
      ['good first issue'],
      10,
      'normal',
      (items) => items,
    );

    // 6 repos / BATCH_SIZE(3) = 2 batches, each calls cachedTimeBased at least once
    expect(vi.mocked(cachedTimeBased).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns allBatchesFailed: true when all batches fail', async () => {
    const octokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockRejectedValue(new Error('API error')),
      },
    } as unknown as Octokit;
    // Make cachedTimeBased propagate the error from the fetcher
    vi.mocked(cachedTimeBased).mockImplementation(async (_cache, _key, _maxAge, fetcher) => fetcher());

    const vetter = makeMockVetter([]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ['a/b', 'c/d', 'e/f'],
      'is:issue is:open',
      ['good first issue'],
      10,
      'normal',
      (items) => items,
    );

    expect(result.allBatchesFailed).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it('returns partial results when some batches succeed', async () => {
    let callCount = 0;
    vi.mocked(cachedTimeBased).mockImplementation(async (_cache, _key, _maxAge, fetcher) => {
      callCount++;
      if (callCount === 1) return fetcher(); // first batch succeeds
      throw new Error('API error'); // second batch fails
    });

    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const octokit = makeMockOctokit(items);
    const vetter = makeMockVetter([makeCandidate('url', 100)]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ['a/b', 'c/d', 'e/f', 'g/h', 'i/j', 'k/l'],
      'is:issue is:open',
      [],
      10,
      'normal',
      (items) => items,
    );

    expect(result.allBatchesFailed).toBe(false);
    expect(result.candidates).toHaveLength(1);
  });

  it('sets rateLimitHit: true when rate limit error occurs', async () => {
    vi.mocked(isRateLimitError).mockReturnValue(true);
    vi.mocked(cachedTimeBased).mockImplementation(async (_cache, _key, _maxAge, fetcher) => fetcher());

    const octokit = {
      search: {
        issuesAndPullRequests: vi.fn().mockRejectedValue(new Error('rate limit')),
      },
    } as unknown as Octokit;
    const vetter = makeMockVetter([]);

    const result = await searchInRepos(
      octokit,
      vetter,
      ['a/b'],
      'is:issue is:open',
      [],
      10,
      'normal',
      (items) => items,
    );

    expect(result.rateLimitHit).toBe(true);
  });
});

describe('filterVetAndScore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters out issues from excludedRepoSets', async () => {
    const items = [
      makeItem('https://github.com/excluded/repo/issues/1', 'excluded/repo'),
      makeItem('https://github.com/good/repo/issues/2', 'good/repo'),
    ];
    const excludedSet = new Set(['excluded/repo']);
    const vetter = makeMockVetter([makeCandidate('url', 100)]);

    await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [excludedSet],
      10,
      0,
      'Phase2',
    );

    // Vetter should only receive the non-excluded issue
    const vetterCall = vi.mocked(vetter.vetIssuesParallel).mock.calls[0];
    expect(vetterCall[0]).toEqual(['https://github.com/good/repo/issues/2']);
  });

  it('filters out low-star repos below minStars', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const lowStarCandidate = makeCandidate('url', 5); // 5 stars
    const vetter = makeMockVetter([lowStarCandidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      50, // minStars = 50
      'Phase2',
    );

    expect(result.candidates).toHaveLength(0); // filtered out because 5 < 50
  });

  it('keeps candidates with checkFailed regardless of star count', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const checkFailedCandidate = makeCandidate('url', 0, true); // 0 stars but checkFailed
    const vetter = makeMockVetter([checkFailedCandidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      50,
      'Phase2',
    );

    expect(result.candidates).toHaveLength(1); // kept despite 0 stars
  });

  it('vets remaining issues in parallel via vetter', async () => {
    const items = [
      makeItem('https://github.com/a/b/issues/1', 'a/b'),
      makeItem('https://github.com/c/d/issues/2', 'c/d'),
    ];
    const vetter = makeMockVetter([makeCandidate('url1', 100), makeCandidate('url2', 100)]);

    await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      0,
      'Phase2',
    );

    expect(vetter.vetIssuesParallel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vetter.vetIssuesParallel).mock.calls[0][0]).toEqual([
      'https://github.com/a/b/issues/1',
      'https://github.com/c/d/issues/2',
    ]);
  });

  it('returns scored candidates from vetter', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const candidate = makeCandidate('url', 200);
    const vetter = makeMockVetter([candidate]);

    const result = await filterVetAndScore(
      vetter,
      items,
      (items) => items,
      [],
      10,
      0,
      'Phase2',
    );

    expect(result.candidates).toEqual([candidate]);
    expect(result.allVetFailed).toBe(false);
    expect(result.rateLimitHit).toBe(false);
  });
});

describe('searchWithChunkedLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pass through to fetcher
    vi.mocked(cachedTimeBased).mockImplementation(async (_cache, _key, _maxAge, fetcher) => fetcher());
  });

  it('issues a single query when labels fit within operator limit', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const octokit = makeMockOctokit(items);

    const result = await searchWithChunkedLabels(
      octokit,
      ['good first issue', 'help wanted'], // 2 labels, 1 OR op — well within limit
      0,
      (labelQ) => `is:issue is:open ${labelQ}`,
      10,
    );

    expect(result).toHaveLength(1);
    expect(vi.mocked(cachedTimeBased)).toHaveBeenCalledTimes(1);
  });

  it('chunks labels into multiple queries when exceeding operator limit', async () => {
    const items = [makeItem('https://github.com/a/b/issues/1', 'a/b')];
    const octokit = makeMockOctokit(items);

    // With reservedOps=0, maxPerChunk = 5 - 0 + 1 = 6. So 8 labels → 2 chunks.
    const labels = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'];

    await searchWithChunkedLabels(octokit, labels, 0, (labelQ) => `is:issue ${labelQ}`, 10);

    expect(vi.mocked(cachedTimeBased).mock.calls.length).toBe(2);
  });

  it('deduplicates results across chunks', async () => {
    const sharedItem = makeItem('https://github.com/a/b/issues/1', 'a/b');
    const uniqueItem = makeItem('https://github.com/c/d/issues/2', 'c/d');

    let callCount = 0;
    vi.mocked(cachedTimeBased).mockImplementation(async (_cache, _key, _maxAge, fetcher) => {
      callCount++;
      // Both chunks return the shared item; second chunk also returns unique item
      if (callCount === 1) return { total_count: 1, items: [sharedItem] };
      return { total_count: 2, items: [sharedItem, uniqueItem] };
    });

    const octokit = makeMockOctokit([]); // unused since we mock cachedTimeBased

    // Force 2 chunks: reservedOps=4, so maxPerChunk = 5-4+1 = 2. 3 labels → 2 chunks.
    const result = await searchWithChunkedLabels(
      octokit,
      ['l1', 'l2', 'l3'],
      4,
      (labelQ) => `is:issue ${labelQ}`,
      10,
    );

    expect(result).toHaveLength(2); // deduplicated: sharedItem appears once
    expect(result[0].html_url).toBe('https://github.com/a/b/issues/1');
    expect(result[1].html_url).toBe('https://github.com/c/d/issues/2');
  });
});
