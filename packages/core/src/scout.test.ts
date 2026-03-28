import { describe, it, expect } from 'vitest';
import { createScout, OssScout } from './scout.js';
import { ScoutStateSchema } from './core/schemas.js';
import type { ScoutState } from './core/schemas.js';

function makeState(overrides: Partial<ScoutState> = {}): ScoutState {
  return ScoutStateSchema.parse({ version: 1, ...overrides });
}

describe('createScout', () => {
  it('creates instance with default state', async () => {
    const scout = await createScout({ githubToken: 'test-token' });
    expect(scout).toBeInstanceOf(OssScout);
    expect(scout.getState().version).toBe(1);
  });

  it('creates instance with provided state', async () => {
    const state = makeState({
      preferences: { githubUsername: 'testuser', languages: ['python'], labels: ['help wanted'], excludeRepos: [], aiPolicyBlocklist: [], preferredOrgs: [], projectCategories: [], minStars: 100, maxIssueAgeDays: 60, includeDocIssues: false, minRepoScoreThreshold: 5 },
    });
    const scout = await createScout({
      githubToken: 'test-token',
      persistence: 'provided',
      initialState: state,
    });
    expect(scout.getPreferences().githubUsername).toBe('testuser');
    expect(scout.getPreferences().languages).toEqual(['python']);
  });
});

