import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SavedCandidate } from '../core/schemas.js';
import { ScoutStateSchema } from '../core/schemas.js';

// Mock local-state module — factory must not reference top-level imports
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

// Import after mock setup
const { runResults, runResultsClear } = await import('./results.js');

async function setMockState(state: any) {
  const mod = (await import('../core/local-state.js')) as any;
  mod._setMockState(state);
}

async function getMockState(): Promise<any> {
  const mod = (await import('../core/local-state.js')) as any;
  return mod._getMockState();
}

function makeSavedCandidate(overrides: Partial<SavedCandidate> = {}): SavedCandidate {
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

describe('results command', () => {
  beforeEach(async () => {
    const freshState = ScoutStateSchema.parse({ version: 1 });
    await setMockState(freshState);
  });

  describe('runResults', () => {
    it('returns empty array when no saved results', async () => {
      const results = await runResults({});
      expect(results).toEqual([]);
    });

    it('returns saved results from state', async () => {
      const candidate = makeSavedCandidate();
      const state = ScoutStateSchema.parse({ version: 1 });
      state.savedResults = [candidate];
      await setMockState(state);

      const results = await runResults({});
      expect(results).toHaveLength(1);
      expect(results[0].issueUrl).toBe('https://github.com/owner/repo/issues/1');
      expect(results[0].repo).toBe('owner/repo');
      expect(results[0].recommendation).toBe('approve');
    });

    it('returns multiple saved results', async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      state.savedResults = [
        makeSavedCandidate({ issueUrl: 'https://github.com/a/b/issues/1', repo: 'a/b', number: 1 }),
        makeSavedCandidate({
          issueUrl: 'https://github.com/c/d/issues/2',
          repo: 'c/d',
          number: 2,
          recommendation: 'skip',
        }),
      ];
      await setMockState(state);

      const results = await runResults({ json: true });
      expect(results).toHaveLength(2);
      expect(results[0].repo).toBe('a/b');
      expect(results[1].recommendation).toBe('skip');
    });
  });

  describe('runResultsClear', () => {
    it('clears saved results from state', async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      state.savedResults = [makeSavedCandidate()];
      await setMockState(state);

      await runResultsClear();

      const updated = await getMockState();
      expect(updated.savedResults).toEqual([]);
    });

    it('is a no-op when already empty', async () => {
      await runResultsClear();
      const updated = await getMockState();
      expect(updated.savedResults).toEqual([]);
    });
  });
});

describe('saveResults deduplication (via OssScout)', () => {
  it('preserves firstSeenAt on re-save and updates score', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout('fake-token', state);

    const makeCandidate = (score: number) => ({
      issue: {
        id: 1,
        url: 'https://github.com/owner/repo/issues/1',
        repo: 'owner/repo',
        number: 1,
        title: 'Fix the bug',
        status: 'candidate' as const,
        labels: ['good first issue'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        vetted: true,
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
        repo: 'owner/repo',
        lastCommitAt: '2026-03-01T00:00:00.000Z',
        daysSinceLastCommit: 1,
        openIssuesCount: 10,
        avgIssueResponseDays: 2,
        ciStatus: 'passing' as const,
        isActive: true,
      },
      recommendation: 'approve' as const,
      reasonsToSkip: [],
      reasonsToApprove: ['Active project'],
      viabilityScore: score,
      searchPriority: 'normal' as const,
    });

    // First save
    scout.saveResults([makeCandidate(70)]);
    const firstSave = scout.getSavedResults();
    expect(firstSave).toHaveLength(1);
    expect(firstSave[0].viabilityScore).toBe(70);
    expect(firstSave[0].lastScore).toBe(70);
    const originalFirstSeen = firstSave[0].firstSeenAt;

    // Second save with updated score
    scout.saveResults([makeCandidate(85)]);
    const secondSave = scout.getSavedResults();
    expect(secondSave).toHaveLength(1);
    expect(secondSave[0].viabilityScore).toBe(85);
    expect(secondSave[0].lastScore).toBe(85);
    expect(secondSave[0].firstSeenAt).toBe(originalFirstSeen);
  });

  it('adds new candidates alongside existing ones', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout('fake-token', state);

    const makeCandidate = (num: number) => ({
      issue: {
        id: num,
        url: `https://github.com/owner/repo/issues/${num}`,
        repo: 'owner/repo',
        number: num,
        title: `Issue ${num}`,
        status: 'candidate' as const,
        labels: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        vetted: false,
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
        repo: 'owner/repo',
        lastCommitAt: '2026-03-01T00:00:00.000Z',
        daysSinceLastCommit: 1,
        openIssuesCount: 10,
        avgIssueResponseDays: 2,
        ciStatus: 'passing' as const,
        isActive: true,
      },
      recommendation: 'approve' as const,
      reasonsToSkip: [],
      reasonsToApprove: [],
      viabilityScore: 60,
      searchPriority: 'normal' as const,
    });

    scout.saveResults([makeCandidate(1)]);
    expect(scout.getSavedResults()).toHaveLength(1);

    scout.saveResults([makeCandidate(2)]);
    expect(scout.getSavedResults()).toHaveLength(2);
  });

  it('clearResults removes all saved results', async () => {
    const { OssScout } = await import('../scout.js');
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout('fake-token', state);

    const candidate = {
      issue: {
        id: 1,
        url: 'https://github.com/owner/repo/issues/1',
        repo: 'owner/repo',
        number: 1,
        title: 'Fix the bug',
        status: 'candidate' as const,
        labels: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        vetted: false,
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
        repo: 'owner/repo',
        lastCommitAt: '2026-03-01T00:00:00.000Z',
        daysSinceLastCommit: 1,
        openIssuesCount: 10,
        avgIssueResponseDays: 2,
        ciStatus: 'passing' as const,
        isActive: true,
      },
      recommendation: 'approve' as const,
      reasonsToSkip: [],
      reasonsToApprove: [],
      viabilityScore: 60,
      searchPriority: 'normal' as const,
    };

    scout.saveResults([candidate]);
    expect(scout.getSavedResults()).toHaveLength(1);

    scout.clearResults();
    expect(scout.getSavedResults()).toEqual([]);
  });
});
