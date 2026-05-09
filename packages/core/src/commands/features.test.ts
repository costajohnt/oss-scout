import { describe, it, expect, vi, beforeEach } from "vitest";
import { runFeatures } from "./features.js";
import { createScout } from "../scout.js";

vi.mock("../scout.js", () => ({
  createScout: vi.fn(),
}));

vi.mock("../core/utils.js", () => ({
  requireGitHubToken: () => "test-token",
}));

vi.mock("../core/local-state.js", () => ({
  saveLocalState: vi.fn(),
}));

describe("runFeatures", () => {
  let featuresFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    featuresFn = vi.fn().mockResolvedValue({
      quickWins: [],
      biggerBets: [],
      anchorRepos: [],
      message: "No anchor repos yet",
    });
    vi.mocked(createScout).mockResolvedValue({
      features: featuresFn,
      getState: () => ({}),
      saveResults: vi.fn(),
      checkpoint: vi.fn().mockResolvedValue(true),
      getRepoScoreRecord: vi.fn().mockReturnValue(undefined),
    } as never);
  });

  it("returns the features result envelope", async () => {
    const out = await runFeatures({ maxResults: 10 });
    expect(out.quickWins).toEqual([]);
    expect(out.biggerBets).toEqual([]);
    expect(out.message).toBe("No anchor repos yet");
  });

  it("forwards anchorThreshold and splitRatio to scout.features", async () => {
    await runFeatures({
      maxResults: 8,
      anchorThreshold: 4,
      splitRatio: 0.3,
    });
    expect(featuresFn).toHaveBeenCalledWith({
      count: 8,
      anchorThreshold: 4,
      splitRatio: 0.3,
    });
  });

  it("passes undefined overrides through unchanged", async () => {
    await runFeatures({ maxResults: 5 });
    expect(featuresFn).toHaveBeenCalledWith({
      count: 5,
      anchorThreshold: undefined,
      splitRatio: undefined,
    });
  });
});