describe('OssScout', () => {
  function makeScout(stateOverrides: Partial<ScoutState> = {}): OssScout {
    return new OssScout('test-token', makeState(stateOverrides));
  }

  describe('state reads', () => {
    it('returns empty arrays for fresh state', () => {
      const scout = makeScout();
      expect(scout.getReposWithMergedPRs()).toEqual([]);
      expect(scout.getStarredRepos()).toEqual([]);
      expect(scout.getPreferredOrgs()).toEqual([]);
    });

    it('returns preferences', () => {
      const scout = makeScout();
      const prefs = scout.getPreferences();
      expect(prefs.languages).toEqual(['typescript', 'javascript']);
    });

    it('returns null for unknown repo score', () => {
      const scout = makeScout();
      expect(scout.getRepoScore('unknown/repo')).toBeNull();
    });

    it('returns score for known repo', () => {
      const scout = makeScout({
        repoScores: {
          'owner/repo': {
            repo: 'owner/repo',
            score: 8,
            mergedPRCount: 3,
            closedWithoutMergeCount: 0,
            avgResponseDays: null,
            lastEvaluatedAt: '2025-01-01T00:00:00Z',
            signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
          },
        },
      });
      expect(scout.getRepoScore('owner/repo')).toBe(8);
    });
  });

  describe('recordMergedPR', () => {
    it('adds PR to state', () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Fix bug',
        mergedAt: '2025-01-01T00:00:00Z',
        repo: 'owner/repo',
      });
      expect(scout.getState().mergedPRs).toHaveLength(1);
      expect(scout.getReposWithMergedPRs()).toEqual(['owner/repo']);
      expect(scout.isDirty()).toBe(true);
    });

    it('deduplicates by URL', () => {
      const scout = makeScout();
      const pr = {
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Fix bug',
        mergedAt: '2025-01-01T00:00:00Z',
        repo: 'owner/repo',
      };
      scout.recordMergedPR(pr);
      scout.recordMergedPR(pr);
      expect(scout.getState().mergedPRs).toHaveLength(1);
    });

    it('updates repo score', () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Fix bug',
        mergedAt: '2025-01-01T00:00:00Z',
        repo: 'owner/repo',
      });
      const score = scout.getRepoScoreRecord('owner/repo');
      expect(score).toBeDefined();
      expect(score!.mergedPRCount).toBe(1);
      expect(score!.score).toBeGreaterThanOrEqual(1);
      expect(score!.score).toBeLessThanOrEqual(10);
    });
  });

  describe('recordClosedPR', () => {
    it('adds PR to state and updates score', () => {
      const scout = makeScout();
      scout.recordClosedPR({
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Rejected PR',
        closedAt: '2025-01-01T00:00:00Z',
        repo: 'owner/repo',
      });
      expect(scout.getState().closedPRs).toHaveLength(1);
      const score = scout.getRepoScoreRecord('owner/repo');
      expect(score!.closedWithoutMergeCount).toBe(1);
    });

    it('deduplicates by URL', () => {
      const scout = makeScout();
      const pr = {
        url: 'https://github.com/owner/repo/pull/1',
        title: 'Rejected',
        closedAt: '2025-01-01T00:00:00Z',
        repo: 'owner/repo',
      };
      scout.recordClosedPR(pr);
      scout.recordClosedPR(pr);
      expect(scout.getState().closedPRs).toHaveLength(1);
    });
  });

  describe('updatePreferences', () => {
    it('updates specific preferences', () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ['rust'], minStars: 200 });
      expect(scout.getPreferences().languages).toEqual(['rust']);
      expect(scout.getPreferences().minStars).toBe(200);
      expect(scout.isDirty()).toBe(true);
    });

    it('preserves other preferences', () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ['rust'] });
      expect(scout.getPreferences().labels).toEqual(['good first issue', 'help wanted']);
    });
  });

  describe('setStarredRepos', () => {
    it('updates starred repos with timestamp', () => {
      const scout = makeScout();
      scout.setStarredRepos(['owner/repo1', 'owner/repo2']);
      expect(scout.getStarredRepos()).toEqual(['owner/repo1', 'owner/repo2']);
      expect(scout.getState().starredReposLastFetched).toBeDefined();
    });
  });

  describe('checkpoint', () => {
    it('resets dirty flag', async () => {
      const scout = makeScout();
      scout.updatePreferences({ languages: ['go'] });
      expect(scout.isDirty()).toBe(true);
      await scout.checkpoint();
      expect(scout.isDirty()).toBe(false);
    });

    it('returns true when not dirty', async () => {
      const scout = makeScout();
      const result = await scout.checkpoint();
      expect(result).toBe(true);
    });
  });

  describe('getReposWithMergedPRs', () => {
    it('sorts by merge count descending', () => {
      const scout = makeScout();
      // Add 1 PR to repo-a
      scout.recordMergedPR({
        url: 'https://github.com/a/repo/pull/1',
        title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z', repo: 'a/repo',
      });
      // Add 2 PRs to repo-b
      scout.recordMergedPR({
        url: 'https://github.com/b/repo/pull/1',
        title: 'PR 1', mergedAt: '2025-01-01T00:00:00Z', repo: 'b/repo',
      });
      scout.recordMergedPR({
        url: 'https://github.com/b/repo/pull/2',
        title: 'PR 2', mergedAt: '2025-01-02T00:00:00Z', repo: 'b/repo',
      });
      expect(scout.getReposWithMergedPRs()).toEqual(['b/repo', 'a/repo']);
    });
  });

  describe('score calculation', () => {
    it('clamps score to 1-10 range', () => {
      const scout = makeScout();
      // Record many closed PRs to drive score down
      for (let i = 1; i <= 5; i++) {
        scout.recordClosedPR({
          url: `https://github.com/bad/repo/pull/${i}`,
          title: `Rejected ${i}`,
          closedAt: '2025-01-01T00:00:00Z',
          repo: 'bad/repo',
        });
      }
      const score = scout.getRepoScoreRecord('bad/repo');
      expect(score!.score).toBeGreaterThanOrEqual(1);
    });

    it('increases score for merged PRs', () => {
      const scout = makeScout();
      scout.recordMergedPR({
        url: 'https://github.com/good/repo/pull/1',
        title: 'PR', mergedAt: '2025-01-01T00:00:00Z', repo: 'good/repo',
      });
      const score = scout.getRepoScoreRecord('good/repo');
      expect(score!.score).toBeGreaterThan(5); // base is 5, merged adds
    });
  });
});
