import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';

// Stable mock singletons so the same object is seen by both test and SUT
const mockCache = {
  getIfFresh: vi.fn().mockReturnValue(null),
  set: vi.fn(),
};

const mockTracker = {
  waitForBudget: vi.fn().mockResolvedValue(undefined),
  recordCall: vi.fn(),
};

// Mock modules before importing the module under test
vi.mock('./search-budget.js', () => ({
  getSearchBudgetTracker: vi.fn(() => mockTracker),
}));

vi.mock('./logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock('./http-cache.js', () => ({
  getHttpCache: vi.fn(() => mockCache),
}));

vi.mock('./pagination.js', () => ({
  paginateAll: vi.fn(),
}));

import { checkNoExistingPR, checkNotClaimed, checkUserMergedPRsInRepo, analyzeRequirements } from './issue-eligibility.js';
import { paginateAll } from './pagination.js';
import { warn } from './logger.js';

const mockedPaginateAll = vi.mocked(paginateAll);

function makeOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    issues: {
      listEventsForTimeline: vi.fn(),
      listComments: vi.fn(),
    },
    paginate: vi.fn(),
    search: {
      issuesAndPullRequests: vi.fn(),
    },
    ...overrides,
  } as unknown as Octokit;
}

// ── checkNoExistingPR ───────────────────────────────────────────────

describe('checkNoExistingPR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns passed: true when no cross-referenced PRs exist', async () => {
    mockedPaginateAll.mockResolvedValue([
      { event: 'commented' },
      { event: 'labeled' },
    ]);

    const result = await checkNoExistingPR(makeOctokit(), 'owner', 'repo', 1);
    expect(result).toEqual({ passed: true });
  });

  it('returns passed: false when a cross-referenced open PR exists', async () => {
    mockedPaginateAll.mockResolvedValue([
      {
        event: 'cross-referenced',
        source: {
          issue: {
            pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
          },
        },
      },
    ]);

    const result = await checkNoExistingPR(makeOctokit(), 'owner', 'repo', 1);
    expect(result).toEqual({ passed: false });
  });

  it('returns passed: false when a cross-referenced merged PR exists', async () => {
    mockedPaginateAll.mockResolvedValue([
      {
        event: 'cross-referenced',
        source: {
          issue: {
            pull_request: {
              url: 'https://api.github.com/repos/owner/repo/pulls/99',
              merged_at: '2026-01-01T00:00:00Z',
            },
          },
        },
      },
    ]);

    const result = await checkNoExistingPR(makeOctokit(), 'owner', 'repo', 1);
    expect(result).toEqual({ passed: false });
  });

  it('returns passed: true with inconclusive: true on timeline API error', async () => {
    mockedPaginateAll.mockRejectedValue(new Error('API timeout'));

    const result = await checkNoExistingPR(makeOctokit(), 'owner', 'repo', 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('API timeout');
    expect(warn).toHaveBeenCalled();
  });

  it('returns passed: true when timeline is empty', async () => {
    mockedPaginateAll.mockResolvedValue([]);

    const result = await checkNoExistingPR(makeOctokit(), 'owner', 'repo', 1);
    expect(result).toEqual({ passed: true });
  });
});

// ── checkNotClaimed ─────────────────────────────────────────────────

describe('checkNotClaimed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns passed: true when there are no comments', async () => {
    const octokit = makeOctokit();

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 0);
    expect(result).toEqual({ passed: true });
  });

  it('returns passed: false when a comment contains "i\'m working on this"', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.paginate).mockResolvedValue([
      { body: "I'm working on this issue!" },
    ]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('returns passed: false when a comment contains "i\'ll take this"', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.paginate).mockResolvedValue([
      { body: "I'll take this, looks interesting" },
    ]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('returns passed: false for "can i work on" (case insensitive)', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.paginate).mockResolvedValue([
      { body: 'Can I Work On this issue?' },
    ]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('returns passed: true when comments do not contain claim phrases', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.paginate).mockResolvedValue([
      { body: 'This is a great issue' },
      { body: 'I agree, we should fix this' },
      { body: 'Any updates on this?' },
    ]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 3);
    expect(result).toEqual({ passed: true });
  });

  it('returns passed: true with inconclusive: true on API error', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.paginate).mockRejectedValue(new Error('Network error'));

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 5);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('Network error');
    expect(warn).toHaveBeenCalled();
  });

  it('skips API call and returns passed: true when commentCount is 0', async () => {
    const octokit = makeOctokit();

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 0);
    expect(result).toEqual({ passed: true });
    expect(octokit.paginate).not.toHaveBeenCalled();
  });
});

// ── checkUserMergedPRsInRepo ────────────────────────────────────────

describe('checkUserMergedPRsInRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCache.getIfFresh.mockReturnValue(null);
  });

  it('returns the count when the user has merged PRs', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 3, items: [] },
    });

    const result = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(result).toBe(3);
  });

  it('returns 0 when the user has no merged PRs', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    const result = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(result).toBe(0);
  });

  it('returns 0 and does NOT cache the result on API error', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Server error'),
    );

    const result = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(result).toBe(0);
    expect(mockCache.set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('returns 0 with warning on rate limit error', async () => {
    const octokit = makeOctokit();
    const rateLimitError = new Error('API rate limit exceeded');
    (rateLimitError as Record<string, unknown>).status = 403;
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitError);

    const result = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(result).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('caches successful results', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { total_count: 5, items: [] },
    });

    await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(mockCache.set).toHaveBeenCalledWith('merged-prs:owner/repo', '', 5);
  });

  it('returns cached value when available', async () => {
    const octokit = makeOctokit();
    mockCache.getIfFresh.mockReturnValue(7);

    const result = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(result).toBe(7);
    expect(octokit.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });

  it('records the search call even on failure', async () => {
    const octokit = makeOctokit();
    vi.mocked(octokit.search.issuesAndPullRequests as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('fail'),
    );

    await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(mockTracker.recordCall).toHaveBeenCalled();
  });
});

// ── analyzeRequirements ─────────────────────────────────────────────

describe('analyzeRequirements', () => {
  it('returns true for body with numbered steps and code blocks', () => {
    const body = `
## Steps to reproduce
1. Install the package
2. Run the command

\`\`\`bash
npm install && npm start
\`\`\`
    `.trim();

    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns true for body with "should", "expect", "must" keywords', () => {
    const body = `
The function should return a valid response.
Users expect consistent behavior when clicking the button.
This must be handled before the release.
Also here is some additional context to make the body longer than 200 characters.
We need to ensure that the error handling is robust and covers all edge cases properly.
    `.trim();

    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns true for body with > 200 chars and 2+ indicators', () => {
    const body = `
This is a detailed issue description that explains the problem thoroughly.
The application should handle this case gracefully. When a user submits the form
with invalid data, the error message is not displayed correctly.

Expected behavior: The form should show a validation error.

${'x'.repeat(100)}
    `.trim();

    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns false for a short vague body', () => {
    expect(analyzeRequirements('This is broken. Please fix it.')).toBe(false);
  });

  it('returns false for empty body', () => {
    expect(analyzeRequirements('')).toBe(false);
  });

  it('returns false for body with only 1 indicator', () => {
    // Only has code block, no other indicators, and short enough to not trigger length
    const body = `
Here is the error:
\`\`\`
Error: something went wrong
\`\`\`
    `.trim();

    expect(analyzeRequirements(body)).toBe(false);
  });

  it('returns false for null/undefined body', () => {
    expect(analyzeRequirements(null as unknown as string)).toBe(false);
    expect(analyzeRequirements(undefined as unknown as string)).toBe(false);
  });
});
