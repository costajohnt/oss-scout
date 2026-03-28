import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoutStateSchema } from '../core/schemas.js';
import type { SavedCandidate } from '../core/schemas.js';
import type { IssueCandidate } from '../core/types.js';

// Mock local-state module
vi.mock('../core/local-state.js', () => {
  let mockState: any = { version: 1, savedResults: [] };
  return {
    loadLocalState: () => mockState,
    saveLocalState: (state: any) => {
      mockState = state;
    },
    hasLocalState: () => true,
    _setMockState: (state: any) => {
      mockState = state;
    },
    _getMockState: () => mockState,
  };
});

async function setMockState(state: any) {
  const mod = (await import('../core/local-state.js')) as any;
  mod._setMockState(state);
}

function makeSavedCandidate(
  overrides: Partial<SavedCandidate> = {},
): SavedCandidate {
  return {
    issueUrl: 'https://github.com/owner/repo/issues/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Fix the bug',
    labels: ['good first issue'],
    recommendation: 'approve',
    viabilityScore: 75,
    searchPriority: 'normal',
    firstSeenAt: '2026-03-01T00:00:00.000Z',
    lastSeenAt: '2026-03-01T00:00:00.000Z',
    lastScore: 75,
    ...overrides,
  };
}

function makeIssueCandidate(
  overrides: {
    url?: string;
    noExistingPR?: boolean;
    notClaimed?: boolean;
    recommendation?: 'approve' | 'skip' | 'needs_review';
    viabilityScore?: number;
  } = {},
): IssueCandidate {
  return {
    issue: {
      id: 1,
      url: overrides.url ?? 'https://github.com/owner/repo/issues/1',
      repo: 'owner/repo',
      number: 1,
      title: 'Fix the bug',
      status: 'candidate',
      labels: ['good first issue'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      vetted: true,
      vettingResult: {
        passedAllChecks:
          (overrides.noExistingPR ?? true) && (overrides.notClaimed ?? true),
        checks: {
          noExistingPR: overrides.noExistingPR ?? true,
          notClaimed: overrides.notClaimed ?? true,
          projectActive: true,
          clearRequirements: true,
          contributionGuidelinesFound: true,
        },
        notes: [],
      },
    },
    vettingResult: {
      passedAllChecks:
        (overrides.noExistingPR ?? true) && (overrides.notClaimed ?? true),
      checks: {
        noExistingPR: overrides.noExistingPR ?? true,
        notClaimed: overrides.notClaimed ?? true,
        projectActive: true,
        clearRequirements: true,
        contributionGuidelinesFound: true,
      },
      notes: [],
    },
    projectHealth: {
      repo: 'owner/repo',
      lastCommitAt: '2026-03-01T00:00:00.000Z',
      daysSinceLastCommit: 1,
      openIssuesCount: 10,
      avgIssueResponseDays: 2,
      ciStatus: 'passing',
      isActive: true,
    },
    recommendation: overrides.recommendation ?? 'approve',
    reasonsToSkip: [],
    reasonsToApprove: ['Active project'],
    viabilityScore: overrides.viabilityScore ?? 75,
    searchPriority: 'normal',
  };
}

describe('vetList', () => {
  beforeEach(async () => {
    const freshState = ScoutStateSchema.parse({ version: 1 });
    await setMockState(freshState);
  });

  it('returns empty results when no saved results', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout('fake-token', state);

    const result = await scout.vetList();

    expect(result.results).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.summary.stillAvailable).toBe(0);
    expect(result.prunedCount).toBeUndefined();
  });

  it('classifies still_available issues correctly', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockResolvedValue(makeIssueCandidate());

    const result = await scout.vetList();

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('still_available');
    expect(result.results[0].recommendation).toBe('approve');
    expect(result.results[0].viabilityScore).toBe(75);
    expect(result.summary.stillAvailable).toBe(1);
  });

  it('classifies claimed issues correctly', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockResolvedValue(
      makeIssueCandidate({ notClaimed: false, recommendation: 'skip' }),
    );

    const result = await scout.vetList();

    expect(result.results[0].status).toBe('claimed');
    expect(result.summary.claimed).toBe(1);
  });

  it('classifies has_pr issues correctly', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockResolvedValue(
      makeIssueCandidate({ noExistingPR: false, recommendation: 'skip' }),
    );

    const result = await scout.vetList();

    expect(result.results[0].status).toBe('has_pr');
    expect(result.summary.hasPR).toBe(1);
  });

  it('classifies closed issues from 404 errors', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockRejectedValue(new Error('Not Found'));

    const result = await scout.vetList();

    expect(result.results[0].status).toBe('closed');
    expect(result.results[0].errorMessage).toBe('Not Found');
    expect(result.summary.closed).toBe(1);
  });

  it('classifies generic errors correctly', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockRejectedValue(new Error('Network timeout'));

    const result = await scout.vetList();

    expect(result.results[0].status).toBe('error');
    expect(result.results[0].errorMessage).toBe('Network timeout');
    expect(result.summary.errors).toBe(1);
  });

  it('computes summary counts correctly with mixed statuses', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/1',
        repo: 'a/b',
        number: 1,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/2',
        repo: 'a/b',
        number: 2,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/c/d/issues/3',
        repo: 'c/d',
        number: 3,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/e/f/issues/4',
        repo: 'e/f',
        number: 4,
      }),
    ];
    const scout = new OssScout('fake-token', state);

    let callCount = 0;
    vi.spyOn(scout, 'vetIssue').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeIssueCandidate(); // still_available
      if (callCount === 2)
        return makeIssueCandidate({ notClaimed: false }); // claimed
      if (callCount === 3) throw new Error('Not Found'); // closed
      return makeIssueCandidate({ noExistingPR: false }); // has_pr
    });

    const result = await scout.vetList();

    expect(result.summary.total).toBe(4);
    expect(result.summary.stillAvailable).toBe(1);
    expect(result.summary.claimed).toBe(1);
    expect(result.summary.closed).toBe(1);
    expect(result.summary.hasPR).toBe(1);
    expect(result.summary.errors).toBe(0);
  });

  it('prunes unavailable issues from savedResults', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/1',
        repo: 'a/b',
        number: 1,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/c/d/issues/2',
        repo: 'c/d',
        number: 2,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/e/f/issues/3',
        repo: 'e/f',
        number: 3,
      }),
    ];
    const scout = new OssScout('fake-token', state);

    let callCount = 0;
    vi.spyOn(scout, 'vetIssue').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeIssueCandidate(); // still_available
      if (callCount === 2)
        return makeIssueCandidate({ notClaimed: false }); // claimed
      throw new Error('Not Found'); // closed
    });

    const result = await scout.vetList({ prune: true });

    expect(result.prunedCount).toBe(2);
    expect(scout.getSavedResults()).toHaveLength(1);
    expect(scout.getSavedResults()[0].issueUrl).toBe(
      'https://github.com/a/b/issues/1',
    );
  });

  it('does not prune when prune option is false', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [makeSavedCandidate()];
    const scout = new OssScout('fake-token', state);

    vi.spyOn(scout, 'vetIssue').mockRejectedValue(new Error('Not Found'));

    const result = await scout.vetList({ prune: false });

    expect(result.prunedCount).toBeUndefined();
    expect(scout.getSavedResults()).toHaveLength(1);
  });

  it('respects concurrency option', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    state.savedResults = [
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/1',
        repo: 'a/b',
        number: 1,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/2',
        repo: 'a/b',
        number: 2,
      }),
      makeSavedCandidate({
        issueUrl: 'https://github.com/a/b/issues/3',
        repo: 'a/b',
        number: 3,
      }),
    ];
    const scout = new OssScout('fake-token', state);

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    vi.spyOn(scout, 'vetIssue').mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      currentConcurrent--;
      return makeIssueCandidate();
    });

    await scout.vetList({ concurrency: 2 });

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
