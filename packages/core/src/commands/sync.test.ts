import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScoutStateSchema } from "../core/schemas.js";
import type { ScoutState } from "../core/schemas.js";
import type { SyncResult } from "../core/types.js";

// Mock local-state module — factory must not reference top-level imports
vi.mock("../core/local-state.js", () => {
  let mockState: any = { version: 1 };
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

vi.mock("../core/utils.js", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    requireGitHubToken: () => "fake-token",
    getGitHubToken: () => "fake-token",
  };
});

// Fake scout standing in for the CLI's provided-mode scout: checkpoint() is a
// no-op that reports success, exactly like the real thing (#275).
const syncResult: SyncResult = {
  checked: 2,
  merged: 1,
  closed: 0,
  stillOpen: 1,
  errors: 0,
};
let scoutState: ScoutState;
const fakeScout = {
  syncOpenPRs: vi.fn(async () => {
    scoutState.lastSearchAt = "2026-08-07T00:00:00.000Z";
    return syncResult;
  }),
  getState: () => scoutState,
  checkpoint: vi.fn(async () => true),
};

vi.mock("./command-scout.js", () => ({
  buildCommandScout: async () => fakeScout,
}));

const { runSync } = await import("./sync.js");

async function getMockState(): Promise<any> {
  const mod = (await import("../core/local-state.js")) as any;
  return mod._getMockState();
}

async function setMockState(state: any) {
  const mod = (await import("../core/local-state.js")) as any;
  mod._setMockState(state);
}

describe("runSync", () => {
  beforeEach(async () => {
    scoutState = ScoutStateSchema.parse({ version: 1 });
    await setMockState(ScoutStateSchema.parse({ version: 1 }));
    vi.clearAllMocks();
  });

  it("returns the sync result", async () => {
    const result = await runSync();
    expect(result).toEqual(syncResult);
    expect(fakeScout.syncOpenPRs).toHaveBeenCalledOnce();
  });

  it("persists the scout's updated state to the local file (#275)", async () => {
    // Regression: in the CLI's non-gist mode the scout is provided-mode, whose
    // checkpoint() is a no-op returning true. Unless runSync asks withScout to
    // persist, sync reports success while ~/.oss-scout/state.json is unchanged.
    await runSync();
    const persisted = await getMockState();
    expect(persisted.lastSearchAt).toBe("2026-08-07T00:00:00.000Z");
  });

  it("still checkpoints for gist-mode scouts", async () => {
    await runSync();
    expect(fakeScout.checkpoint).toHaveBeenCalled();
  });
});
