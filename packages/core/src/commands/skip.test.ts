import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "../core/schemas.js";
import type { SavedCandidate } from "../core/schemas.js";

// Mock local-state module
vi.mock("../core/local-state.js", () => {
  let mockState: any = { version: 1, skippedIssues: [], savedResults: [] };
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

const { runSkip, runSkipList, runSkipClear, runSkipRemove } =
  await import("./skip.js");

async function setMockState(state: any) {
  const mod = (await import("../core/local-state.js")) as any;
  mod._setMockState(state);
}

async function getMockState(): Promise<any> {
  const mod = (await import("../core/local-state.js")) as any;
  return mod._getMockState();
}

function makeSavedCandidate(
  overrides: Partial<SavedCandidate> = {},
): SavedCandidate {
  return {
    issueUrl: "https://github.com/owner/repo/issues/1",
    repo: "owner/repo",
    number: 1,
    title: "Fix the bug",
    labels: ["good first issue"],
    recommendation: "approve",
    viabilityScore: 75,
    searchPriority: "normal",
    firstSeenAt: "2026-03-01T00:00:00.000Z",
    lastSeenAt: "2026-03-01T00:00:00.000Z",
    lastScore: 75,
    ...overrides,
  };
}

describe("skip command", () => {
  beforeEach(async () => {
    const freshState = ScoutStateSchema.parse({ version: 1 });
    await setMockState(freshState);
  });

  describe("runSkip", () => {
    it("adds an issue to the skip list", async () => {
      const result = runSkip({
        issueUrl: "https://github.com/owner/repo/issues/1",
      });
      expect(result.skipped).toBe(true);
      expect(result.alreadySkipped).toBe(false);

      const state = await getMockState();
      expect(state.skippedIssues).toHaveLength(1);
      expect(state.skippedIssues[0].url).toBe(
        "https://github.com/owner/repo/issues/1",
      );
      expect(state.skippedIssues[0].repo).toBe("owner/repo");
      expect(state.skippedIssues[0].number).toBe(1);
    });

    it("deduplicates — same URL not added twice", async () => {
      const url = "https://github.com/owner/repo/issues/1";
      runSkip({ issueUrl: url });
      const result = runSkip({ issueUrl: url });

      expect(result.skipped).toBe(false);
      expect(result.alreadySkipped).toBe(true);

      const state = await getMockState();
      expect(state.skippedIssues).toHaveLength(1);
    });

    it("removes issue from saved results when skipping", async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      const url = "https://github.com/owner/repo/issues/1";
      state.savedResults = [makeSavedCandidate({ issueUrl: url })];
      await setMockState(state);

      runSkip({ issueUrl: url, state });

      const updated = await getMockState();
      expect(updated.savedResults).toHaveLength(0);
      expect(updated.skippedIssues).toHaveLength(1);
    });

    it("enriches metadata from saved results", async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      const url = "https://github.com/owner/repo/issues/42";
      state.savedResults = [
        makeSavedCandidate({
          issueUrl: url,
          repo: "owner/repo",
          number: 42,
          title: "Important bug",
        }),
      ];
      await setMockState(state);

      runSkip({ issueUrl: url, state });

      const updated = await getMockState();
      expect(updated.skippedIssues[0].repo).toBe("owner/repo");
      expect(updated.skippedIssues[0].number).toBe(42);
      expect(updated.skippedIssues[0].title).toBe("Important bug");
    });
  });

  describe("runSkipList", () => {
    it("returns empty array when no skipped issues", () => {
      const results = runSkipList();
      expect(results).toEqual([]);
    });

    it("returns skipped issues from state", async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      state.skippedIssues = [
        {
          url: "https://github.com/a/b/issues/1",
          repo: "a/b",
          number: 1,
          title: "Test",
          skippedAt: "2026-03-01T00:00:00.000Z",
        },
      ];
      await setMockState(state);

      const results = runSkipList();
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe("https://github.com/a/b/issues/1");
    });
  });

  describe("runSkipRemove", () => {
    it("removes a specific issue from the skip list", async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      const url = "https://github.com/a/b/issues/1";
      state.skippedIssues = [
        {
          url,
          repo: "a/b",
          number: 1,
          title: "Test",
          skippedAt: "2026-03-01T00:00:00.000Z",
        },
      ];
      await setMockState(state);

      const result = runSkipRemove({ issueUrl: url });
      expect(result.removed).toBe(true);

      const updated = await getMockState();
      expect(updated.skippedIssues).toHaveLength(0);
    });

    it("returns removed=false for unknown URL", () => {
      const result = runSkipRemove({
        issueUrl: "https://github.com/x/y/issues/999",
      });
      expect(result.removed).toBe(false);
    });
  });

  describe("runSkipClear", () => {
    it("clears all skipped issues", async () => {
      const state = ScoutStateSchema.parse({ version: 1 });
      state.skippedIssues = [
        {
          url: "https://github.com/a/b/issues/1",
          repo: "a/b",
          number: 1,
          title: "Test",
          skippedAt: "2026-03-01T00:00:00.000Z",
        },
        {
          url: "https://github.com/c/d/issues/2",
          repo: "c/d",
          number: 2,
          title: "Another",
          skippedAt: "2026-03-01T00:00:00.000Z",
        },
      ];
      await setMockState(state);

      runSkipClear();

      const updated = await getMockState();
      expect(updated.skippedIssues).toEqual([]);
    });

    it("is a no-op when already empty", async () => {
      runSkipClear();
      const updated = await getMockState();
      expect(updated.skippedIssues).toEqual([]);
    });
  });
});

