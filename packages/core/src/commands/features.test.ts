import { describe, it, expect, vi } from "vitest";
import { runFeatures } from "./features.js";

vi.mock("../scout.js", () => ({
  createScout: vi.fn().mockResolvedValue({
    features: vi.fn().mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: "No anchor repos yet",
    }),
    getState: () => ({}),
    saveResults: vi.fn(),
    checkpoint: vi.fn().mockResolvedValue(true),
    getRepoScoreRecord: vi.fn().mockReturnValue(undefined),
  }),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
}));

vi.mock("../core/local-state.js", () => ({
  saveLocalState: vi.fn(),
}));

describe("runFeatures", () => {
  it("returns the features result envelope", async () => {
    const out = await runFeatures({ maxResults: 10 });
    expect(out.quickWins).toEqual([]);
    expect(out.biggerBets).toEqual([]);
    expect(out.message).toBe("No anchor repos yet");
  });
});