describe("OssScout skip methods", () => {
  it("skipIssue adds to list and marks dirty", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    scout.skipIssue("https://github.com/a/b/issues/1", {
      repo: "a/b",
      number: 1,
      title: "Test",
    });

    expect(scout.getSkippedIssues()).toHaveLength(1);
    expect(scout.isDirty()).toBe(true);
  });

  it("skipIssue deduplicates", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    scout.skipIssue("https://github.com/a/b/issues/1");
    scout.skipIssue("https://github.com/a/b/issues/1");

    expect(scout.getSkippedIssues()).toHaveLength(1);
  });

  it("skipIssue removes from saved results", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    // Save a result first
    scout.saveResults([
      {
        issue: {
          id: 1,
          url: "https://github.com/a/b/issues/1",
          repo: "a/b",
          number: 1,
          title: "Test",
          status: "candidate" as const,
          labels: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
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
          repo: "a/b",
          lastCommitAt: "2026-03-01T00:00:00.000Z",
          daysSinceLastCommit: 1,
          openIssuesCount: 10,
          avgIssueResponseDays: 2,
          ciStatus: "passing" as const,
          isActive: true,
        },
        recommendation: "approve" as const,
        reasonsToSkip: [],
        reasonsToApprove: [],
        viabilityScore: 60,
        searchPriority: "normal" as const,
      },
    ]);
    expect(scout.getSavedResults()).toHaveLength(1);

    scout.skipIssue("https://github.com/a/b/issues/1");
    expect(scout.getSavedResults()).toHaveLength(0);
    expect(scout.getSkippedIssues()).toHaveLength(1);
  });

  it("unskipIssue removes specific issue", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    scout.skipIssue("https://github.com/a/b/issues/1");
    scout.skipIssue("https://github.com/c/d/issues/2");
    expect(scout.getSkippedIssues()).toHaveLength(2);

    scout.unskipIssue("https://github.com/a/b/issues/1");
    expect(scout.getSkippedIssues()).toHaveLength(1);
    expect(scout.getSkippedIssues()[0].url).toBe(
      "https://github.com/c/d/issues/2",
    );
  });

  it("clearSkippedIssues empties the list", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    scout.skipIssue("https://github.com/a/b/issues/1");
    scout.skipIssue("https://github.com/c/d/issues/2");
    expect(scout.getSkippedIssues()).toHaveLength(2);

    scout.clearSkippedIssues();
    expect(scout.getSkippedIssues()).toHaveLength(0);
  });

  it("cullExpiredSkips removes old entries and keeps recent ones", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    // Add an old skip (100 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    state.skippedIssues = [
      {
        url: "https://github.com/old/repo/issues/1",
        repo: "old/repo",
        number: 1,
        title: "Old issue",
        skippedAt: oldDate.toISOString(),
      },
    ];

    // Add a recent skip
    scout.skipIssue("https://github.com/new/repo/issues/2", {
      repo: "new/repo",
      number: 2,
      title: "New issue",
    });

    expect(scout.getSkippedIssues()).toHaveLength(2);

    const culled = scout.cullExpiredSkips(90);
    expect(culled).toBe(1);
    expect(scout.getSkippedIssues()).toHaveLength(1);
    expect(scout.getSkippedIssues()[0].url).toBe(
      "https://github.com/new/repo/issues/2",
    );
  });

  it("cullExpiredSkips returns 0 when nothing to cull", async () => {
    const { OssScout } = await import("../scout.js");
    const state = ScoutStateSchema.parse({ version: 1 });
    const scout = new OssScout("fake-token", state);

    scout.skipIssue("https://github.com/a/b/issues/1");
    const culled = scout.cullExpiredSkips(90);
    expect(culled).toBe(0);
  });
});
